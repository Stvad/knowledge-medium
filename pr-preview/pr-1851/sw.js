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
		buildId: "b24e5158d72c-231f3100",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1851/\":\"95b6fa54a1d0534e\",\"/knowledge-medium/pr-preview/pr-1851/index.html\":\"95b6fa54a1d0534e\",\"/knowledge-medium/pr-preview/pr-1851/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1851/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1851/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1851/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1851/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1851/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1851/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1851/assets/FacadeVFS-CS5dr1Yw.js\":\"c65f8a2de429d7d1\",\"/knowledge-medium/pr-preview/pr-1851/assets/OPFSCoopSyncVFS-Dn5DHfmL.js\":\"e99d8e970bee80bf\",\"/knowledge-medium/pr-preview/pr-1851/assets/OPFSWriteAheadVFS-CMQv3Ngr.js\":\"bdc8f8adb45a3611\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-async-Bl-R4dgZ.js\":\"999ec17e51ca8a71\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-gIgYloap.js\":\"9711ac7ca8cf1188\",\"/knowledge-medium/pr-preview/pr-1851/assets/worker-D025s6JH.js\":\"9cae06fd5278338e\",\"/knowledge-medium/pr-preview/pr-1851/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1851/chunks/app-CFXmVGzj.js\":\"86273c3f3d0ce238\",\"/knowledge-medium/pr-preview/pr-1851/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1851/index.js\":\"932cac79240acc2c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1851/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1851/assets/AccessHandlePoolVFS-5jaDjR7p.js\":\"5bdcea6538c7cfa6\",\"/knowledge-medium/pr-preview/pr-1851/assets/IDBBatchAtomicVFS-D5xFNtNM.js\":\"b6d2713eddd49917\",\"/knowledge-medium/pr-preview/pr-1851/assets/MemoryVFS-BYjbHx-D.js\":\"4e0e11e4f10ebfea\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-4L7iDVXU.js\":\"3655f7b3aed52c73\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-async-D45LCetA.js\":\"e153226145345672\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1851/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1851/chunks/AccessHandlePoolVFS-Bk7-Bi2a.js\":\"ec260cc7a1990e48\",\"/knowledge-medium/pr-preview/pr-1851/chunks/FacadeVFS-D2WpOp22.js\":\"ab7b945f04ffa13d\",\"/knowledge-medium/pr-preview/pr-1851/chunks/IDBBatchAtomicVFS-B22bjWHd.js\":\"fc6759c1e02b5f8d\",\"/knowledge-medium/pr-preview/pr-1851/chunks/MemoryVFS-tSBwRuRw.js\":\"d40a917478e203c0\",\"/knowledge-medium/pr-preview/pr-1851/chunks/OPFSCoopSyncVFS-DUILYW7L.js\":\"1851107074e0d897\",\"/knowledge-medium/pr-preview/pr-1851/chunks/OPFSWriteAheadVFS-Bb7pBYWg.js\":\"74cb397835d1b8c2\",\"/knowledge-medium/pr-preview/pr-1851/chunks/Preview-DItKOaTP.js\":\"2460a2e0049e56d7\",\"/knowledge-medium/pr-preview/pr-1851/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1851/chunks/card-CLCwBElL.js\":\"81888fb8c31760f9\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dist-C5Ew3noJ.js\":\"217d2b65d1b764bb\",\"/knowledge-medium/pr-preview/pr-1851/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1851/chunks/mc-wa-sqlite-BuW3f1zY.js\":\"201c1902a999e2b9\",\"/knowledge-medium/pr-preview/pr-1851/chunks/mc-wa-sqlite-async-B-IFH9sE.js\":\"cf91aee1f9729a82\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-B4pLMLc4.js\":\"3b16ff42b3ded31d\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-BJ0OYf4Q.js\":\"5ea907171e5abe4c\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-ByYx-rI-.js\":\"cba6454224b57a7b\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-CDf1kRvF.js\":\"a2a072658dd40f7b\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-CyuNq3ir.js\":\"ec42e608ae84d5e5\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-D9bGONVh.js\":\"dd99eaf3202b1ea9\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-DAl0Vt4Y.js\":\"d35d7dd3902ca3e8\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-DLNl0vw-.js\":\"ec424189045a5f20\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-dom-server-legacy.browser.production-xEOYoNjp.js\":\"2c2714e6fbef1d3e\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-dom-server.browser.production-CGCB1-x7.js\":\"2ae33af41023b36b\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-dom-server.edge.production-Dxe1rkS4.js\":\"04d27f97f2b6b6cd\",\"/knowledge-medium/pr-preview/pr-1851/chunks/server.browser-Dvurvk0B.js\":\"107dc374e8627724\",\"/knowledge-medium/pr-preview/pr-1851/chunks/textarea-r8oB8o_i.js\":\"3e8b61285a775dc0\",\"/knowledge-medium/pr-preview/pr-1851/chunks/ui-Bwgc1n2a.js\":\"629cedc3f97a7077\",\"/knowledge-medium/pr-preview/pr-1851/chunks/wa-sqlite-async-SJ1NCB7m.js\":\"44d95c6aa914a961\",\"/knowledge-medium/pr-preview/pr-1851/chunks/wa-sqlite-cL8wrYyS.js\":\"e2dfb3d10b8933b8\",\"/knowledge-medium/pr-preview/pr-1851/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1851/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1851/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1851/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1851/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1851/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1851/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1851/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1851/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1851/src/App.js\":\"3b54e71397cae894\",\"/knowledge-medium/pr-preview/pr-1851/src/appUpdate.js\":\"1bc26ec5c88100b8\",\"/knowledge-medium/pr-preview/pr-1851/src/appVersion.js\":\"0b2e9564e10b5ac5\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/initialLayout.js\":\"19b3cf43501158cc\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/openWorkspaceData.js\":\"9eb1bcff825ae1b7\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/resolveWorkspace.js\":\"0c17ee8039d27a9f\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/workspaceBootstrap.js\":\"1a05f3ef4e56ac46\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockComponent.js\":\"20c2d27f68403314\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockCrumbs.js\":\"41fa217f749b1ee6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockEditor.js\":\"4c4c4a432f9e7680\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockLoadingPlaceholder.js\":\"be9ce2b476c42763\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockProperties.js\":\"38d4ac3c56b34dea\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockSearchPicker.js\":\"2aa8612603920935\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ConfirmBulkDeleteDialog.js\":\"1e0df6c42c75b9fd\",\"/knowledge-medium/pr-preview/pr-1851/src/components/DividerHandle.js\":\"4111fa8e849936fa\",\"/knowledge-medium/pr-preview/pr-1851/src/components/DraftEditor.js\":\"559294fc14645f71\",\"/knowledge-medium/pr-preview/pr-1851/src/components/GutterPill.js\":\"609686e387659f14\",\"/knowledge-medium/pr-preview/pr-1851/src/components/Header.js\":\"3ac2d756647ded2c\",\"/knowledge-medium/pr-preview/pr-1851/src/components/LazyBlockComponent.js\":\"b8dec33d95677979\",\"/knowledge-medium/pr-preview/pr-1851/src/components/Login.js\":\"41c89ee632f1b60e\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ZoomableSurface.js\":\"6a7cb93911c1fd08\",\"/knowledge-medium/pr-preview/pr-1851/src/components/editModeKeepalive.js\":\"38dceb177839491d\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyDisplay/PropertyDisplayScope.js\":\"710a7397348ecd83\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bcf3f4831e218738\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/RefPropertyEditor.js\":\"5e29d0245513f6cd\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/RefTargetTypePicker.js\":\"197c5aa4d562d99b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/SelectPropertyEditor.js\":\"abf99f53fa8c9d15\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/TypesPropertyEditor.js\":\"88b744e7fbd3eaf0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/defaults.js\":\"8f5881b3fbe84b87\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/kernelValuePresets.js\":\"22c03f944487c8cb\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/selectablePresets.js\":\"f9cc02bff1fa0c18\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/typesPropertyUi.js\":\"995413c1c8249224\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/AddPropertyForm.js\":\"ceae52436397d4ef\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/PropertyPicker.js\":\"5898ba612f4ac9f4\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/PropertyRow.js\":\"f6383bc4bf97ee89\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/Rows.js\":\"d04fe590d7b00719\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/actions.js\":\"787280b3a7e41740\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/declarationOnly.js\":\"90906e4e55bdbb71\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/layout.js\":\"b5707362c59221b2\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/model.js\":\"08a42802493dea30\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/shapeUi.js\":\"40c5a83d9bc6282f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/shapes.js\":\"2368ea38799f57cf\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/usePropertyEditingActivation.js\":\"28c4d316e10603c5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/visibility.js\":\"224365579cb3060b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanelSections.js\":\"09f6a4cc7b20dc58\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/BlockEmbed.js\":\"bce725f1c64da467\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/BlockLink.js\":\"ad7b9d2e08ac94c6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/BlockRef.js\":\"ebd9bbe413dc3d7a\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/ReferenceLink.js\":\"ac5c904749e502fa\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/cycleGuard.js\":\"be407966281b1528\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/cycleGuardContext.js\":\"ea7354bc30715073\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/linkInteraction.js\":\"b775377eaf7523fd\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/referenceLayout.js\":\"bbaa641cf0106723\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/useBlockRefAncestors.js\":\"55f6ee13cc47a664\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BlockGutter.js\":\"af208cf6e972e793\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BlockInfoDialog.js\":\"fe8b9eba7ed298fe\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BlockTypeBlockRenderer.js\":\"626ebfda3bdc1a10\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BulletHoverCard.js\":\"85acbb68de7a6bfb\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/CodeMirrorContentRenderer.js\":\"a2a2c8d61f375d62\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"249ad077737dcf68\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/ColumnResizeHandles.js\":\"225ccffe545c72c7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b593980a03301ec2\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/DefaultBlockRenderer.js\":\"308f7a4d9fef54b5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/LayoutRenderer.js\":\"7723fbd81cd692df\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/MarkdownContentRenderer.js\":\"041adf89a82c269a\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/MissingDataRenderer.js\":\"d934fab680dedc1e\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/PanelRenderer.js\":\"0cdf0261cdf26f54\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/PropertySchemaBlockRenderer.js\":\"98225b4002ba98c1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/TopLevelRenderer.js\":\"5f68a74fd691e2d6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/blockGutterMode.js\":\"adcd464d96d09b59\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/blockTitleText.js\":\"e1df24d291fdf0b0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/fieldCreationKeydown.js\":\"22c1d711b9145376\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/layoutRootContext.js\":\"5c35d181f45efc14\",\"/knowledge-medium/pr-preview/pr-1851/src/components/typeChip/TypeChip.js\":\"1075b0b19ed82fa7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/typeChip/chipStyle.js\":\"c1a940c7f09554d1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/anchored-floating.js\":\"052cd2a023bf6e38\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/button.js\":\"833be4c645a1e45e\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/card.js\":\"61eea5526a237987\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/checkbox.js\":\"4e577012da1b3ea7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/collapsible.js\":\"6fc7b506de25d0ae\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/command.js\":\"160ee2470370cfb5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/context-menu.js\":\"562dd10d08623204\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/dialog.js\":\"3b28c96294a953e4\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/dropdown-menu.js\":\"a570d31b75905f6b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/floating-listbox.js\":\"2724bc5db3fa17ce\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/index.js\":\"acc9ed0f03c711ac\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/input.js\":\"80072269e61bdf25\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/kbd.js\":\"8677dfdc59a6db89\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/label.js\":\"43d1ea7744e88698\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/textarea.js\":\"12e5a14a5db1df85\",\"/knowledge-medium/pr-preview/pr-1851/src/components/useEditModeYieldKeepalive.js\":\"53cd7fc0193138a6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/BootFallback.js\":\"fe209fb7de8d6449\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/FocusedRowLazyMount.js\":\"29ec88ad8de403d8\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/LazyViewportMount.js\":\"fa3775512eb3580f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/LocalDbCorruptionFallback.js\":\"f8bea783b598134f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/error.js\":\"34c8f41c803f3485\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/lazyMountRegistry.js\":\"b7da5a1cb5bcb34b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/suspense.js\":\"7aaf6edd1ecbf5ec\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/CreateWorkspaceDialog.js\":\"57665b69a36eb344\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/PendingInvitations.js\":\"874f9550a5efada0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/SyncProgress.js\":\"c031bd45577a2866\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/UnlockProgress.js\":\"9f0d4dbdb36772a4\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceKeyGate.js\":\"987ef17b66da7015\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceSettingsDialog.js\":\"dd1847305b347993\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceSwitcher.js\":\"09707121afacc92b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceSyncGate.js\":\"267d9377846a27be\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/ConversionFlow.js\":\"e57978d032607e17\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/ConversionFlowHost.js\":\"9af3c7b3ea37a90a\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/EncryptionSection.js\":\"64a4a3bbae764904\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/attachmentPrompts.js\":\"786fa13d5e475dd8\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d145ced62ab69d20\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/conversionFlowDeps.js\":\"c546744a78cdeff8\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/conversionFlowStore.js\":\"01e1c39e91636673\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/flowUi.js\":\"1fd29015018b2c96\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/useConversionRun.js\":\"9d3459570d8458cf\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/keyUi.js\":\"a3f1cd5aa39b56fb\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/useCloseOnKeyLoss.js\":\"c621ce375ba908c5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/useCloseOnServerE2ee.js\":\"a5f45f6b82c08d78\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/workspaceUnlocked.js\":\"ed153564783ed8ab\",\"/knowledge-medium/pr-preview/pr-1851/src/context/backgroundSubtree.js\":\"31a71f15ee95778c\",\"/knowledge-medium/pr-preview/pr-1851/src/context/block.js\":\"85590bada0cf1447\",\"/knowledge-medium/pr-preview/pr-1851/src/context/layoutWsContext.js\":\"f2bc3f97dba21a76\",\"/knowledge-medium/pr-preview/pr-1851/src/context/propertyDisplay.js\":\"1a574608020c3c0d\",\"/knowledge-medium/pr-preview/pr-1851/src/context/repo.js\":\"b49e91610a359f8f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/aliasClaim.js\":\"1d9158161a52e526\",\"/knowledge-medium/pr-preview/pr-1851/src/data/aliasSeatNamespace.js\":\"ea8053b3ec631e61\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/blockData.js\":\"e656170eb2685a83\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/blockType.js\":\"eb0135754ddcc067\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/changeScope.js\":\"4c070ebc360f6aff\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/codecs.js\":\"ca0b9873c9cf009e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/derivedData.js\":\"e131df3d9d4811de\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/errors.js\":\"f06d2326c4922390\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/events.js\":\"7f1882aaa28a32b9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/handle.js\":\"7a41f528078ac70a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/index.js\":\"c5bab9c281379e42\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/mutator.js\":\"cdf5e1835be898ee\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/processor.js\":\"71e2801a611134a3\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/propertySchema.js\":\"bfb667982b08a162\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/query.js\":\"aae72730a9d97b96\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/sameTxProcessor.js\":\"426f2ba2f0c06d07\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/schema.js\":\"7a41f528078ac70a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/tx.js\":\"7a41f528078ac70a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/typedBlockQuery.js\":\"1e92ed42afeb4344\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/user.js\":\"6625e57d78489cfb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/valuePresetCore.js\":\"76fdcc55295cda54\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/valuePresets.js\":\"abcead413860ba87\",\"/knowledge-medium/pr-preview/pr-1851/src/data/attachmentCleanerIOVerb.js\":\"ea57067717926b7d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/block.js\":\"c01333d34d213122\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockCache.js\":\"0baa8fd1dbabd5b7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockId.js\":\"a1e84bea020fd0ad\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockLiveness.js\":\"bf44b18c9dc7f622\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockMerge.js\":\"0e969c2b0db0470f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockSchema.js\":\"e0d5482a5dfbce87\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockTypeLookup.js\":\"6aa76365bf43c602\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockTypes.js\":\"ed56848831db74a0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/clientContext.js\":\"044294f160000fde\",\"/knowledge-medium/pr-preview/pr-1851/src/data/dbFileSiblings.js\":\"7e577677811d7b71\",\"/knowledge-medium/pr-preview/pr-1851/src/data/definitionSeeds.js\":\"ad70fc715bf9b43f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/derivedIds.js\":\"6910870129de3cd0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/drawnSubtree.js\":\"7432f9b1b86bf91e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/facetBridge.js\":\"5b0d01312b90f67f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/facets.js\":\"cdceb0b737ce0a33\",\"/knowledge-medium/pr-preview/pr-1851/src/data/globalState.js\":\"a967d0a0679af7ef\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/aliasClaimRederiveProcessor.js\":\"3ad1251253df1888\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/ancestorBatch.js\":\"0a47a7e82d26b5c2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/blockTypeTypeifyProcessor.js\":\"d4f691fd9e98b764\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/clientSchema.js\":\"fc1849de11aa254d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/commitPipeline.js\":\"279fc397ecb3a61c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/devAssertions.js\":\"463d42861e8e51e4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/firstSync.js\":\"c85c1a9f3aa3fdbb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/freshInitialLoad.js\":\"e1e1be490d93fef2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/graphBackfillClaim.js\":\"3da2fa2ec75aeccd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/handleStore.js\":\"16d2e1b84a140f44\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/idleMarkerJobs.js\":\"cddd66f24b69c386\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/initialDownload.js\":\"47ef2c7026ff0711\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/initializeClientDatabase.js\":\"fcf91dab3101a72d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/jsonCanonical.js\":\"7c2d1755fc8911b2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/kernelInvalidation.js\":\"a872d67876b6567a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/kernelProcessors.js\":\"1a79dfa8950a315c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/kernelQueries.js\":\"eac7de04ec5ec7b7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/mergeTypeMembershipProcessor.js\":\"f4f73ffe2e62c228\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/normalizeReferencesProcessor.js\":\"5e34a23d3f148be1\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/poolInstrumentation.js\":\"3a1ef490457984b0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/processorRunner.js\":\"2491b0d0490bcedd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyCellBackfill.js\":\"dda64fc11f29a20c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyChildMint.js\":\"f8a300d8210d2980\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyChildrenProcessor.js\":\"c7651cd2251fddd1\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyDefinitionChangeProcessor.js\":\"88f72a430f6f7dbd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyDefinitionSynthesis.js\":\"c56a50aa14308112\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyKeyScan.js\":\"7caad5a7348e7fde\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertySchemaResolution.js\":\"843b82e6070eb83e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyValueEdits.js\":\"88c52805fbfe2501\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/raiseProtocol.js\":\"d4e62e82bb472b0b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/readBatch.js\":\"8cdac5aa436ad850\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/refProjection.js\":\"705180e4927838c2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/referenceTargetLookups.js\":\"2c77fa029cecd4d0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/referenceTargetProcessor.js\":\"10bb889a5c645f26\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/replayMerge.js\":\"fe6123164c9176a8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/sqlBinds.js\":\"86b270a8e9b7789b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a6c35de21441d320\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/arrivalProcessors.js\":\"a95b434f2439626c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/invalidate.js\":\"387889922eb53d50\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/materialize.js\":\"83062e95511620d0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/observer.js\":\"79882d0f7e197edf\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/reconcile.js\":\"bfd76d6afd2cfb5c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/timingMetrics.js\":\"d6fc5afde738fd4e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/treeQueries.js\":\"4f08f7ecc2360dc6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/txEngine.js\":\"ab01b98effa5adf0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/txSnapshots.js\":\"c2d7c73b5615a8bd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/typedBlockQuery.js\":\"41ed841b99218f12\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/undoManager.js\":\"61178b6539d27b60\",\"/knowledge-medium/pr-preview/pr-1851/src/data/invalidation.js\":\"59bbfdcaddb2435d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/kernelDataExtension.js\":\"d4caa7b86b903462\",\"/knowledge-medium/pr-preview/pr-1851/src/data/kernelPage.js\":\"3176e3d8e40810b8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/kernelValuePresetCores.js\":\"9ecffc9e427a55ed\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localDbCorruptionSignal.js\":\"a3405dc54a228790\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localDbStorage.js\":\"16991cf1940ccff3\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localDbVfs.js\":\"c730d8ca4632cbe6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localSchema.js\":\"88dc4403bcec58d5\",\"/knowledge-medium/pr-preview/pr-1851/src/data/maintenance.js\":\"68586ac8243e66ca\",\"/knowledge-medium/pr-preview/pr-1851/src/data/mergeProperties.js\":\"0088064f63e5ff2b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/metricsConsoleHook.js\":\"0daa4f4975e8a3ac\",\"/knowledge-medium/pr-preview/pr-1851/src/data/migrationsPage.js\":\"639094b460e6accc\",\"/knowledge-medium/pr-preview/pr-1851/src/data/mutators.js\":\"e5258b189b3df1c8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/orderKey.js\":\"f5df5e08124cca7e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/orderKeyPlacement.js\":\"34c1dc7747f150ee\",\"/knowledge-medium/pr-preview/pr-1851/src/data/outlineSurface.js\":\"0f1d958ba421ac5b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/pendingEditorContent.js\":\"761d14f9a223b8c9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/pendingUploadsSql.js\":\"63a4b52843a59db0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/pluginStateExtensions.js\":\"2a8a193a082f21a4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/powerSyncLogger.js\":\"1475ecbfe101b469\",\"/knowledge-medium/pr-preview/pr-1851/src/data/projectorRuntime.js\":\"e3ea25588492f9a8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/properties.js\":\"d3e6d3ec142e87a9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertiesPage.js\":\"11608774764192db\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyChildren.js\":\"2e93a01fd15a6c5b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDefinitionFanout.js\":\"9373c0172b9c4b8a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDefinitionMetadata.js\":\"eb711d79f2251d7b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDefinitionRegistry.js\":\"582b37c1f8f95153\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDisplayMode.js\":\"b9c2825392d69172\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyRowCreation.js\":\"7cfc44278a98c565\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertySchemaCreation.js\":\"a7fb560b1eac085e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertySeeds.js\":\"43d34ad8a81531c4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/recentsPage.js\":\"ea0f5df6049b4927\",\"/knowledge-medium/pr-preview/pr-1851/src/data/referenceBlock.js\":\"ff38e2cede0a4894\",\"/knowledge-medium/pr-preview/pr-1851/src/data/rejectedUploads.js\":\"0244ba8bfa0278c2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/releasePowerSyncConnection.js\":\"cc38119d72904c3d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/repo.js\":\"e2adb4f8eb6d5c10\",\"/knowledge-medium/pr-preview/pr-1851/src/data/repoProvider.js\":\"83627b49b9650c71\",\"/knowledge-medium/pr-preview/pr-1851/src/data/rowProperty.js\":\"87e6e022bf458a37\",\"/knowledge-medium/pr-preview/pr-1851/src/data/searchFilter.js\":\"23b948876f70cafa\",\"/knowledge-medium/pr-preview/pr-1851/src/data/seedIdentityLedger.js\":\"d69a2c24c55e7996\",\"/knowledge-medium/pr-preview/pr-1851/src/data/stateBlocks.js\":\"fd5722071ca0e971\",\"/knowledge-medium/pr-preview/pr-1851/src/data/structuralEditPolicy.js\":\"eadf30ce2a8f5e3d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/subtreeDelete.js\":\"f347adfa1f22f954\",\"/knowledge-medium/pr-preview/pr-1851/src/data/syncStreamLock.js\":\"d701d1407bcc0ac0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/syncedTableSqlRecognizer.js\":\"288eb470e19d86c6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/syncedTableWriteGuard.js\":\"12a523232a0083a2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/targets.js\":\"4835d30eb2fac085\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeColors.js\":\"cc5de62f1d5d8326\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeDefinitionMetadata.js\":\"67401305e8a9309d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeDefinitionRegistry.js\":\"c549ba31c6f6fc3d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeExtraction.js\":\"d40b2ae546107afd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeInitialValues.js\":\"c42428b435435e6c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typePropertyGroups.js\":\"31fc511f386751d0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeSeeds.js\":\"1f8e6089656feefd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeTagger.js\":\"917d3a96f48da2e2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typedRecords.js\":\"c379876dd1c3d4ae\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typesPage.js\":\"88c6c0c2c4fad72a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/userPrefs.js\":\"d89d268a927513e3\",\"/knowledge-medium/pr-preview/pr-1851/src/data/userSchemasService.js\":\"17db420aec97452d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/userTypesService.js\":\"e20005892eacc073\",\"/knowledge-medium/pr-preview/pr-1851/src/data/valuePresetRegistry.js\":\"08cbf0960417df39\",\"/knowledge-medium/pr-preview/pr-1851/src/data/visibleChildren.js\":\"d5b440fb5d8f50fb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceConversion.js\":\"af3ef968054cc605\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceFirstSync.js\":\"6ea6c9e9b677e25d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceIdNamespace.js\":\"218257dd9db3463f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceSchema.js\":\"b9baf90657ebe960\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaces.js\":\"202dbb932bdeeec0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/writeAheadLog.js\":\"cbbd8d058f0048c5\",\"/knowledge-medium/pr-preview/pr-1851/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/BlockPasteShellDecorator.js\":\"73a7ab4d02f8ccb2\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/atTrigger.js\":\"2f8d09dbd965352f\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/autocomplete.js\":\"bc83056bb77afb92\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/codeMirrorExtensions.js\":\"da2c53934056effb\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/contentFlush.js\":\"b699dd4073cbc8df\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/defaultInteractions.js\":\"376868bd694d48d8\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/editSettleSignal.js\":\"12b33f50a5421ebf\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/insertImage.js\":\"87e8d503d00d525c\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/referenceCompletionRange.js\":\"8e26f3e0c9061a24\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/referenceTargetTypes.js\":\"58b616e5b871b548\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/syntaxContext.js\":\"bd2ff24a0cbc769e\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/triggerMatch.js\":\"6e77565ff991688f\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/AppRuntimeProvider.js\":\"1cd751550194210f\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/BlockFocusShellDecorator.js\":\"abb0a37bb9ddb195\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/ExtensionRenderBoundary.js\":\"0393cc04f57bb7af\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/PanelContentRecovery.js\":\"d92dc44d78c6ea5c\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/apiCatalog.js\":\"e022115bb0d73a75\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/approveExtensionHere.js\":\"d3d0106f4e4d5725\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/armedCutAppMount.js\":\"70dea643496eb7a4\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/batchableKeyedStore.js\":\"851d9ce68bdaec0d\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/blockInteraction.js\":\"5bd25a4af947f9ea\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/blockSelectionAction.js\":\"01db2f691c560914\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/compileExtensionModule.js\":\"29a51ac9d18d5ca6\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/compiledModuleCache.js\":\"03dd49540cc17e74\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/continuousGestures.js\":\"3f43395ce6cc18cc\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/core.js\":\"5a28db6ea779ee85\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/defaultRenderers.js\":\"70de96cbba9dc18c\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/definitionFanoutAppMount.js\":\"32e7d9341cc66972\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/dialogAppMount.js\":\"2c8d83cd56fb5dd5\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/dynamicExtensionSeeds.js\":\"75f1cadc752481fe\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/dynamicExtensions.js\":\"a0eb378247aafff3\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/exampleExtensions.js\":\"cac3f071f022ec4d\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionApprovalStatus.js\":\"07e57df759e412b5\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionLoadErrorToast.js\":\"94caadad50be8970\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionLoadErrors.js\":\"7626a61706bd1197\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionLookup.js\":\"4180903800eca384\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionToggles.js\":\"0c5c82cb9fa410e7\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionUtilitiesCss.js\":\"6da60a73532a00a3\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/kernelPageDeletionGuard.js\":\"73c8a872066fa328\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/liveRuntime.js\":\"03003ed8c7325dd8\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/openExtensionsSettings.js\":\"8b14eaf3da7d8b86\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/overridesCache.js\":\"f4373b19418b59c7\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/pluginIds.js\":\"35d49ac9f9ab8ea6\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/processorRejectionToast.js\":\"10d77fb0363b1174\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/runtimeActions.js\":\"de66c59f1e197994\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/runtimeContext.js\":\"98c73b2d43dd153b\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/staticAppExtensions.js\":\"9e111510a8ee9abf\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/staticDataExtensions.js\":\"559a20a89f0b9430\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/toastAppMount.js\":\"9660a97e6f9177e0\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/useOverrides.js\":\"7bbc2a9951a9f37e\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/useShortcutSurfaceActivations.js\":\"89b595d3c6d665d6\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/discoverToggleTree.js\":\"e5301c6304536d6d\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/facet.js\":\"a9448d2c6cfd5fc0\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/resolveAppRuntime.js\":\"1259631f931428c0\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/runtimeEvents.js\":\"1980777f8703fa00\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/togglable.js\":\"9f85841ec99b85b9\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/variantFacet.js\":\"1fcc606f119dc883\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/verbFacet.js\":\"ab1872bb6db6cae2\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/block.js\":\"ec07576c7a9a606b\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/focusedChild.js\":\"86435591b84f2efb\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/propertySchemas.js\":\"730715ca461965da\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/typeRegistry.js\":\"82a47560dadf98bf\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useAncestorCrumbs.js\":\"bef7ec088eed15fb\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useAutocompleteListbox.js\":\"44d1d042becb38f8\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useDebouncedSearch.js\":\"ed6d175a41933bbb\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useDebouncedValue.js\":\"448be9f156f513e8\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useIsFocalRender.js\":\"4af99d8466af0179\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useIsReadOnly.js\":\"dd8c8478c1e07b0d\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useMaterializeBacklog.js\":\"0758a4a9d955338d\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useMinuteClock.js\":\"16452592c7236279\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/usePanelLayoutProjection.js\":\"85cb331a6b927f36\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/usePendingInvitations.js\":\"6b824cca7c190b67\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useRendererRegistry.js\":\"98ec50a237c07bac\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useRetainedFieldRows.js\":\"c3607c4669ac8d6d\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useWorkspaces.js\":\"701616a85b6ff663\",\"/knowledge-medium/pr-preview/pr-1851/src/lib/utils.js\":\"3ab692f2867eda2e\",\"/knowledge-medium/pr-preview/pr-1851/src/main.js\":\"a2d716aba607db98\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/MarkdownImage.js\":\"e6c7497fe2ba107e\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/blockSeparators.js\":\"00059df76ba44f92\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/context.js\":\"244ea193f930bfea\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/defaultMarkdownExtension.js\":\"96faed74af6eb4be\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/extensions.js\":\"b2ff123d273b3a50\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/renderMarkdownHtml.js\":\"dd3aeeaa29afac84\",\"/knowledge-medium/pr-preview/pr-1851/src/minimal-editor.js\":\"d047edf6b9c41442\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/armedCut.js\":\"e086062b52d64a99\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/captureMediaVerb.js\":\"4cb62f7078d02a7a\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/clipboard.js\":\"fa3bc4d67514c75e\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/decision.js\":\"0705f15b119ac0fc\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/operations.js\":\"10f390386467d840\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/account-header/AccountHeaderItem.js\":\"26c299b208ba5373\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/account-header/index.js\":\"d5936748241e3bc4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fa3b7038aaca5b5d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/askAgent.js\":\"551a489e86036663\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/askedStore.js\":\"79aa0319f14aee42\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7b4338984acf9877\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/chipState.js\":\"b55fe4db5e906c57\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a9f52beb6414f122\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/index.js\":\"2f45b0b275661d4c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"52a2824d8b1bd8a7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/schema.js\":\"b07877a69d15ff31\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/AgentTokensDialog.js\":\"45c40e50ce4a1793\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e6a2d5912d1bc7f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/addMedia.js\":\"61411e66e9a1dfbd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7a821d4f281743ab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/block.js\":\"7278d57ae4dccc3a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/context.js\":\"7dd015e42b210e43\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/displayIds.js\":\"da18abf4257379c4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/index.js\":\"060ec9be84da4230\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/outline.js\":\"3fa28763f3d85c89\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/properties.js\":\"8e77d55ccc8ed02e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/refs.js\":\"32868c1f05994fd0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4cd575819e09eb99\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/search.js\":\"d0759e70e2f867ac\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/shared.js\":\"781bcce0680196df\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d15d236d899234f7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/text.js\":\"481bf74f6773acfd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentWrites.js\":\"97e1c0d1397f30bc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/authoringCatalog.js\":\"0149b03d15745a1b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/blockRefTargets.js\":\"5eebf10cf317645d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/bridge.js\":\"5e1019ca8a5f4081\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/bridgeLoop.js\":\"f19b2e10e203bf41\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/changeHistory.js\":\"2c541153ec07f25a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/commands.js\":\"c8dfca61d540945a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/commentsCommands.js\":\"7524d91c537e0ca0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/dataExtension.js\":\"c2565eef5a5b1d84\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/dataModelGuide.js\":\"06254235ea52d5b6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/describeRuntime.js\":\"86be82af0a327a7d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/extensionLint.js\":\"7e75a4beb1993810\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/grainAudit.js\":\"36befdda2c8d5a27\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/healthCommand.js\":\"8cc88012d1264569\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/index.js\":\"e1aa53d7884eeb7d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/presetIdentity.js\":\"0991a37f97035141\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5e69895319a38289\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/readMedia.js\":\"d6c32df763346a2d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/schema.js\":\"21a68d05b9b66d88\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/serialization.js\":\"cbc81db83c20e257\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/targets.js\":\"df5d43fcb337cee1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/tokens.js\":\"0fb61abb33b07479\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/watchEvents.js\":\"fa153a75bd7c37a3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/workspaceGuard.js\":\"ee0a1ffdbcbfe272\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/writeCommands.js\":\"9d68d3388a13aa81\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/AliasCollisionToast.js\":\"13853f6eada58814\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/DuplicateNameBanner.js\":\"86c8c27619c99257\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/collisionMerge.js\":\"e5797c0a1021af11\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/dataExtension.js\":\"2b52f3cafa5de1ee\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/index.js\":\"2f7f76d86fe4b8f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/mergeCollisionAction.js\":\"8865ae70c3fafde0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/pageStyling.js\":\"11afed7be589bc67\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/rejectionToast.js\":\"118258f6d6238d58\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/syncProcessor.js\":\"3588cbf6e3c3d6e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/actions.js\":\"95567f7bda8eb6f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/addComment.js\":\"90db4519bfa5f800\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/anchor.js\":\"bd730f55354232c4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/anchorState.js\":\"955a98c324cbbb0a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/commentLinks.js\":\"27b7beac0dc6c5c1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/confirmThreadDeletion.js\":\"92e1b95a8db3d6db\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/container.js\":\"0651a0828fedfbaf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/dataExtension.js\":\"99ab4faf7ad009b8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/deleteComment.js\":\"29a19ff78f8e32bb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/highlights.js\":\"a967f75b90b2acb3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/index.js\":\"0075db78f4f71543\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/linkedCommentsPill.js\":\"b4b4792e9adc48e6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/margin.js\":\"ddfccd8e7265e893\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/marginSchema.js\":\"727f22b8d7767b48\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/newComment.js\":\"6926a7843d83cfac\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/ownThreadPicker.js\":\"779fe3831854c9e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/placement.js\":\"9eda5517e2da13b5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/queries.js\":\"280ece2d958ab18b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/quotePosition.js\":\"7da7eb31dab13bdd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/quotedIn.js\":\"2d42f61ec9e468d2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/quotedRange.js\":\"7f49ec067db9c4a9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/rangeRefs.js\":\"d32edced246be839\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/readHighlights.js\":\"dd7bd4ae61288f98\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/readSelection.js\":\"3a773959b8a9c9fa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/readSelectionUi.js\":\"7c882749c922afca\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/reanchor.js\":\"4abac114a99425ad\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/schema.js\":\"96914457fdcb3953\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/scope.js\":\"47892ccb582e7c95\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/scopeThreads.js\":\"fd48098663988b15\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/splitRetarget.js\":\"337c1c03881ed70e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/suggestionCard.js\":\"5c965cbb7139253c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/suggestions.js\":\"ad2fe4a0fcaaf643\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/summaries.js\":\"798f08aaf7746a1c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/summaryBatch.js\":\"3df15da2b7299e18\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/surface.js\":\"0226d176ba6d61c6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/threadNavigation.js\":\"2eab7423522d32f3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/threads.js\":\"566e72e3e57f170d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/ui.js\":\"8fd9138115034bca\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/uiStore.js\":\"59537645d8392e79\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-intents/appIntents.js\":\"15eb7b422c2ff708\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-intents/index.js\":\"b1cf753c84680b9a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-update-prompt/index.js\":\"70b7fdcf8931365a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-update-prompt/status.js\":\"4e7512fc224de6f0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"59442046464e7c50\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/MediaBlockRenderer.js\":\"4714760d2ade31b3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5f2a29ba9035dd04\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/MediaUploadReconciler.js\":\"2e5b18aaf6f7ece3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/assetDownLane.js\":\"c88dfe1f94f4d57f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/assetResolver.js\":\"538e3e4b83a3a5e8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/assetUpload.js\":\"17eae39987e4d953\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/attachmentCleanerIO.js\":\"164ec40a4b82e235\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f8fcaf240934b9d4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/blobStore.js\":\"c8817631a6edced3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/byteStore.js\":\"f7e2f81258cd9a3a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/cleanerIO.js\":\"6e9bda8eb46919c1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/cleanupAttachments.js\":\"3f5e354f6c3be1db\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/dataExtension.js\":\"6db2374a2916c886\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/downLane.js\":\"29a6f3eb15559590\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/index.js\":\"87f8d625b1a970d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/insertImageContribution.js\":\"0b8546101ef15159\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/laneArming.js\":\"94992534b3dc9ba8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/laneLock.js\":\"c1dd442d64b1ab40\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaBlock.js\":\"540eab6ac1ddeb73\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaCapture.js\":\"55efb79e75bc00cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaViewers.js\":\"ea83f2d669f73378\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaViewersFacet.js\":\"65f113f6dc729696\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/pasteCapture.js\":\"dfb21fb16f0bfd86\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/resolver.js\":\"25be8ff3cbe615b0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/retryUploadsAction.js\":\"8ecc6a95c5c7aeaa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/storagePaths.js\":\"66976ead79c6b38d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadDrain.js\":\"47da5f3f5751d78e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadLaneStatus.js\":\"1ccdd3a38c76ea30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadReconcile.js\":\"e6288905cc26eeeb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadRecovery.js\":\"ccd2d408c6324549\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadStore.js\":\"d0516594f6451d98\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/useAssetObjectUrl.js\":\"ad520f3a92c1d94c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"31eb239f9613887f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0e01784492419962\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/facet.js\":\"0bea9c1de65a6c9c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/index.js\":\"4a879d8fa6651635\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/prop.js\":\"10b11f0755e63117\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/BacklinkFilters.js\":\"e055c16dd7302c6f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4edbbd18d17b079b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/BlockEntry.js\":\"a8fe6bb4ccd9a79f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/LinkedReferences.js\":\"98bc85dea49380f2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b00637a01739ba2d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/dailyNoteDefaults.js\":\"6c349c2f278f71ad\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/dataExtension.js\":\"038de9f52360f0d1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/edgeExclusions.js\":\"9a8985049b2cbacd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/filterProperty.js\":\"c7f4dc4c622b66d7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/index.js\":\"a9528706955b29cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b62d2c02bc4bbd64\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/applies.js\":\"1c7fcf0882f2039c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/countQuery.js\":\"40d0da2e50272fda\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6054f5eb39840855\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/index.js\":\"99e864e9553ec506\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b3563be0084fb923\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/presentationInvalidation.js\":\"3f7a5a3d3cc51fb9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/propertyEditorOverride.js\":\"526364cf94c0d4c7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/propertyFilter.js\":\"626e0fa2167aca2d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/query.js\":\"90ac1e4f69aa9dff\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/resolveFilter.js\":\"26b8eb2ab81cce50\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/sourceBatch.js\":\"7fa101c6c3fa9fba\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/sources.js\":\"14dab41ccf96b48f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/useBacklinks.js\":\"5cb6f40eb12f951e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ecc0b7b86bf9f90a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/BirthdayCelebration.js\":\"3d48ca5f54e84d19\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/BirthdayOverlay.js\":\"452ee6fd7a891bde\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/gate.js\":\"c9feffc16ccb18ec\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/index.js\":\"38ef70b2f0977882\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/wolfTheme.js\":\"0bed73cf98edc917\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/BlockDragLayer.js\":\"4e2fb7be4a9734ae\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/dragController.js\":\"4747b5ab4802edab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/dropTarget.js\":\"1ab1d116ca2edf12\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/index.js\":\"6c458e4b9c0f8193\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/projection.js\":\"1c3e10f8da6f1dc8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-info/BlockMetaCard.js\":\"8f2ea924ab7792ea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-info/index.js\":\"c6be349dc5dea0bb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/AddTagDialog.js\":\"ecea4d3ae23bbb31\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7fd7879babe24774\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/TagNameIssueHint.js\":\"338ef568b09155d0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/addTagAction.js\":\"5c584f255aa004d4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/appendTag.js\":\"ea445381de1ad5d3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/config.js\":\"f57565fa573b99de\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/dataExtension.js\":\"a2972056269a4d37\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/index.js\":\"85eea47829d564a6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/propertyEditorOverride.js\":\"f76145f305183616\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d435f8404ce26385\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c1a15f2fbb69811c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/Breadcrumbs.js\":\"184746e1aaddcfdd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8df5bd00ee4aa1f4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"cb8e3bca84fb620f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/index.js\":\"536af91cc0263909\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cc144f8012c7b5bf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/CharacterCountItem.js\":\"9f9535d0b1591e07\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ceb5589f78cc8040\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/actions.js\":\"b1384935663f4954\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/blockType.js\":\"85099394e0603094\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/charCount.js\":\"a41b4a2b7d1cc262\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/dataExtension.js\":\"f1f46b9fb8fef50e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/index.js\":\"35b2f1e6faecfb9d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/profiles.js\":\"3e8f1ab5cdc3f916\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/properties.js\":\"5b202e39ff891d74\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/textCounts.js\":\"ac10911792bb8bdc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/colemak-keybindings/index.js\":\"d3afb18cc39014eb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/CommandPalette.js\":\"f48fba6f24bf9f69\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/HeaderItem.js\":\"ecb010ff11aceb93\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/context.js\":\"04272468a2066239\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/index.js\":\"a0a41829739ce196\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/selection.js\":\"7040fe1993394956\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/toggleStore.js\":\"d8ce2ae0d680418a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/useCommandPaletteActions.js\":\"cf9d69a8936f88e6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/ContributorBadges.js\":\"e846ce0da0278bb6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/author.js\":\"562d6110440e7e44\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/codeMirrorExtensions.js\":\"3574b918c660d735\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/dataExtension.js\":\"03739bd86f2583ba\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/index.js\":\"0c6c13ffc3d31f24\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/mentionAutocomplete.js\":\"acada7c49c1d5b45\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/processor.js\":\"1bf77f6ffe0696f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/profiles.js\":\"d7e633b8fe21b6ee\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/queries.js\":\"da944e28c9384047\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/schema.js\":\"8602536a4f856e30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"000aa83f84ce575a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/followOrigin.js\":\"af4ab0fb3a9f8c23\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/index.js\":\"132b35509e0d22cb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b50a9e7fde7553bf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9bfc8c6d1830da54\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/CalendarGrid.js\":\"a3235286e6d185c4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DailyNotePicker.js\":\"fa1ef19e7c0a96a6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f6632d184bad4b9b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DateNavDecorator.js\":\"c82e261092b7c2e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DateScrubOverlay.js\":\"48b77078f81e55d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/HeaderItem.js\":\"778bf8e5cbf13e17\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/ReschedulePicker.js\":\"f4f21cf3b2785eea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c793bf74832d2be7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/actions.js\":\"346f3ace2b585211\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/blockDateAdapter.js\":\"34dc6654b9bd842b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/calendar.js\":\"5889664074d4673a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dailyNotes.js\":\"940b6ec2871de165\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dataExtension.js\":\"b1b9f844bc4ef7c8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubActions.js\":\"181d94a8030aad07\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubGesture.js\":\"12f29bc74ebe1734\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8d29972d8c372cde\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubRecognizer.js\":\"528aa2f15d30ee2d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/deletionGuard.js\":\"4fc8a63fd913cf94\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dueQuery.js\":\"6304e2a59d3691c2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/index.js\":\"ceab5bc45d4aec56\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/landing.js\":\"37a7231182e9dc57\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/localSchema.js\":\"f63e974005e1815e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/referenceDateAdapter.js\":\"012c6ae8d42d530f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/rescheduleAction.js\":\"826a9df96dae9097\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/schema.js\":\"7fdfe92b6a0c5c89\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/spreadBlockDates.js\":\"0f3b2066630ff073\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/spreadDatesAction.js\":\"d1160525658930de\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/today.js\":\"aa8115c995e05624\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"baac6b8076f0f8d7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6d5bb62c7152184f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/audit.js\":\"f1a34390df2feb31\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/auditAction.js\":\"d68d946fbbfad8ce\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/auditRanges.js\":\"cb3df0922c05ce1e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/diagnosticsSource.js\":\"cbf8bc76f73e2277\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/divergenceScan.js\":\"370245d26fb8697f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/index.js\":\"08f1d07396b944bb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/propertyChildrenChecks.js\":\"580855f8981fc55f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/referencesMirror.js\":\"169757ff1c1f72de\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/rowJson.js\":\"1bfc07b58c17b79e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/schedule.js\":\"dcaa830e5d5f4e16\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/store.js\":\"1673b6be9cd5d400\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-maintenance/action.js\":\"8b089f8248a9ab94\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-maintenance/index.js\":\"fb7615fa6060e32b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-maintenance/plugin.js\":\"a979d9b0d0389ba4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"76d8a788b54817ee\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/actions.js\":\"0844897856b396cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/changeMarker.js\":\"bf64f85cf39c40f8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/diagnostics.js\":\"806031a767febef5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/fileSystemAccess.js\":\"1758e150eb031aaf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/filenames.js\":\"77e8dc23ce1b7b0e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/index.js\":\"612ffa42abbfd540\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/mirror.js\":\"b393c9ba49c07926\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/runLock.js\":\"838edf979e1548a0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/runtimeHealth.js\":\"4c4ff4c2d0374a1c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/schedule.js\":\"f9434bf73a8e7802\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/store.js\":\"f4417dc910cdf8cb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/default-themes/index.js\":\"3bcd51db23449b07\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/default-themes/themes.js\":\"eb6a2ba2b10c7397\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/diagnostics/facet.js\":\"5d2a639bce3649e0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/diagnostics/useDiagnostics.js\":\"5cf4897bf4522fb2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/dismissals.js\":\"41392068fb2f7733\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/index.js\":\"074e114bce4e8d69\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/status.js\":\"1fc77baf5892ecb5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/store.js\":\"d5e20877b0dabb1e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b6e22097c8eaecdb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/ExtensionsSettings.js\":\"41b33d22f3ba43d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/actions.js\":\"cb263d2f47557230\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/config.js\":\"1e7ffb634c41f2d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/dataExtension.js\":\"c06cccb12246eef5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/effect.js\":\"bc65ac4188a5ee09\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/index.js\":\"c2385f5a8ffd169e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8da952e9cd69aa12\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/useToggleTree.js\":\"37fea26b68aa65a7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/ExtractTypeDialog.js\":\"cb5e801fa20a7879\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d54966c3e20a6999\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/PropertyShapePicker.js\":\"d4a97d5671c6b046\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/action.js\":\"9c9ab8fdce0879b5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/index.js\":\"75231bdddaf18f7c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/FindReplaceDialog.js\":\"a5fcf051843806cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/HeaderItem.js\":\"d7b53989f560255e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/dataExtension.js\":\"7b054f9f5f94788e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/index.js\":\"ef96bc3212b8ae59\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/search.js\":\"95d9baa5adaa3906\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/toggleStore.js\":\"7ab91413a956cd56\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/LocationPropertyEditor.js\":\"62edfc978077f39c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/MapView.js\":\"96e412dae6afe414\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/blockTypes.js\":\"54d62e85c9a15e2c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/codeMirrorExtensions.js\":\"875977d87423b880\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/createOrFindPlace.js\":\"ed6e6a0eb2ab0754\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/currentLocation.js\":\"08c2006ae8b3a071\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/dataExtension.js\":\"1ca7435be1a3664d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/geoContentDecorator.js\":\"1b504a57828dd0a1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/googlePlacesClient.js\":\"f777eef3068f8a2d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/index.js\":\"31ad86874284c0c8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/locationsPage.js\":\"b9f50f6d649aea42\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/mapViewport.js\":\"212544abad0fcd44\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/pickCurrentLocation.js\":\"cb3e518980998ea7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/placeAutocomplete.js\":\"9fc4a3bdb27f2b5a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/placeNameCollision.js\":\"a343ce4be56dd06d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/properties.js\":\"40b7296d7fddfa93\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/propertyEditorOverrides.js\":\"e1f5503146237a71\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/query.js\":\"523f2401b62c93c3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/usePlaceSearch.js\":\"058cdc1872d177c9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"43f727f0fa6faf8d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"552e25a3a6738163\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"78b9f30e7a635221\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/config.js\":\"cf4992811b75acbf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/dataExtension.js\":\"aab6f7fb62eaa195\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/facet.js\":\"4ad5967c2020a6ea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/grouping.js\":\"66e004a56ee883d8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/index.js\":\"a30114b5928eb711\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8e1839afb3ea8f25\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/query.js\":\"4f9438b8e5281a16\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/resolveConfig.js\":\"87cdd6b57b058888\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"95932c9593614b4c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f8d9cd774ef58625\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/HtmlDocumentContent.js\":\"c039d3c9ad398057\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/HtmlFrame.js\":\"596e05640eefce9b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/actions.js\":\"24169d4774d92407\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/blockType.js\":\"5a63f90add6eaeec\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/confirmRunScripts.js\":\"15f35123c2cf38bf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/dataExtension.js\":\"4730a204ce187a1c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/frameAnnotations.js\":\"127f35e7de9357d4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/frameDocument.js\":\"8f4de7f56067608b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/frameTheme.js\":\"3960ed07abbbceb4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/index.js\":\"32df12aa6301f2c5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/scriptConsent.js\":\"c7a47ea7610ba009\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/sourceMap.js\":\"0968a6d9d9c252ab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/useDocumentScripts.js\":\"cd059acf9a1e5495\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/index.js\":\"15b78c1464f2bdc5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/record.js\":\"563df396e72d14d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/recordStore.js\":\"70943e9b995d7e31\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/responsiveness.js\":\"77467aab2ba24c69\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/schedule.js\":\"f22b17b18b89510f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/sessionContext.js\":\"589b3514591510fb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7cccf6cc6f060416\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3cb4d241831452e5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/actions.js\":\"a86ede497556ce98\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/config.js\":\"c4260c102b276928\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/dataExtension.js\":\"4d9373b8fac7212a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/effect.js\":\"0a989ddaa151d9ad\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/index.js\":\"001f669b48758150\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/keyCapture.js\":\"ed088acabbe8b5ce\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/overrideStore.js\":\"7f3fbc3e15bd4b0a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ede96ff8a972e4b4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/HeaderItem.js\":\"885955482424da87\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/LeftSidebar.js\":\"5c7d04b09fbf2433\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/actions.js\":\"5fbbf46f59547b2e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/facet.js\":\"4aa2f649cbd015e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/index.js\":\"ec1fde1194afe21e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/shortcuts.js\":\"8c8673efddc6b43d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/toggleStore.js\":\"bea43e64e5c954ee\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/MergePicker.js\":\"efb2bd6befd3b5be\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/index.js\":\"660a82e61818c2b3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/mergeAction.js\":\"1906bf39e36c7644\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/strategy.js\":\"97dd3c0a66cf6302\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/Button.js\":\"b4fad7a8c48f1f19\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"4d76cb926f58fb10\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/defaultItems.js\":\"20826cf37a6846d6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/facet.js\":\"5882d0d0e753c388\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/index.js\":\"d7af314f7bcb89d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a6e7192f7c42c1ab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6e60bb7da271329c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"164436edc98bc5e8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4c95292c19a888f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/index.js\":\"1fc75d07efd01276\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d4039e75197978d7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b5981484221ea4ef\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/contextMenuItem.js\":\"d3526a3a6402ab89\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/index.js\":\"2767143ca380b772\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/moveAction.js\":\"490916a08d61b77d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/moveBlocks.js\":\"9eebdbe0fcaeb10b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/selectionAfterMove.js\":\"01bf27964c907a6a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/TutorialBanner.js\":\"5fd982cf772dfc14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/action.js\":\"bb3a7db9ef3eeb58\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/bannerDismissal.js\":\"1560306295e60f6e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/documents/cheatSheet.js\":\"fb9ac40250171e5c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/index.js\":\"d36cd2b854a48ab1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/keys.js\":\"2ffe6892a374cdd7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/landing.js\":\"75b35b5862367880\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/outline.js\":\"9b83a82d084f13f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/seed.js\":\"0261a59062c824c1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/PerfTrendDialog.js\":\"df38cd4b462c920e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/analyze.js\":\"798a705defcba4a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/diagnosticsSource.js\":\"db698677cd5c74e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/index.js\":\"ac130bf127a57ac4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/load.js\":\"4410aabdf05cf033\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/monitorRun.js\":\"1db9cda81a6ebe90\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/schedule.js\":\"43b46534b33236c4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/series.js\":\"129246de178e0227\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/store.js\":\"7b97f42483b56aa1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/trendAction.js\":\"7701ab2f7e97893c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/verdict.js\":\"385f99bfe4513f52\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/plain-outliner/clickToEditAction.js\":\"abdb75a072ab78d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/plain-outliner/index.js\":\"a74b8809a5f73873\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/plain-outliner/interactions.js\":\"ad27c27dd34abf61\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"908c8a85ed4fb067\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/MigrationGate.js\":\"b5fcd62a5737d2d3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/MigrationGateDialog.js\":\"1dfc3be357d9ac77\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/action.js\":\"edb5baf68955d959\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/index.js\":\"38d92316e38f8876\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/localRunMessage.js\":\"f513f9474a14bb49\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/plugin.js\":\"7d98107469d766c8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/progressReport.js\":\"f2a2880801037de2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/sweepProgress.js\":\"2ed7ffa03980161c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/FieldRowRenderer.js\":\"8d58ab6f72fd4efd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/ValueRowRenderer.js\":\"d7f17af18d06e3aa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/actions.js\":\"85d9c1dc14df9613\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/autocomplete.js\":\"87b25ea3f110030b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/fieldRow.js\":\"ef4dbbacbc87723d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/index.js\":\"c597fafdf374270d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/referenceWarning.js\":\"2deba89b714d098c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/valueAutocomplete.js\":\"b1d849a01ea6aa30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/valueSchema.js\":\"ee6fa0094bf40b67\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/HeaderItem.js\":\"fa8b9d09d989da74\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/QuickFind.js\":\"678ef0ae747260f2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/index.js\":\"993cc1277a14ed39\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/recents.js\":\"76595b6a7aafcd84\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/resultItems.js\":\"033cbd5f91c4902d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/selection.js\":\"377b344bf5184cd9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/toggleStore.js\":\"e7bc6c7781e2dd26\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/HeaderItem.js\":\"c306fcfc3d9d05eb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ed9bbe3dc1bbee05\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/grouping.js\":\"be298db396596014\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/index.js\":\"d9dbe08b4d1f58e8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/target.js\":\"233f418af927f4f3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/codeMirrorExtensions.js\":\"9937b2b916b0ef11\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/contentPrefill.js\":\"3a4c4d680483bda0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/dataExtension.js\":\"4519001a861ae583\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/index.js\":\"bd0c76d8abced1de\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"75a1cf3be26f1026\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/invalidation.js\":\"5936e5eae4be5a98\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/localSchema.js\":\"2dff1658e7cfd30e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/blockrefs/index.js\":\"073f65ffda840316\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1ea33424a8757235\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/index.js\":\"4f906e304dcdba57\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/referenceNode.js\":\"8b3495eb3bb3981e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/remark-reference-occurrences.js\":\"22ca80c099284bc3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f680ef02d51ce8d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/index.js\":\"9c738616982ed2f3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e28e6947962e8ab8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bf5d2a256d7ca7e5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/mergeRetargetProcessor.js\":\"6e2aadfabad2acf0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/parseFence.js\":\"5c288a387058ed80\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/referenceParser.js\":\"8f2ffe4d90e59b27\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/referenceProjection.js\":\"fc318c7a748f0dd9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/referencesProcessor.js\":\"073aa570f80b423a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/renameProcessor.js\":\"d5d0b6176b6cb2cf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/spanReplacement.js\":\"916139aeca9bfcb0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/htmlToOutline.js\":\"ac6914983da62108\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/index.js\":\"fa55bdfac65e5f8c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1a57a38adb8ce09d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/pasteDecision.js\":\"70cb89ca93b24c94\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/action.js\":\"eef0a1bea6d8b098\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/blockIds.js\":\"051f7648d16d4129\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/content.js\":\"8092e51d38489712\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/effect.js\":\"14c0c6fc12c8603f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/ids.js\":\"02de253d64102a7d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/import.js\":\"06b95436c4ec15c8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/index.js\":\"a3bf6437d162d4b3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/plan.js\":\"0d4389144741c620\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/plugin.js\":\"7a9e7cb5282d1b97\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/promotion.js\":\"7d00462d0a179563\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/properties.js\":\"d171297281221cb0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/references.js\":\"a0570c6ccac9c7bd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/report.js\":\"f2e61e0b7a6eef45\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/roamMemo.js\":\"6473815324833944\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/runtime.js\":\"6151d4ac8e72aba6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/schemaReconciliation.js\":\"7fdfbf36e3b97169\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/srsMarkers.js\":\"2e415258f802bf41\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/todo.js\":\"8069782e2ac77f37\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/typeCandidates.js\":\"dc6ad26936c332c5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/types.js\":\"a679736e8463fcdb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/search-health/index.js\":\"06a63bf1cc36d605\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/search-health/store.js\":\"37d836f9cf0ca750\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/HeaderItem.js\":\"f82bb693c6f149c4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5148bb8bc89706fa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/index.js\":\"669da55076f18c71\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/model.js\":\"72a218c7b5af3712\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/toggleStore.js\":\"31eebd42e3558e6e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/useKeyInspector.js\":\"e82de9406126b749\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6ec50933fcf106d8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/ShellDecorator.js\":\"d865b3547c5746b4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/actions.js\":\"292607441ad44981\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/exclusionsFacet.js\":\"23cb60be96f6324d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/index.js\":\"fb04b852905debab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/shell.js\":\"91e55817ee442ce0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/surface.js\":\"53f4df3e0f9b57fe\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/walker.js\":\"0f77b8ebdf9e1db9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9268352ad513ca0c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/dataExtension.js\":\"6302614e586f2cc9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/index.js\":\"7cd2cd667e475751\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/indicator.js\":\"7e0168b04eecb68c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/moveSrsState.js\":\"f04de6015158c662\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"64f04ddad782ebcc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/scheduler.js\":\"fcfeffc12a1436ed\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/schema.js\":\"7960693a5ff58548\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f3224bb249fbc21f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/srsClipboard.js\":\"fac259b834345a72\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a24b47918bdb9986\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6178b09d27a91dd5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/DeckPicker.js\":\"1b2d7d31e912be5c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/ReviewControls.js\":\"8ab309c49144e55c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cf2910f60a9fc506\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/ReviewSession.js\":\"3e8e586fc0dce786\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/actions.js\":\"7b7a909cb7d2f101\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/archive.js\":\"5eaea8031a98b3b6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/dataExtension.js\":\"7526126214fa8604\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/deck.js\":\"0fd2e76b8c84ad6c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/dueQuery.js\":\"7bc4c13003de01f2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/gradeDecision.js\":\"9d60b646558b0496\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/index.js\":\"01bc103379b26782\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/keyHints.js\":\"8fa5767c2dd69417\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/reviewCardLayout.js\":\"676edfffeb3de91d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/reviewProgress.js\":\"0270e4e8fe9a53c6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/schema.js\":\"1790a8c827a23b4b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/useDueCards.js\":\"39c07021da96e1a1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/startup-metrics/index.js\":\"8c09e21cd1791e7f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/startup-metrics/record.js\":\"e2d16a4dc0bf599e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/storage-persistence/index.js\":\"1e2cc977090b3f97\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/storage-persistence/persistenceStatus.js\":\"48457f9ea5f1ac46\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/storage-persistence/requestAction.js\":\"06baac6e0cd36381\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/TypeChipsDecorator.js\":\"b185ea3c96dcab49\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/codeMirrorExtensions.js\":\"e9356a025ca44719\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/index.js\":\"d6a99966ec8f0333\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/typeAutocomplete.js\":\"e6eeb52ec6306094\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"550b60965fe889af\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/actions.js\":\"3127650e086cc4cf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/anchor.js\":\"eae1c274bbaf1a7b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/events.js\":\"9191aa7936660cda\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/gestureActions.js\":\"29ec48efe8e3977b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/index.js\":\"ba8847b40a231eb4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"229724537248424c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/sync-metrics/collect.js\":\"4e7ee877457295fe\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/sync-metrics/index.js\":\"63f887d8d736ec4a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/sync-metrics/record.js\":\"bb681a53f686dbf2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/RejectionDialog.js\":\"fabd333f4adee659\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/SystemStatusHeaderItem.js\":\"88dc81e60cd1e88f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/index.js\":\"c36f24869e11655c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/model.js\":\"27f8430f2b30be38\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/queueCounts.js\":\"e8d82489f668ed30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/rejectedHelpers.js\":\"a38123e674d5744a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/rematerializeAction.js\":\"40edb1a0a6d52303\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/useHysteresis.js\":\"1204fb720659511f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/ColumnHeaders.js\":\"8cb5f56a32472d16\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/QueryUi.js\":\"fa297d95688a767a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/TableLayout.js\":\"5084f7bd408593e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/actions.js\":\"4a7d7c3cc7d0680d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/cellEdits.js\":\"0141ed67e6f7c123\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/columns.js\":\"ffe245f76b412c9d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/controller.js\":\"b4e698cc1882ebba\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/convert.js\":\"695eedbb6cb00686\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/dataExtension.js\":\"434cb7da4ebc7319\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/index.js\":\"fff41adb16e8b163\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/keys.js\":\"b62b42e83ee07d31\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/model.js\":\"2a04dbe8cddd23a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/navigation.js\":\"1665bdfc087a92d0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/backfill.js\":\"bece8708bcaffb87\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/format.js\":\"8a1b3a0e56776660\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/parse.js\":\"bf96caa926179812\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/queryValue.js\":\"38227303eedc4ce6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/source.js\":\"75de06d19ab0f73a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/registry.js\":\"d9516046a703a31b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/rowGutter.js\":\"2202cf9915bf22a7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/rowVerbs.js\":\"0a140cf2ca2959a6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/schema.js\":\"b49068868c77c1b5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/sort.js\":\"449faa41217f1274\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/theme-toggle/effect.js\":\"0f16f1d3b3b4bf10\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/theme-toggle/index.js\":\"196f226bae97ec45\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/theme-toggle/theme.js\":\"fc9aacfce1f8a76b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/actions.js\":\"6ce2ff1cc6eb5d02\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/dataExtension.js\":\"d20b73aebb27f199\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/index.js\":\"e9b7c1ee082f0608\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/schema.js\":\"e2d97ced3e1f867a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7f5c4328914d474e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/actions.js\":\"9cf8fa7f0efef496\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/defaultItems.js\":\"43a264d251875f1e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/facet.js\":\"838644f3956409a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/holdRecognizer.js\":\"f65f3d4912799c79\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/index.js\":\"b830025a7951097a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/update-indicator/UpdateIndicator.js\":\"d37d61544ca1d03e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/update-indicator/index.js\":\"b7062ecf7a7c168c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/update-indicator/loadTimes.js\":\"8417ba664e695363\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/VideoNotesRenderer.js\":\"5e9187aa4b6bda08\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/VideoPlayerRenderer.js\":\"8edff5a7feb89c01\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/VideoTimeStamp.js\":\"f378c879633d1ba3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/actions.js\":\"539684c4c350c1b9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/index.js\":\"e455b622f38758ee\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/markdown.js\":\"52115a08e2663ba6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/notes.js\":\"972399445602a19b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/registry.js\":\"e5f71cd3521f0c79\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/remark-timestamps.js\":\"c54d4d81cac939bc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/view.js\":\"f37cceb5a6535b26\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/LinkHints.js\":\"8cebd51b06b01efd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/index.js\":\"67195e401f86dcc1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/model.js\":\"5a8eba2523459a34\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/settings.js\":\"f921a85dd6cfd46e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-normal-mode/actions.js\":\"75f47c4fd52d4e77\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-normal-mode/index.js\":\"5cc223d6a5be4138\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-normal-mode/interactions.js\":\"a194639c984183d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/workspace-header/index.js\":\"2d757046a8f9ea57\",\"/knowledge-medium/pr-preview/pr-1851/src/registerServiceWorker.js\":\"8c69bdc065bd16a3\",\"/knowledge-medium/pr-preview/pr-1851/src/requestPersistentStorage.js\":\"39cd339e0f765ab0\",\"/knowledge-medium/pr-preview/pr-1851/src/services/authRequestDeadline.js\":\"912e15ee95fd66eb\",\"/knowledge-medium/pr-preview/pr-1851/src/services/authStorage.js\":\"baf2229f0789aa6e\",\"/knowledge-medium/pr-preview/pr-1851/src/services/powersync.js\":\"2fa08967661876be\",\"/knowledge-medium/pr-preview/pr-1851/src/services/supabase.js\":\"523cc0cadfeeba91\",\"/knowledge-medium/pr-preview/pr-1851/src/services/uploadErrorClassifier.js\":\"d08a5f2e9f34f62d\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/ActiveContexts.js\":\"aef9afbaae1962ca\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/HotkeyReconciler.js\":\"a5764ffd587103de\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/WipeLocalDataDialog.js\":\"94b6687eaeedaa92\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/actionDispatch.js\":\"3bbed43862751514\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/actionRefItems.js\":\"5e44916fc77f6ca5\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/applyKeybindingOverrides.js\":\"e9ea46414c7e578b\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/blockActions.js\":\"0cf524bd197878c5\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/blockMergeGesture.js\":\"de048f78646e4b80\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/canonicalizeChord.js\":\"85dfcc04f50daa55\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/defaultContexts.js\":\"4ed58c43d3852ec0\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/defaultShortcuts.js\":\"2db5ae543fe4aef7\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/effectiveActions.js\":\"e66f7be778052062\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/gestureAction.js\":\"e88d937e6bdacb78\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/gestureBinding.js\":\"79be1f9f4f3e1367\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/holdRegistry.js\":\"bf1f6acd25605d26\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/keybindingConflicts.js\":\"ddda523c667e227b\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/keybindingOverrides.js\":\"4cf67674c0f048a0\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/pointerAction.js\":\"77a0696a5763a61a\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/resolve.js\":\"e69c3b834944c592\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/runAction.js\":\"facdedd64f1187b2\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/sequenceMatcher.js\":\"67378a8a387d7182\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/types.js\":\"519a8f108df069d6\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/useActionContext.js\":\"2844991804aade90\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/useActionDiscovery.js\":\"fc753519300c43f1\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/utils.js\":\"6c635c9bdd39f918\",\"/knowledge-medium/pr-preview/pr-1851/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1851/src/sw/bootStore.js\":\"94ecc11f9466f887\",\"/knowledge-medium/pr-preview/pr-1851/src/sw/previewDatabases.js\":\"351a21534f652c31\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/byteTransform.js\":\"c17ee4b10c1bc475\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/attachmentCleaner.js\":\"61cc8b66175ece1a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/attachmentParts.js\":\"f518786eee09f47c\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/bundleParts.js\":\"fcd4ca72cc2bf216\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/bundleRecord.js\":\"271a810e258ecbd1\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/manifest.js\":\"491cad7804484bde\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/takeBundle.js\":\"16212852e66e5722\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/verifyBundle.js\":\"5c4eb95979b2daaf\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/cleaningStage.js\":\"fe929c970616a994\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/conversionKey.js\":\"f2938e0ffa6d96cb\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/conversionServer.js\":\"1a83d332938880dc\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/flip.js\":\"e58257335848c423\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/flipAttempts.js\":\"f0d1a3594532b05d\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/pages.js\":\"e8388d073c1d7080\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/preflight.js\":\"12b4ecd70425daf3\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/reseal.js\":\"b66b3ed316c727dc\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/runConversion.js\":\"468894ac55905d11\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/runLock.js\":\"d373a12343637e86\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/sealing.js\":\"ff11e3c1bd76a405\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/sealingStage.js\":\"85ff5a409d4b2105\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/stage.js\":\"d3ac1fcb863b7cff\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/verifyReseal.js\":\"e05187cdd064f41d\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/aad.js\":\"53161cda39a1b49b\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/aead.js\":\"6d17436530ce48e1\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/base32.js\":\"9df9f0bf3a030d2a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/base64url.js\":\"a92f9b813a347a2e\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/binaryEnvelope.js\":\"71a1fde4121aacb2\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/byteAead.js\":\"e1538d7f38b08d93\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/canary.js\":\"1ffe1b1ec78e97ed\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/contentHash.js\":\"d78ba497c7dc7e60\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/contentKey.js\":\"1f574b409de9270f\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/derivedIdNamespace.js\":\"a94780339e424b93\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/envelope.js\":\"7edaf87d5320e9c5\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/hex.js\":\"0e25211f99ed56fb\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/sha256Hex.js\":\"ef3801f10bfe5dcc\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/workspaceKey.js\":\"223c867bef1714f1\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/conversionState.js\":\"69cde576f9e5da26\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dccd382e0d4a1b7e\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/pastedKey.js\":\"611171d9c11386e2\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bef6de0c381b5c2e\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a7fdd6557b3c46bd\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/keyStore.js\":\"1a8bb81a3da8856a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/mintWorkspaceKey.js\":\"1bb7f192bf17c314\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/modePin.js\":\"cfc1544c10e4d497\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/openWorkspaceKeys.js\":\"c679a0b47202618a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/resolveWorkspaceEntry.js\":\"ad300151c8a707aa\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/resolver.js\":\"19da6074a729ea36\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/workspaceAccess.js\":\"bb08ada16a567bf7\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/transform.js\":\"f6abddb0c88750e9\",\"/knowledge-medium/pr-preview/pr-1851/src/themeBootDefaults.js\":\"c4d0468b5944219d\",\"/knowledge-medium/pr-preview/pr-1851/src/types.js\":\"69cabe9557ce9c05\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/ClientLocalSettings.js\":\"9dfd23a258f11629\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/abortableSleep.js\":\"a413ba68a043562b\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/array.js\":\"230a85c68985321c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/backlinkAutocomplete.js\":\"06045df7f4173a51\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/blockCrumbs.js\":\"07dac24d9f54aa8c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/blockrefAutocomplete.js\":\"756a02c3109ac8c9\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/cadencedIdleJob.js\":\"21d1d91f5d511586\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/callbackSet.js\":\"1a80b3c778e1f090\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/clientId.js\":\"691545e8859bdbfd\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/codemirror.js\":\"f02352d2c2eb15c6\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/codemirrorCompletion.js\":\"7370593b1e8ddbe9\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/copy.js\":\"c8f1e7a0c738ce6d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dailyPage.js\":\"d2c7d09bf96fd82f\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dbForensics.js\":\"4a8588b3304ef415\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dbForensicsHooks.js\":\"a74353c47d587ae0\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/deleteBlockThroughUi.js\":\"71349cae7f10e63c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dialogs.js\":\"667129f603ee469d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dom.js\":\"36a222dc27b6a8c3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/downloadBlob.js\":\"90dbe65fe4751443\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/exportSqliteDb.js\":\"41cc900901a83801\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/fileSystemAccess.js\":\"429b2313c2e9a9fa\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/flipSlide.js\":\"3d145ca4466664cc\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/fnv1a.js\":\"c907400916f7e4a6\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/formatBytes.js\":\"e5c1b8cbb60f1285\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/fuzzyRank.js\":\"c2cc7a1da15b9630\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/idbKeyedStore.js\":\"41aaa6779011f947\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/idleCallbackPolyfill.js\":\"b9626295ff22b3bc\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/keyboardAwareScroll.js\":\"f57f5864bb2d0249\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/keyboardViewport.js\":\"67b818cf56df0cfb\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/lastWorkspace.js\":\"27bc03d02387bb72\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/layoutColumns.js\":\"ef72231f9e382468\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/layoutSessionDom.js\":\"78f3060b9a3e62de\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/layoutSessionId.js\":\"dd5215ac230dd928\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/linkClickGestures.js\":\"13f590a57353b8e3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/linkTargetAutocomplete.js\":\"23279f28e1d8a44c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/localDbCorruption.js\":\"fb1baaa1f0cc6634\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/localDbRecovery.js\":\"7128f4155fe6b1f5\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/markdownParser.js\":\"d910689d2d762972\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/memoize.js\":\"bd6220a1a55e91ba\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/nameFieldCommit.js\":\"660669b72067bed3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/nameList.js\":\"6ef41e2a85c6eaf2\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/navigation.js\":\"79b466cebe8efc01\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/omnilinerNamespace.js\":\"74721bc8b827a04d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/opfsPageScan.js\":\"31f3dba333173388\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelClearance.js\":\"0772416516914088\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelHistory.js\":\"8ba59a06a9abfb5e\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelLanes.js\":\"be3286a7215834c3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelLayoutProjection.js\":\"513678b096e2e4b3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelScrollAnchor.js\":\"d45aa380c42dd394\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelUrlFlags.js\":\"89f3bc6667317acb\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/platform.js\":\"74aedada57e39673\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/pluralize.js\":\"be0ee3d32d4cf9eb\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/propertyCreation.js\":\"c795eb15bd3e7b9e\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/propertyNavigation.js\":\"5f181918be54ce1b\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/propertyValueContext.js\":\"c6f5d8b940474194\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/react.js\":\"889eeebece01164c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/relativeDate.js\":\"b5064bf3592413da\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/relativeTime.js\":\"988033f2590508a3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/renderScope.js\":\"e8cc9020c2cbedff\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/resolvedThenable.js\":\"0a2276aa406bb4fe\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/routing.js\":\"e44a20d40e753d63\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/safeMode.js\":\"4f9863c439a66a98\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/scheduleIdle.js\":\"40d6b885d158ebbe\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/screenWakeLock.js\":\"8b200f2f78439e17\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/selection.js\":\"8c4118dc78c3db2a\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/softKeyboardGrab.js\":\"eb5d905f833d1929\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/startupTimeline.js\":\"1babed326ab296ad\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/state.js\":\"37e9c7398ba25f23\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/string.js\":\"9d1b58d6b5a402df\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/surfaceZoom.js\":\"1e73de6c33ae93f6\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/time.js\":\"a3f1860014410f08\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/toast.js\":\"80c3bf78eda91b3e\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/toggleStore.js\":\"db9e9c3e19b729d5\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/untilStopped.js\":\"301acfc410562ead\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/userActivity.js\":\"0f2a93f74383f98d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/viewTransition.js\":\"a41a1376669d0106\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/viewport.js\":\"66d4cfbf0c900e77\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/webLock.js\":\"794e868ed8385658\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/workspaceRecovery.js\":\"c12795c17cfd0a8d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/workspaceSnapshotStore.js\":\"244505b8353e554d\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-compiler-runtime.js\":\"3a5bac1b9396478e\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-client.js\":\"00a83fe771a2640a\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-server-edge.js\":\"49ffe0d2ee2014e6\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-server.js\":\"7bf8f3e80ece9f61\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-static-edge.js\":\"801e5ce570a698e7\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-static.js\":\"bbd823b8d856baf1\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-test-utils.js\":\"ee682e548605c5a2\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom.js\":\"bfe9c1240bfecba3\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-jsx-runtime.js\":\"1c5382243fb923ec\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react.js\":\"8597b4ac8f820fe3\",\"/knowledge-medium/pr-preview/pr-1851/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1851/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1851/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
