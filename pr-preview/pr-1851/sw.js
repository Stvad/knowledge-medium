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
		buildId: "e070e1e6b5f8-d1aca201",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1851/\":\"a2de547cc9cc4b41\",\"/knowledge-medium/pr-preview/pr-1851/index.html\":\"a2de547cc9cc4b41\",\"/knowledge-medium/pr-preview/pr-1851/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1851/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1851/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1851/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1851/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1851/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1851/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1851/assets/FacadeVFS-CS5dr1Yw.js\":\"c65f8a2de429d7d1\",\"/knowledge-medium/pr-preview/pr-1851/assets/OPFSCoopSyncVFS-Dn5DHfmL.js\":\"e99d8e970bee80bf\",\"/knowledge-medium/pr-preview/pr-1851/assets/OPFSWriteAheadVFS-CMQv3Ngr.js\":\"bdc8f8adb45a3611\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-async-Bl-R4dgZ.js\":\"999ec17e51ca8a71\",\"/knowledge-medium/pr-preview/pr-1851/assets/wa-sqlite-gIgYloap.js\":\"9711ac7ca8cf1188\",\"/knowledge-medium/pr-preview/pr-1851/assets/worker-D025s6JH.js\":\"9cae06fd5278338e\",\"/knowledge-medium/pr-preview/pr-1851/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1851/chunks/app-YyICAhjD.js\":\"cb799f9d8fa368dd\",\"/knowledge-medium/pr-preview/pr-1851/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1851/index.js\":\"c65430b1ceac1788\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1851/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1851/assets/AccessHandlePoolVFS-5jaDjR7p.js\":\"5bdcea6538c7cfa6\",\"/knowledge-medium/pr-preview/pr-1851/assets/IDBBatchAtomicVFS-D5xFNtNM.js\":\"b6d2713eddd49917\",\"/knowledge-medium/pr-preview/pr-1851/assets/MemoryVFS-BYjbHx-D.js\":\"4e0e11e4f10ebfea\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-4L7iDVXU.js\":\"3655f7b3aed52c73\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-async-D45LCetA.js\":\"e153226145345672\",\"/knowledge-medium/pr-preview/pr-1851/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1851/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1851/chunks/AccessHandlePoolVFS-DwVZO1Tw.js\":\"5e6417021800e7d9\",\"/knowledge-medium/pr-preview/pr-1851/chunks/FacadeVFS-HbPw8ug1.js\":\"d67563936cef3068\",\"/knowledge-medium/pr-preview/pr-1851/chunks/IDBBatchAtomicVFS-CgM5gSYq.js\":\"eecaef11a02e8769\",\"/knowledge-medium/pr-preview/pr-1851/chunks/MemoryVFS-CLE3Z7D3.js\":\"e18f4ed7a5bcc632\",\"/knowledge-medium/pr-preview/pr-1851/chunks/OPFSCoopSyncVFS-k8Fx2guR.js\":\"49f747dd3181a144\",\"/knowledge-medium/pr-preview/pr-1851/chunks/OPFSWriteAheadVFS-7SbiFZJp.js\":\"f119f18c0a1ff968\",\"/knowledge-medium/pr-preview/pr-1851/chunks/Preview-iEDGBAnl.js\":\"168373346e4babdc\",\"/knowledge-medium/pr-preview/pr-1851/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1851/chunks/card-_6cHgcfK.js\":\"fe79c9196388454d\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1851/chunks/dist-DR44QezI.js\":\"2c4b3e75b92d404e\",\"/knowledge-medium/pr-preview/pr-1851/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1851/chunks/mc-wa-sqlite-BuW3f1zY.js\":\"201c1902a999e2b9\",\"/knowledge-medium/pr-preview/pr-1851/chunks/mc-wa-sqlite-async-B-IFH9sE.js\":\"cf91aee1f9729a82\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-B3a62BEP.js\":\"e6a1a056b976ac01\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-BGfkoO2S.js\":\"8c3bd965a7ee27ea\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-C0A_YqkX.js\":\"7d2a92d39ccc1fa8\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-D-d1wJQW.js\":\"19260362e4c97e24\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-DCWqybmQ.js\":\"7501ef43d2d2f680\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-DrlWzK7W.js\":\"b0976feadb49b5ba\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-dom-server-legacy.browser.production-DrLXHd84.js\":\"e00d302125ca8b51\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-dom-server.browser.production-BO3z7lq-.js\":\"cf097e802785bb25\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-dom-server.edge.production-hwz72dq9.js\":\"e918234979add484\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-fZedmcuB.js\":\"bb75ef0af81aed63\",\"/knowledge-medium/pr-preview/pr-1851/chunks/react-wS7Yeacs.js\":\"ae7eb425981af503\",\"/knowledge-medium/pr-preview/pr-1851/chunks/server.browser-D5Uc9NSw.js\":\"8e8bddc13b4bfbf3\",\"/knowledge-medium/pr-preview/pr-1851/chunks/textarea-YwiIW2nZ.js\":\"7e04dc6883437bf8\",\"/knowledge-medium/pr-preview/pr-1851/chunks/ui-DMMk2AP7.js\":\"5752d9fb4a02b0df\",\"/knowledge-medium/pr-preview/pr-1851/chunks/wa-sqlite-async-SJ1NCB7m.js\":\"44d95c6aa914a961\",\"/knowledge-medium/pr-preview/pr-1851/chunks/wa-sqlite-cL8wrYyS.js\":\"e2dfb3d10b8933b8\",\"/knowledge-medium/pr-preview/pr-1851/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1851/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1851/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1851/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1851/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1851/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1851/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1851/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1851/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1851/src/App.js\":\"1e42a1a730c9f790\",\"/knowledge-medium/pr-preview/pr-1851/src/appUpdate.js\":\"c488308febc64283\",\"/knowledge-medium/pr-preview/pr-1851/src/appVersion.js\":\"f0fa8a0370777e90\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/initialLayout.js\":\"a28bb722b90d3279\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/openWorkspaceData.js\":\"63acb2ae3742a68b\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/resolveWorkspace.js\":\"3050b819070671da\",\"/knowledge-medium/pr-preview/pr-1851/src/bootstrap/workspaceBootstrap.js\":\"2c0c642e45f8e31d\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockComponent.js\":\"2069291411d147cd\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockCrumbs.js\":\"6002cfbb7bb31196\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockEditor.js\":\"d8a016b6f9983bb9\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockLoadingPlaceholder.js\":\"78f4acf1360753d3\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockProperties.js\":\"7a9aa2f1612e7658\",\"/knowledge-medium/pr-preview/pr-1851/src/components/BlockSearchPicker.js\":\"940ac5a1191568ce\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ConfirmBulkDeleteDialog.js\":\"ff65c0d78ea35b59\",\"/knowledge-medium/pr-preview/pr-1851/src/components/DividerHandle.js\":\"1f918ab8c61b0711\",\"/knowledge-medium/pr-preview/pr-1851/src/components/DraftEditor.js\":\"125a1e1e493023d1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/GutterPill.js\":\"934989ad7687caa3\",\"/knowledge-medium/pr-preview/pr-1851/src/components/Header.js\":\"1df2e995c52b9c23\",\"/knowledge-medium/pr-preview/pr-1851/src/components/LazyBlockComponent.js\":\"27deed4af8f4e26e\",\"/knowledge-medium/pr-preview/pr-1851/src/components/Login.js\":\"ce91a2e098748ee7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ZoomableSurface.js\":\"407f541bbddefae8\",\"/knowledge-medium/pr-preview/pr-1851/src/components/editModeKeepalive.js\":\"3fdf964ab4c845f5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyDisplay/PropertyDisplayScope.js\":\"32977249072b4ece\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5afa310ef5747a10\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/RefPropertyEditor.js\":\"2ad73bd453509865\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/RefTargetTypePicker.js\":\"ab675d1732428322\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/SelectPropertyEditor.js\":\"922dc15740dd1222\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/TypesPropertyEditor.js\":\"3b06f2ba5a5b7261\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/defaults.js\":\"081ae5a3554a8529\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/kernelValuePresets.js\":\"5bd182fd4b61961b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/selectablePresets.js\":\"bdc4573de9ca8fea\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyEditors/typesPropertyUi.js\":\"80f855da95411d8a\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/AddPropertyForm.js\":\"7e9b02dbf36699d0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/PropertyPicker.js\":\"7906ccd2db070421\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/PropertyRow.js\":\"76da53fa44eb8127\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/Rows.js\":\"5ba637258ab4f2e1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/actions.js\":\"87ad0f7e11f2ecb1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/declarationOnly.js\":\"bc55c55cfa7234b6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/layout.js\":\"1db190f38206834b\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/model.js\":\"d971c90e05023d98\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/shapeUi.js\":\"b0ebd9f1f43f776a\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/shapes.js\":\"7cfef0fffa7dd488\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/usePropertyEditingActivation.js\":\"46a5f80b4d30d88c\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanel/visibility.js\":\"45d8ae8b85141379\",\"/knowledge-medium/pr-preview/pr-1851/src/components/propertyPanelSections.js\":\"9ec3ac6e71dac6f6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/BlockEmbed.js\":\"202d889fc47ea4a9\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/BlockLink.js\":\"6dadf4bc1e15fd02\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/BlockRef.js\":\"c5cde0ce70d8e815\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/ReferenceLink.js\":\"d5eca2f2e17a7214\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/cycleGuard.js\":\"660ff45b1db95f05\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/cycleGuardContext.js\":\"0902440e8c83aab2\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/linkInteraction.js\":\"e3473476bb80cab0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/referenceLayout.js\":\"404d4a781368fa46\",\"/knowledge-medium/pr-preview/pr-1851/src/components/references/useBlockRefAncestors.js\":\"ff73b0b5189c2340\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BlockGutter.js\":\"22163f1174d32374\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BlockInfoDialog.js\":\"d53dad412901c3b3\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BlockTypeBlockRenderer.js\":\"535cbfc69f075cc0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/BulletHoverCard.js\":\"76fdd0042f4556d5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/CodeMirrorContentRenderer.js\":\"f21bc240d48278bd\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"600bcb8c89f4f5c4\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/ColumnResizeHandles.js\":\"2f799acdb54f429f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"59dffe84ac8021ba\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/DefaultBlockRenderer.js\":\"fcf029e28c066967\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/LayoutRenderer.js\":\"998be4f923111cb1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/MarkdownContentRenderer.js\":\"93941bd49a34f4f7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/MissingDataRenderer.js\":\"a319c2dbe10316b9\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/PanelRenderer.js\":\"857b1bf35915dffc\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3a44df9d1fdb5845\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/TopLevelRenderer.js\":\"01ecca06b84f7639\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/blockGutterMode.js\":\"e70ea7f59a0e822f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/blockTitleText.js\":\"a959edd86f09bc8e\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/fieldCreationKeydown.js\":\"af2d8f3aab9cbdce\",\"/knowledge-medium/pr-preview/pr-1851/src/components/renderer/layoutRootContext.js\":\"e96d6bcf413f54eb\",\"/knowledge-medium/pr-preview/pr-1851/src/components/typeChip/TypeChip.js\":\"d2f97183e4d805b2\",\"/knowledge-medium/pr-preview/pr-1851/src/components/typeChip/chipStyle.js\":\"0d73552c4ec455aa\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/anchored-floating.js\":\"7726f028e8623975\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/button.js\":\"77bd0778d1b64989\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/card.js\":\"3ff2d7675cc3d0de\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/checkbox.js\":\"9bb8b79bb52612a7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/collapsible.js\":\"509c23b34ba28ef9\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/command.js\":\"e3caf7cad1e1a8e8\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/context-menu.js\":\"0577b63be251f3e1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/dialog.js\":\"0085a903f2724e57\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/dropdown-menu.js\":\"c1b26712cd90dfed\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/floating-listbox.js\":\"6cb0a3ca999b534d\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/index.js\":\"6ef9f92d57c43682\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/input.js\":\"2ecdbcb93fe9a854\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/kbd.js\":\"6281817433377d2f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/label.js\":\"ab09d503d1eaf462\",\"/knowledge-medium/pr-preview/pr-1851/src/components/ui/textarea.js\":\"1e961387c92a585d\",\"/knowledge-medium/pr-preview/pr-1851/src/components/useEditModeYieldKeepalive.js\":\"81fa4e94d2c44c40\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/BootFallback.js\":\"4a9bf7fee59f90f6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/FocusedRowLazyMount.js\":\"cbfdb5328e10fdb0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/LazyViewportMount.js\":\"4945658c720dbec8\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/LocalDbCorruptionFallback.js\":\"8fd009f2861be50d\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/error.js\":\"eef088e5a8f80091\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/lazyMountRegistry.js\":\"a12cc6462e131080\",\"/knowledge-medium/pr-preview/pr-1851/src/components/util/suspense.js\":\"98f2d4c32bf9f5ca\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/CreateWorkspaceDialog.js\":\"fc666b1cb087ade7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/PendingInvitations.js\":\"f2aefaaff49540e5\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/SyncProgress.js\":\"06cbd29935957651\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/UnlockProgress.js\":\"232191421cee64d1\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceKeyGate.js\":\"9fd623da6dfc4568\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceSettingsDialog.js\":\"4a01fbfb261ad136\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceSwitcher.js\":\"be8646d97cacf889\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/WorkspaceSyncGate.js\":\"bf5ee17df0e3a2fe\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/ConversionFlow.js\":\"711ada72cfb084d4\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/ConversionFlowHost.js\":\"5b35d279a05451d7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/EncryptionSection.js\":\"f6e63124b5db06a7\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/attachmentPrompts.js\":\"4bed6438ec017fc4\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/bundleFolderPrompts.js\":\"25df024f65760028\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/conversionFlowDeps.js\":\"ba2f9d5aa750a4b6\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/conversionFlowStore.js\":\"629a85c687b14d43\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/flowUi.js\":\"9cd82af79ace368a\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/conversion/useConversionRun.js\":\"71f1f407541e0024\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/keyUi.js\":\"1d98a32a97208951\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/useCloseOnKeyLoss.js\":\"9919a86b3b358e4f\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/useCloseOnServerE2ee.js\":\"7ffbbd6e147532d0\",\"/knowledge-medium/pr-preview/pr-1851/src/components/workspace/workspaceUnlocked.js\":\"1c9e566eb85d1bc4\",\"/knowledge-medium/pr-preview/pr-1851/src/context/backgroundSubtree.js\":\"2546daea175ee1b0\",\"/knowledge-medium/pr-preview/pr-1851/src/context/block.js\":\"69fcb2208438ab65\",\"/knowledge-medium/pr-preview/pr-1851/src/context/layoutWsContext.js\":\"d8f35a110d547923\",\"/knowledge-medium/pr-preview/pr-1851/src/context/propertyDisplay.js\":\"a470d795f6b19f74\",\"/knowledge-medium/pr-preview/pr-1851/src/context/repo.js\":\"1ec93c44c4644f72\",\"/knowledge-medium/pr-preview/pr-1851/src/data/aliasClaim.js\":\"2b94582978a9d229\",\"/knowledge-medium/pr-preview/pr-1851/src/data/aliasSeatNamespace.js\":\"be588508061e8b91\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/blockData.js\":\"95f59acd6d3ef844\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/blockType.js\":\"5cc5065a5bf6ae1b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/changeScope.js\":\"93138509e7724ff6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/codecs.js\":\"408e3cc161538bd6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/derivedData.js\":\"238f6b4d5898a1ff\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/errors.js\":\"0b7649ecb2efb0a4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/events.js\":\"8d205cb1a81c0422\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/handle.js\":\"4e740ac8c0246812\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/index.js\":\"fceda621ee671f70\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/mutator.js\":\"3e916d238c85ddcb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/processor.js\":\"b99cea3767745e47\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/propertySchema.js\":\"af766b375853b75a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/query.js\":\"38421e51a34df9d1\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/sameTxProcessor.js\":\"c4b44de9c35b7cd8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/schema.js\":\"4e740ac8c0246812\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/tx.js\":\"4e740ac8c0246812\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/typedBlockQuery.js\":\"919b745f5400e842\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/user.js\":\"3bc4bcb287a98b25\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/valuePresetCore.js\":\"810001b0dcf6db12\",\"/knowledge-medium/pr-preview/pr-1851/src/data/api/valuePresets.js\":\"a61b22c5a3b132e8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/attachmentCleanerIOVerb.js\":\"40b301b3fc8479a7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/block.js\":\"af752b97efff8f80\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockCache.js\":\"a4b649c266c85989\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockId.js\":\"4bc6ce418a52e867\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockLiveness.js\":\"ae96da02d616e748\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockMerge.js\":\"df576c199c41a87e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockSchema.js\":\"d37ea166c0816e16\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockTypeLookup.js\":\"1f590ec4a6f02326\",\"/knowledge-medium/pr-preview/pr-1851/src/data/blockTypes.js\":\"b06980257a2bf595\",\"/knowledge-medium/pr-preview/pr-1851/src/data/clientContext.js\":\"07c30b5d7ddd5906\",\"/knowledge-medium/pr-preview/pr-1851/src/data/dbFileSiblings.js\":\"e9774f0295f2e0a0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/definitionSeeds.js\":\"17c0113c9576fa23\",\"/knowledge-medium/pr-preview/pr-1851/src/data/derivedIds.js\":\"6837b97300e13fb2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/drawnSubtree.js\":\"e9f06a74bd959f8b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/facetBridge.js\":\"f55c61f757904338\",\"/knowledge-medium/pr-preview/pr-1851/src/data/facets.js\":\"d13bfba5bd5eab71\",\"/knowledge-medium/pr-preview/pr-1851/src/data/globalState.js\":\"eb39d1ba878ae35f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/aliasClaimRederiveProcessor.js\":\"5139c0633aac2fc9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/ancestorBatch.js\":\"db633b545575c4b0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/blockTypeTypeifyProcessor.js\":\"0ed57de8ee94c45a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/clientSchema.js\":\"e5eb43914f511cf5\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/commitPipeline.js\":\"fb80045ef360f42e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/devAssertions.js\":\"6d23a8561b2155f9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/firstSync.js\":\"5d0635a297639b70\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/freshInitialLoad.js\":\"445498f605ee3893\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/graphBackfillClaim.js\":\"fff9755ed24dd0ec\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/handleStore.js\":\"0a42f15d2e40c90e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/idleMarkerJobs.js\":\"c93d610c7c835abb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/initialDownload.js\":\"cb3cd1e9d868cff8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/initializeClientDatabase.js\":\"6d5a029160a8b367\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/jsonCanonical.js\":\"0204201551e0cde9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/kernelInvalidation.js\":\"c121ced56f5415e8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/kernelProcessors.js\":\"527ea6034ee990c7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/kernelQueries.js\":\"5a24ba3c46c5ee4c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/mergeTypeMembershipProcessor.js\":\"9bf1bf15e6c36d9d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/normalizeReferencesProcessor.js\":\"a6d492af34320467\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/poolInstrumentation.js\":\"56cc0a0f92611f00\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/processorRunner.js\":\"938ac96065388e52\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyCellBackfill.js\":\"7ffd89b24f4f0473\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyChildMint.js\":\"4f054ffab4f5eefe\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyChildrenProcessor.js\":\"edfdfa7365ec65a7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8788c1bcacd06620\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyDefinitionSynthesis.js\":\"7c422a47d619a38b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyKeyScan.js\":\"96ae812e8ecbbbd4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertySchemaResolution.js\":\"3f41eb44a749cc4a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/propertyValueEdits.js\":\"a24ae49bf98fd287\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/raiseProtocol.js\":\"cf9808ed2cef87f8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/readBatch.js\":\"8bcf0ddb447a69a9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/refProjection.js\":\"d9bf73500cf771d8\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/referenceTargetLookups.js\":\"926f699b48b62969\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/referenceTargetProcessor.js\":\"2c769b0289b68f90\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/replayMerge.js\":\"48dead215bade5b6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/sqlBinds.js\":\"98d6b75b4f0ea1ba\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0160c976cb29c073\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/arrivalProcessors.js\":\"9a3a3992426fd039\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/invalidate.js\":\"5215c091d265c772\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/materialize.js\":\"cb3754bb4de3418e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/observer.js\":\"947d3336f39a3925\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/syncObserver/reconcile.js\":\"6ed99c06b3ca4e8c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/timingMetrics.js\":\"afd1cb47a05b78d5\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/treeQueries.js\":\"f0f8b286e639c326\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/txEngine.js\":\"4d557987ea2ec228\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/txSnapshots.js\":\"86a4bd2d526bf310\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/typedBlockQuery.js\":\"f3da6c3d54a755eb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/internals/undoManager.js\":\"23967f01b951256f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/invalidation.js\":\"99fed8479ad8f51d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/kernelDataExtension.js\":\"080b9d2a838a9e1e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/kernelPage.js\":\"28eec0d68135eac6\",\"/knowledge-medium/pr-preview/pr-1851/src/data/kernelValuePresetCores.js\":\"0ee0c5b13e5f45c1\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localDbCorruptionSignal.js\":\"c03c5678f120130e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localDbStorage.js\":\"8675254370ab4adf\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localDbVfs.js\":\"2ef34dc056c81227\",\"/knowledge-medium/pr-preview/pr-1851/src/data/localSchema.js\":\"ef6c396d207a5212\",\"/knowledge-medium/pr-preview/pr-1851/src/data/maintenance.js\":\"eb0fc22814195180\",\"/knowledge-medium/pr-preview/pr-1851/src/data/mergeProperties.js\":\"6787210018ee3779\",\"/knowledge-medium/pr-preview/pr-1851/src/data/metricsConsoleHook.js\":\"a564d01e18ad4087\",\"/knowledge-medium/pr-preview/pr-1851/src/data/migrationsPage.js\":\"c3e9129a96ed4700\",\"/knowledge-medium/pr-preview/pr-1851/src/data/mutators.js\":\"6af9eb2c8526edaf\",\"/knowledge-medium/pr-preview/pr-1851/src/data/orderKey.js\":\"c5ad9cabd58b3220\",\"/knowledge-medium/pr-preview/pr-1851/src/data/orderKeyPlacement.js\":\"969fbb0ed5f1033d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/outlineSurface.js\":\"db09aa9129592afe\",\"/knowledge-medium/pr-preview/pr-1851/src/data/pendingEditorContent.js\":\"3aa4fd694100f1a4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/pendingUploadsSql.js\":\"237eac286718e6f9\",\"/knowledge-medium/pr-preview/pr-1851/src/data/pluginStateExtensions.js\":\"579400063f1d046f\",\"/knowledge-medium/pr-preview/pr-1851/src/data/powerSyncLogger.js\":\"0ac12b9113595dc7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/projectorRuntime.js\":\"8cc7c8dda0475fc7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/properties.js\":\"3c1fc716e3952e33\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertiesPage.js\":\"de2260dde850c028\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyChildren.js\":\"f39b96b2d0d2c4d0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDefinitionFanout.js\":\"0cc9ec990723b9e7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDefinitionMetadata.js\":\"5d35a71e21c5de0c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDefinitionRegistry.js\":\"ea53f1896531acdb\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyDisplayMode.js\":\"a401e5e582d87f3d\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertyRowCreation.js\":\"1dd2fbdd6b8cee5b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertySchemaCreation.js\":\"59da714463024d2a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/propertySeeds.js\":\"149c42ae24ec2c35\",\"/knowledge-medium/pr-preview/pr-1851/src/data/recentsPage.js\":\"96112ddad16c8cea\",\"/knowledge-medium/pr-preview/pr-1851/src/data/referenceBlock.js\":\"ce83e8ac3616f076\",\"/knowledge-medium/pr-preview/pr-1851/src/data/rejectedUploads.js\":\"d932c22685dbe960\",\"/knowledge-medium/pr-preview/pr-1851/src/data/releasePowerSyncConnection.js\":\"16936922a67e5614\",\"/knowledge-medium/pr-preview/pr-1851/src/data/repo.js\":\"4d00fa1ff076e432\",\"/knowledge-medium/pr-preview/pr-1851/src/data/repoProvider.js\":\"804d8b99437209db\",\"/knowledge-medium/pr-preview/pr-1851/src/data/rowProperty.js\":\"d51011917a6cafd4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/searchFilter.js\":\"9a8620f95ca7cda4\",\"/knowledge-medium/pr-preview/pr-1851/src/data/seedIdentityLedger.js\":\"970c8a1fa274bb0e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/stateBlocks.js\":\"64258846e61ede43\",\"/knowledge-medium/pr-preview/pr-1851/src/data/structuralEditPolicy.js\":\"5c706b4df297f6f5\",\"/knowledge-medium/pr-preview/pr-1851/src/data/subtreeDelete.js\":\"57fbdd24bf39c1cd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/syncStreamLock.js\":\"1920517eb13cfbaa\",\"/knowledge-medium/pr-preview/pr-1851/src/data/syncedTableSqlRecognizer.js\":\"1035bf9d79a99622\",\"/knowledge-medium/pr-preview/pr-1851/src/data/syncedTableWriteGuard.js\":\"d708ac0a352a4877\",\"/knowledge-medium/pr-preview/pr-1851/src/data/targets.js\":\"e2a5f25fe9dabc98\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeColors.js\":\"eb0e76894a447c93\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeDefinitionMetadata.js\":\"d77f09d4abde01e2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeDefinitionRegistry.js\":\"a32318ae9874e449\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeExtraction.js\":\"04a488f7685a5875\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeInitialValues.js\":\"a4fd137cae2a44ed\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typePropertyGroups.js\":\"e704c0fea747d723\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeSeeds.js\":\"734e25d81d2c83f7\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typeTagger.js\":\"a538363379317b5e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typedRecords.js\":\"6d1f0694cdc35e0b\",\"/knowledge-medium/pr-preview/pr-1851/src/data/typesPage.js\":\"1b6ecccffcc3bee0\",\"/knowledge-medium/pr-preview/pr-1851/src/data/userPrefs.js\":\"2bea54d9d9aad48c\",\"/knowledge-medium/pr-preview/pr-1851/src/data/userSchemasService.js\":\"7ea9fbd29a0686dc\",\"/knowledge-medium/pr-preview/pr-1851/src/data/userTypesService.js\":\"dcd1b748e8f49fdd\",\"/knowledge-medium/pr-preview/pr-1851/src/data/valuePresetRegistry.js\":\"e92257f06037801a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/visibleChildren.js\":\"4acd5b166c939592\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceConversion.js\":\"9a4287dd85fb845a\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceFirstSync.js\":\"07a790434498e96e\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceIdNamespace.js\":\"c8a18846fd517724\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaceSchema.js\":\"bb030f1a0f8d4df2\",\"/knowledge-medium/pr-preview/pr-1851/src/data/workspaces.js\":\"1a18b3fc038bf152\",\"/knowledge-medium/pr-preview/pr-1851/src/data/writeAheadLog.js\":\"49aac244ef655dce\",\"/knowledge-medium/pr-preview/pr-1851/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/BlockPasteShellDecorator.js\":\"6b77b6cee627c4a8\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/atTrigger.js\":\"da600ed3ab96d29a\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/autocomplete.js\":\"b41be71c070065da\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/codeMirrorExtensions.js\":\"2a3f4040b4e50452\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/contentFlush.js\":\"655409ec23146a89\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/defaultInteractions.js\":\"17f1d2ea5fc31410\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/editSettleSignal.js\":\"11bb40d6566ce9ee\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/insertImage.js\":\"8509bc2e50cbfb9e\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/referenceCompletionRange.js\":\"3fb2dfdc13e2be1e\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/referenceTargetTypes.js\":\"5cb8ab2b4c30528a\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/syntaxContext.js\":\"037bdc66a0a52e09\",\"/knowledge-medium/pr-preview/pr-1851/src/editor/triggerMatch.js\":\"9ee05e650cc9b00c\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/AppRuntimeProvider.js\":\"88750ce684bada80\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/BlockFocusShellDecorator.js\":\"dbd95f30a66f6e06\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/ExtensionRenderBoundary.js\":\"ce269ffe5f96529f\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/PanelContentRecovery.js\":\"c51c7d8a7411bcd5\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/apiCatalog.js\":\"e450a764bf58d839\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/approveExtensionHere.js\":\"e46427ca37135c72\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/armedCutAppMount.js\":\"456c1d3f1c5bbb34\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/batchableKeyedStore.js\":\"8f32eda864d3a0e3\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/blockInteraction.js\":\"39dfb5335de6c506\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/blockSelectionAction.js\":\"d133f2290b497b81\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/compileExtensionModule.js\":\"b6e5cfb6bb93a734\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/compiledModuleCache.js\":\"f3ccf325fc4f77f9\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/continuousGestures.js\":\"30dad00fe8d3e1be\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/core.js\":\"13a98f9a84c90331\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/defaultRenderers.js\":\"5065590df6756aa8\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/definitionFanoutAppMount.js\":\"4621d6d5e51424d3\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/dialogAppMount.js\":\"7e68b2bcd30017f8\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/dynamicExtensionSeeds.js\":\"89607f663f41d268\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/dynamicExtensions.js\":\"7b0143fea4d9c8f5\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/exampleExtensions.js\":\"81ed044d1ad573f2\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionApprovalStatus.js\":\"0a92a98eee47e976\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionLoadErrorToast.js\":\"7bd3ec4751f2d30f\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionLoadErrors.js\":\"1ea1cf5339df193a\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionLookup.js\":\"f2799644781a3962\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionToggles.js\":\"1e61a554121a0356\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/extensionUtilitiesCss.js\":\"5a759d5927f8e811\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/kernelPageDeletionGuard.js\":\"c0ff2c8a1632a529\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/liveRuntime.js\":\"e0da0f504210dbe3\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/openExtensionsSettings.js\":\"502604e84d26aa5b\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/overridesCache.js\":\"41b21d652d6f74de\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/pluginIds.js\":\"525eefd54991cc51\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/processorRejectionToast.js\":\"a0d2d5eff7d176d3\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/runtimeActions.js\":\"0a3da4befc33765d\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/runtimeContext.js\":\"f4b6cfb01dcdd770\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/staticAppExtensions.js\":\"2ff437d154e5aea2\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/staticDataExtensions.js\":\"4b8c2118669b472a\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/toastAppMount.js\":\"b2d5963915db6c3a\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/useOverrides.js\":\"9d16658a45b056b1\",\"/knowledge-medium/pr-preview/pr-1851/src/extensions/useShortcutSurfaceActivations.js\":\"32b9dd9e51f94bda\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/discoverToggleTree.js\":\"0c098e1df6463b09\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/facet.js\":\"e1a9ca7969dc7727\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/resolveAppRuntime.js\":\"3826cd8245012f14\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/runtimeEvents.js\":\"c30f095acfcd0a20\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/togglable.js\":\"f72df5a3045ae42b\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/variantFacet.js\":\"65473e7f3abd7ed5\",\"/knowledge-medium/pr-preview/pr-1851/src/facets/verbFacet.js\":\"affa01d30a7f0627\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/block.js\":\"d73c4e8feff12a6f\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/focusedChild.js\":\"9fb6f9e17106b3c2\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/propertySchemas.js\":\"d2ccabeabd2a62d3\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/typeRegistry.js\":\"972b9e3c2580e39e\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useAncestorCrumbs.js\":\"3705fb9674708c6f\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useAutocompleteListbox.js\":\"081a7ff5225280ae\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useDebouncedSearch.js\":\"a24c0402a8bb6e53\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useDebouncedValue.js\":\"94e91c17a1fde532\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useIsFocalRender.js\":\"67a608d9b42f86de\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useIsReadOnly.js\":\"370014aadddefbf5\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useMaterializeBacklog.js\":\"968e478b62bce6db\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useMinuteClock.js\":\"713e669e64a25aca\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/usePanelLayoutProjection.js\":\"bc150c1da9322b7a\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/usePendingInvitations.js\":\"528a25c6ff0fb906\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useRendererRegistry.js\":\"1580eeaddb7f07b0\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useRetainedFieldRows.js\":\"8954fd411de09cf4\",\"/knowledge-medium/pr-preview/pr-1851/src/hooks/useWorkspaces.js\":\"0061fe941f6536f7\",\"/knowledge-medium/pr-preview/pr-1851/src/lib/utils.js\":\"a74fbc13d0de6ba6\",\"/knowledge-medium/pr-preview/pr-1851/src/main.js\":\"5db488c5218c667b\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/MarkdownImage.js\":\"e9b81d511571f774\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/blockSeparators.js\":\"b9c26b2639afc413\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/context.js\":\"9216e8a289b23243\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/defaultMarkdownExtension.js\":\"1fce3cf50b811838\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/extensions.js\":\"118cbee54199dd9b\",\"/knowledge-medium/pr-preview/pr-1851/src/markdown/renderMarkdownHtml.js\":\"1fe2e9ea9340bbe0\",\"/knowledge-medium/pr-preview/pr-1851/src/minimal-editor.js\":\"93fe310ab0ad7ce2\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/armedCut.js\":\"07bc92e138255662\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/captureMediaVerb.js\":\"d0cb5af436d4c615\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/clipboard.js\":\"4776860dac382548\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/decision.js\":\"34412a0cd386c319\",\"/knowledge-medium/pr-preview/pr-1851/src/paste/operations.js\":\"15390c3d757d908a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/account-header/AccountHeaderItem.js\":\"3b1074565f8f4950\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/account-header/index.js\":\"01136fa86edb36cf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ce703210128f5da2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/askAgent.js\":\"6c79b3a0d0f13810\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/askedStore.js\":\"62a5b907bf093eb3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ba5e31f1c6c81264\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/chipState.js\":\"ea803f51ef144e92\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/dataExtension.js\":\"684534149d838793\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/index.js\":\"61f2b99c9b3f7827\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"aa80d19e56746bd7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-dispatch-companion/schema.js\":\"6246a1999dbc738c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5888858611ae5326\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/BridgePairingDialog.js\":\"87b1afae123fc133\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/addMedia.js\":\"666e46d7f188b8d0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0e2b271f72d8c7cf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/block.js\":\"4de52f7de338bca0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/context.js\":\"ffa6de0100c9d080\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9b13b85e247c72e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/index.js\":\"d6d9cc4300497f9e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/outline.js\":\"8416971092059814\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/properties.js\":\"3ef435e8f8102464\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/refs.js\":\"a809719b4261d693\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1be8bcf8ebe22827\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/search.js\":\"07cbf0cd2d0ce466\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/shared.js\":\"9e31e48b0a7d16e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"67590ab4670e41f0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentViews/text.js\":\"b0110ef89fca83dd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/agentWrites.js\":\"e3bdd0a7e4bd1e67\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/authoringCatalog.js\":\"035c59e685a0cab1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/blockRefTargets.js\":\"c986591537374d7b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/bridge.js\":\"fed35a72a9d2513d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/bridgeLoop.js\":\"5a7403dc7d298137\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/changeHistory.js\":\"69a98d051e73655b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/commands.js\":\"583487c1bce7350c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/commentsCommands.js\":\"f314109455acd9e5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/dataExtension.js\":\"0793b22a391b480c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/dataModelGuide.js\":\"f6437e72b4c617fd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/describeRuntime.js\":\"3dda5f1fbec27da0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/extensionLint.js\":\"485a8af77b9e62fe\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/grainAudit.js\":\"b12e59c99c89e4ef\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/healthCommand.js\":\"30d3c111897c55e6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/index.js\":\"1a6ad5939e5fb8c6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/presetIdentity.js\":\"74b1ff4185bfcfed\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"659b1726ff7a2b36\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/readMedia.js\":\"112a3a6122d4500b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/schema.js\":\"b52a5e475bf0cdaf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/serialization.js\":\"6458e8f6b5406b94\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/targets.js\":\"87fb1a640d983b7f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/tokens.js\":\"17dd07abc5116130\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/watchEvents.js\":\"ba37a2580054dcac\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/workspaceGuard.js\":\"d29924c353eabd04\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/agent-runtime/writeCommands.js\":\"5c4de1aff1a941c4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/AliasCollisionToast.js\":\"096dd127d7005767\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/DuplicateNameBanner.js\":\"db5e5931afbac88b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/collisionMerge.js\":\"29b150d9739d31e2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/dataExtension.js\":\"ffda8dc44cb1dd12\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/index.js\":\"705b16db1a76a7ad\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/mergeCollisionAction.js\":\"edb3cee68df360e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/pageStyling.js\":\"2e289b109b593254\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/rejectionToast.js\":\"225f70ace5ffb387\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/alias/syncProcessor.js\":\"184658ade8859a4a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/actions.js\":\"c8daa56180416a58\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/addComment.js\":\"dababd3de66bac29\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/anchor.js\":\"58af2cc0074967cc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/anchorState.js\":\"d9d5221fdc5c4ea0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/commentLinks.js\":\"e326dcce1211b36a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/confirmThreadDeletion.js\":\"b1ef1d5dbc1cb3a7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/container.js\":\"f7178a09c1c5f764\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/dataExtension.js\":\"9684c6f0d3a29c42\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/deleteComment.js\":\"68560c44192fda22\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/highlights.js\":\"1b9005d4de228493\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/index.js\":\"b176d6b51fa175a9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/linkedCommentsPill.js\":\"6ba45431285d6581\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/margin.js\":\"d75b458d58fe1ad8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/marginSchema.js\":\"f0a245cc52e9c452\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/newComment.js\":\"edd61c58013f6eb7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/ownThreadPicker.js\":\"3a9567d780a3d4da\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/placement.js\":\"0f2ce370ebc95c70\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/queries.js\":\"f7a73eb3e6742815\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/quotePosition.js\":\"b1a1d791760ca47d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/quotedIn.js\":\"c711eb17d56f2ab6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/quotedRange.js\":\"d5c45800e668b0c9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/rangeRefs.js\":\"eacbca318d312dc1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/readHighlights.js\":\"784065344f4a461a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/readSelection.js\":\"e8e5248c7e1a0f36\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/readSelectionUi.js\":\"00380833fb50aea4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/reanchor.js\":\"69d51204e7579bff\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/schema.js\":\"132bc48b6926ef7e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/scope.js\":\"34b1b19014c63e7a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/scopeThreads.js\":\"d335043de8e330bd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/splitRetarget.js\":\"7d0142903f3eb9fb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/suggestionCard.js\":\"692f4c0a2fb0d587\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/suggestions.js\":\"37f252968652b7f7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/summaries.js\":\"2043bade578223fc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/summaryBatch.js\":\"43772f96c0f0b02d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/surface.js\":\"b3db466069a4bb85\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/threadNavigation.js\":\"c161e8514def30a4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/threads.js\":\"48e6dabf00491142\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/ui.js\":\"11aafec415421f2c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/annotations/uiStore.js\":\"a67f39b44cda1881\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-intents/appIntents.js\":\"8c011aec8d8533dc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-intents/index.js\":\"269fc77d3775e328\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-update-prompt/index.js\":\"37d6f7f08d65b8d8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/app-update-prompt/status.js\":\"e14cfb9fde4a234b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"076157d2953dc23b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/MediaBlockRenderer.js\":\"d019baba6465a691\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/MediaDownLaneReplicator.js\":\"57a263b60e37b9e6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/MediaUploadReconciler.js\":\"4c987ae81250841b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/assetDownLane.js\":\"48456d9d775de817\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/assetResolver.js\":\"945753e4f34a100d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/assetUpload.js\":\"3b19674dcf68cf11\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/attachmentCleanerIO.js\":\"dc6b56c4fc0fdcf3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e1729cd5fb6eb346\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/blobStore.js\":\"2078a1669f610912\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/byteStore.js\":\"afd261514d0dca57\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/cleanerIO.js\":\"16c443af15f256fe\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/cleanupAttachments.js\":\"e8bab7060ecad6f0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/dataExtension.js\":\"9bed191c4053e49c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/downLane.js\":\"9280244f2b40414a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/index.js\":\"59e1779f8a0136c2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/insertImageContribution.js\":\"2a4ae013470ce642\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/laneArming.js\":\"a1a41072db071c32\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/laneLock.js\":\"600270dfb8b3be0e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaBlock.js\":\"40a1ef3b77d45441\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaCapture.js\":\"70f1e6f7d1a5cf7a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaViewers.js\":\"27d2cca49e042b5c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/mediaViewersFacet.js\":\"b79a873e11631d36\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/pasteCapture.js\":\"83732e4313738800\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/resolver.js\":\"c34252e9dba15d98\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/retryUploadsAction.js\":\"c108727fe32cd43b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/storagePaths.js\":\"bea6afe94a47d556\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadDrain.js\":\"964cedf1c1f317fa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadLaneStatus.js\":\"2f6e904d2e31cd40\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadReconcile.js\":\"42d6707255ea5f21\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadRecovery.js\":\"b455f5594f2bdf58\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/uploadStore.js\":\"2c5bce2abc6e47e3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/attachments/useAssetObjectUrl.js\":\"8bb3b221843a7fc5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5e4445dc71dcbec4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/BacklinksViewSection.js\":\"40d91ec11179ec3f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/facet.js\":\"649c36688b15d5a4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/index.js\":\"38e893d78abe927c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks-view/prop.js\":\"b24ce630fef7d217\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/BacklinkFilters.js\":\"736a647cb6b70bf9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a1d5f5ea3773b178\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/BlockEntry.js\":\"fbbf5b560598025a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/LinkedReferences.js\":\"60250b3ff69c8fe8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7b2306f4e990037d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/dailyNoteDefaults.js\":\"ad6f416cb52324b6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/dataExtension.js\":\"1acc29929660a2d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/edgeExclusions.js\":\"162fcb0452c3276c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/filterProperty.js\":\"fdccf4ba92728578\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/index.js\":\"7f655c4a5ac5a794\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cf853702bcc7329b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/applies.js\":\"de16e4dacddd9cf1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/countQuery.js\":\"483ec5e60406d72f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/expansionStore.js\":\"aedfdb2f1e079507\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/index.js\":\"ea51dec9d780c38b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d5e0a5292d3d76e3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/presentationInvalidation.js\":\"9afec55a813b6456\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/propertyEditorOverride.js\":\"e7e95e246f78c4da\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/propertyFilter.js\":\"c1554da86a85ba29\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/query.js\":\"2a91fcf1fc6b3203\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/resolveFilter.js\":\"be2f6a15d8050b94\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/sourceBatch.js\":\"30f39ced89e6fd71\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/sources.js\":\"339caeb2e66ca4d7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/useBacklinks.js\":\"0e68877ebacdaba9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bde2e83c87c2fa6e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/BirthdayCelebration.js\":\"0d16cc107fb3f6a8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/BirthdayOverlay.js\":\"e48f92792ad7e9a4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/gate.js\":\"8da7956353d0f108\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/index.js\":\"f48cfb7f8379b6d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/birthday/wolfTheme.js\":\"5ba33aeb1e65b024\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/BlockDragLayer.js\":\"0d8cb8816dd20976\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/dragController.js\":\"320d60998fe59baa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/dropTarget.js\":\"9a137dcc1cbefd30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/index.js\":\"0c0bf8b7e9b325b1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-drag/projection.js\":\"a07484c8d9b8a072\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-info/BlockMetaCard.js\":\"70f7d9e5d7c902d1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-info/index.js\":\"04e202bde0cfe4fb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/AddTagDialog.js\":\"bc9591f53d05ca86\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1961e45bb2bb6f98\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/TagNameIssueHint.js\":\"d09cea544aa1725e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/addTagAction.js\":\"20ae39088b6196db\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/appendTag.js\":\"a5e49296a5866812\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/config.js\":\"63952fe899966bf4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/dataExtension.js\":\"a89b4225072bdf7e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/index.js\":\"0235ab8064a19754\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/block-tagging/propertyEditorOverride.js\":\"282b30ea22f4720c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c1bb62593ea3354f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0254abe90b813196\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8f35d674c1887f74\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fb0f5c2b3c328035\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2a9e891309ba61ad\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/index.js\":\"e528621b2957b7a5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5b33b45ecc319d11\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/CharacterCountItem.js\":\"e733c11a05e7a013\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2d72503b1d684dad\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/actions.js\":\"a7d0331044ee77e5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/blockType.js\":\"f8b49037437e1b3e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/charCount.js\":\"fde9739724c3d1b0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/dataExtension.js\":\"ffd3cb8cb9148c23\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/index.js\":\"4bf9d752a271f8de\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/profiles.js\":\"6e9813ce9a349372\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/properties.js\":\"86518b98519604a8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/character-counter/textCounts.js\":\"e67d3b7278c0cd3f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/colemak-keybindings/index.js\":\"30c557d6da5414bd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/CommandPalette.js\":\"fa0132cbb317ed45\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/HeaderItem.js\":\"849d39f06200c553\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/context.js\":\"0d420fcbc257403c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/index.js\":\"99a83d7c48ede516\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/selection.js\":\"bb5cdf31c38b922f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/toggleStore.js\":\"72c68dea039e02e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/command-palette/useCommandPaletteActions.js\":\"df25f76142d4d7c9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/ContributorBadges.js\":\"3228ec917c4f2a6e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/author.js\":\"14f1b218dfd899af\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/codeMirrorExtensions.js\":\"7142f1c8aebb58fa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/dataExtension.js\":\"4ec05bca93c01dc4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/index.js\":\"46d7dc5b888fa0a4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/mentionAutocomplete.js\":\"93db3a07a183f80b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/processor.js\":\"f4f82327f1514e2e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/profiles.js\":\"d2fe0892ed311564\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/queries.js\":\"32c3812d989974ea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/contributors/schema.js\":\"be9bc455c19f1f27\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ec946aef29942d9f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ca04821483ec2faf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/index.js\":\"582e6bbf18f33ab7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e13a9717d0223cd4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"518220bf6621870f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/CalendarGrid.js\":\"bcf9167b69b46406\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DailyNotePicker.js\":\"cdeb385a462d56a0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"17c7d0867cd17d71\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DateNavDecorator.js\":\"c90312e4666d64d1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/DateScrubOverlay.js\":\"d71fbe4731bdbcd8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/HeaderItem.js\":\"bbd8ff3afb8f0b02\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/ReschedulePicker.js\":\"0ee0863dc212ae16\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bc565f7380dbf48e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/actions.js\":\"b9dead263d804f9f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/blockDateAdapter.js\":\"4163c4687b4f0faf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/calendar.js\":\"485f09159c213e0a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dailyNotes.js\":\"b31a6b84c5d74bb8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dataExtension.js\":\"9af1b95c89340ce0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubActions.js\":\"d799aaa009e3d65c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubGesture.js\":\"d052ee88e85d7b55\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ebd218786dd6d42a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3bc84e97fa0af03b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/deletionGuard.js\":\"ea6b59dd9c53d300\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/dueQuery.js\":\"d8d303c067c91f05\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/index.js\":\"0f0b08c6bdda32b8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/landing.js\":\"21cec7667bb47206\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/localSchema.js\":\"14df08653b98bf90\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/referenceDateAdapter.js\":\"27229659f81c4bfc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/rescheduleAction.js\":\"7eb9fab3c57d2213\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/schema.js\":\"9a9a246133faf17e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/spreadBlockDates.js\":\"a0b4cd3d137a8a0f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/spreadDatesAction.js\":\"9859d042c5af93d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/today.js\":\"913221b6a1a0ce80\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0dceab61e2585f00\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"091219d36a5c521c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/audit.js\":\"cc4d2c21ef6ce4ab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/auditAction.js\":\"bed625acb4134922\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/auditRanges.js\":\"32fcf08d8d162610\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/diagnosticsSource.js\":\"3cb841d7756affcd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/divergenceScan.js\":\"59d0f208a85f2894\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/index.js\":\"ea06abaf73bbf046\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7876b6337089f226\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/referencesMirror.js\":\"757f026bf59d15b4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/rowJson.js\":\"67a4f8398a6c66e1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/schedule.js\":\"7200ad120ad8bb7f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/data-integrity/store.js\":\"1154a29a5a173318\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-maintenance/action.js\":\"2f403a58a238a46a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-maintenance/index.js\":\"d2389b1b001179ba\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-maintenance/plugin.js\":\"510db4a8ab2b3fea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3d683464e87d6986\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/actions.js\":\"b176505a91229975\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/changeMarker.js\":\"daa8feea58ed04fe\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/diagnostics.js\":\"8941fabd27e62526\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/fileSystemAccess.js\":\"9b85e7d462fa1bd3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/filenames.js\":\"05f1662886643fe5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/index.js\":\"a7d323b70e1f806b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/mirror.js\":\"364076093c8d5069\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/runLock.js\":\"f29eb0d77166aa1b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/runtimeHealth.js\":\"fa9cb42403d1d5b5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/schedule.js\":\"d93ecd1dc99157cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/db-mirror/store.js\":\"edbc1f974eba20f0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/default-themes/index.js\":\"0717d484b556123d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/default-themes/themes.js\":\"c8f4145a860eaff9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/diagnostics/facet.js\":\"f8f74d57c5ee8bb1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/diagnostics/useDiagnostics.js\":\"2a7d8143a3942ff9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/dismissals.js\":\"aa089e2bb861bd19\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/index.js\":\"e266ab1bd946af59\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/status.js\":\"8ad9affeff232d54\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extension-prompts/store.js\":\"4e340bf18ab5481a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0ae945541b6e3373\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9e05ac0a7c37901d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/actions.js\":\"27ce913f0d1f996b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/config.js\":\"15c3b4775078b315\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/dataExtension.js\":\"30259fbf89af9a43\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/effect.js\":\"ef9cc92fed7d7bd8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/index.js\":\"ba22e41011c82650\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/propertyEditorOverride.js\":\"caf027f46b290911\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extensions-settings/useToggleTree.js\":\"81a563f899a67343\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/ExtractTypeDialog.js\":\"8c323e0c25581bb3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"23c390081593fff1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/PropertyShapePicker.js\":\"0d9ce493b99733f3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/action.js\":\"d053d1bc23bd52d8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/extract-type/index.js\":\"99c607cc89601d34\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/FindReplaceDialog.js\":\"4c00ecf6cb2e1da6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/HeaderItem.js\":\"c4bf8e0e46b1a260\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/dataExtension.js\":\"1d0a156bcb4e16be\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/index.js\":\"9ebdcb9ac15a8eda\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/search.js\":\"61aeda3cad1308d8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/toggleStore.js\":\"85fc3ab7cb5d0acd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/LocationPropertyEditor.js\":\"f9d396dfa6f9963c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/MapView.js\":\"86106fbb14a1d759\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/blockTypes.js\":\"aaff20c93b8b4e9a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/codeMirrorExtensions.js\":\"d5f2b8b8d40c46b7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/createOrFindPlace.js\":\"5882c083141c128c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/currentLocation.js\":\"f21912c514250bc0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/dataExtension.js\":\"728459fecbda9953\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/geoContentDecorator.js\":\"ca063b228f94e1f0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/googlePlacesClient.js\":\"7abfcb4c38663838\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/index.js\":\"b04978c5dd80984d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/locationsPage.js\":\"5c2a1fa8f7de1cb8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/mapViewport.js\":\"a0a01b661e7900ca\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/pickCurrentLocation.js\":\"66744abe17aa2677\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/placeAutocomplete.js\":\"9a84553c818cb1a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/placeNameCollision.js\":\"293462d608fab8a1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/properties.js\":\"a6b6b86e62683375\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/propertyEditorOverrides.js\":\"50613589cc3ca4b6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/query.js\":\"9e6ed4b2893c7bb3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/geo/usePlaceSearch.js\":\"7235986d86ecdaa6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"931c49fda73f8827\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7f8f2b2ec25cc760\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d40071943874c0c5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/config.js\":\"b5ee4d48af6f0f2b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/dataExtension.js\":\"86a8e0672b101831\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/facet.js\":\"6625415e9405da81\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/grouping.js\":\"3911108c0f13e7f0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/index.js\":\"e4694028b1a44f29\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"547271c5c50bd5d9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/query.js\":\"4572aef3e9d85eaa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/resolveConfig.js\":\"08b395b0aec644a1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6e7384e3737ebc22\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a1da648ab8bce75d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/HtmlDocumentContent.js\":\"44a593b4fcb80502\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/HtmlFrame.js\":\"24e63b5f69cac8a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/actions.js\":\"e6260aeb3a653daa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/blockType.js\":\"94e5e0e24bad333f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/confirmRunScripts.js\":\"262780ee090a0e3b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/dataExtension.js\":\"b4a419c4fec3ccdb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/frameAnnotations.js\":\"4cb4662f9191e13c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/frameDocument.js\":\"893479f2f425343d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/frameTheme.js\":\"55a44a4987c6ad59\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/index.js\":\"67ee80c51129cd55\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/scriptConsent.js\":\"d7db439f68b72225\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/sourceMap.js\":\"cfcb0ba87ee0ab30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/html-document/useDocumentScripts.js\":\"197d582ac2123e75\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/index.js\":\"4c7e1304a7744802\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/record.js\":\"64b511769ee99470\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/recordStore.js\":\"f0ff2592198b3717\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/responsiveness.js\":\"f929fec48722d265\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/schedule.js\":\"fb4688f53bca104c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/interaction-metrics/sessionContext.js\":\"cf1bf039d962a72e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1e9de5bda15d112e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8ed2fa031935d290\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/actions.js\":\"133710f4631949f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/config.js\":\"f66aee4dc5a2dc1a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/dataExtension.js\":\"fc50154dc8001c48\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/effect.js\":\"8774501be372e0cb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/index.js\":\"a34e7267a4620af5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/keyCapture.js\":\"3cc62f518fc6b8b3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/overrideStore.js\":\"7e3819185b0c72c6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5061723a1841a6d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/HeaderItem.js\":\"f6d3d7bcb804c386\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/LeftSidebar.js\":\"93e8c9707cffc485\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/actions.js\":\"5b4f4fd19349bb45\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/facet.js\":\"103ac3466ee8eb30\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/index.js\":\"a5198ab2493f4db4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/shortcuts.js\":\"b67bad98d5f0db00\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/left-sidebar/toggleStore.js\":\"6ee44cd4addca757\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/MergePicker.js\":\"bcb2eddf8b83ec39\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/index.js\":\"ee196cd6e866de8b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/mergeAction.js\":\"b979cfd4859969c8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/merge-blocks/strategy.js\":\"637722c2746068d6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/Button.js\":\"70421e7a64cb404d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"cf06c2b6af2c2923\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/defaultItems.js\":\"569cc432f838e49a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/facet.js\":\"33e84c9f12ca41e0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-bottom-nav/index.js\":\"f9dda7da0fb87fda\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"90ba4f938797a1df\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e40643730bf43164\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"fbc955d38418ea96\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/facet.js\":\"78741f6c85d66b69\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/mobile-keyboard-toolbar/index.js\":\"e7a8e543cfadf309\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ec00cf73b17cba6a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ff6eb3136ccbef34\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/contextMenuItem.js\":\"4844a38d3b219c1c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/index.js\":\"b3342af79ab28e17\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/moveAction.js\":\"090da206a28b5bf2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/moveBlocks.js\":\"5c78e4915c2d71f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/move-blocks/selectionAfterMove.js\":\"828d2013900c06e7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/TutorialBanner.js\":\"f43a30f92f364bde\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/action.js\":\"d1852417ba4c939d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/bannerDismissal.js\":\"9d87e330e9e4bfd9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/documents/cheatSheet.js\":\"81fb87aa32c62907\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/index.js\":\"8386bb0c6e4d3999\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/keys.js\":\"10e944c5bdfb841b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/landing.js\":\"413483e7ff662b3f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/outline.js\":\"e74314730da63d22\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/onboarding/seed.js\":\"5463da875e5e23f7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/PerfTrendDialog.js\":\"575d894a3f7a4d89\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/analyze.js\":\"de4ed93b236878bd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/diagnosticsSource.js\":\"0d48f95bb6d7b03f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/index.js\":\"8a7378f4d4a619e2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/load.js\":\"67541acff932d087\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/monitorRun.js\":\"609b5a0337f017cc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/schedule.js\":\"01124c1158ab6806\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/series.js\":\"c4c5fb8c89f9a4f8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/store.js\":\"244ca4ff69547cc2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/trendAction.js\":\"5f711c2fe61d54f1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/perf-monitor/verdict.js\":\"feeacb2ab64b5b84\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/plain-outliner/clickToEditAction.js\":\"ae698083bad61335\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/plain-outliner/index.js\":\"02848787da823487\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/plain-outliner/interactions.js\":\"838d6ebb6ebb8895\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e8239890d692ffe1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/MigrationGate.js\":\"aac7e0e94424fe43\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/MigrationGateDialog.js\":\"64ea284e93ec6a1c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/action.js\":\"c009277ebe994c3a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/index.js\":\"5800df964356d0b4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/localRunMessage.js\":\"a7e29d4824a8a733\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/plugin.js\":\"7fd1fa775338eb61\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/progressReport.js\":\"4eb1c0999b60d983\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/properties-migration/sweepProgress.js\":\"e96ba86ef398f0cf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/FieldRowRenderer.js\":\"ee6f4795f68d0331\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/ValueRowRenderer.js\":\"19dc3ed8f4402a0a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/actions.js\":\"80c527fa29f42151\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/autocomplete.js\":\"37fe11093e1c2e1f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/fieldRow.js\":\"f14daddadbbc5c74\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/index.js\":\"105177cc326747ef\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/referenceWarning.js\":\"dbca55db77015cab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/valueAutocomplete.js\":\"f2c8ef3a104f9ccd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/property-rows/valueSchema.js\":\"b0d7eabe5bb021fe\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/HeaderItem.js\":\"6c01553d1590816a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/QuickFind.js\":\"3d0aa192489cbb15\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/index.js\":\"ed90ac801d65831d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/recents.js\":\"4418c4cd0dac554b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/resultItems.js\":\"4fc8852a101ee293\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/selection.js\":\"862bb3f96f774994\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/quick-find/toggleStore.js\":\"6b4a93eaf3bb06ce\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/HeaderItem.js\":\"dc541f1af33e1728\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ed1896da7dc3b806\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/grouping.js\":\"a8fb6ca2f5c890dc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/index.js\":\"461b4a0a714a4a35\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/recents/target.js\":\"546d3742611a0c0a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/codeMirrorExtensions.js\":\"a3e3292b4665c9e7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/contentPrefill.js\":\"ec720167d021b2fa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/dataExtension.js\":\"87acc4c14e2a1bb5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/index.js\":\"d0901adc99d7dd6a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a85fc84529c31bbd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/invalidation.js\":\"37a6d9e535e10ac6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/localSchema.js\":\"408c1d238853d11f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/blockrefs/index.js\":\"bcd2ed55c331367b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3f50c51d96f7d3c6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/index.js\":\"71f6d2cf2d3cc0a9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/referenceNode.js\":\"1e0ebf662e089902\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f4d7900f039ba49b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ef6496d366df9781\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/index.js\":\"148ca7f8fac13390\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e856ae9e072fd0b2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"16275978fd27f298\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/mergeRetargetProcessor.js\":\"8b7d09affc34ea92\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/parseFence.js\":\"439471b93da675a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/referenceParser.js\":\"2aa320adb266010c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/referenceProjection.js\":\"4d9cfeb83b919ef8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/referencesProcessor.js\":\"59ffd55b494bd4de\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/renameProcessor.js\":\"f022368d7ea2bcd2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/references/spanReplacement.js\":\"dd74aba7f4cee17d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/htmlToOutline.js\":\"9b9b34839f238c75\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/index.js\":\"7be9352e6f6db62e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/normalizeClipboardDom.js\":\"008aeb0d48f40a39\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/rich-paste/pasteDecision.js\":\"6a6eadf8c8ea560f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/action.js\":\"1202989136452bdd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/blockIds.js\":\"1bd3480a235c68ea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/content.js\":\"3e6e7c5b4a69bbc9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/effect.js\":\"ff2377b1fbee8692\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/ids.js\":\"89f6531ea0498a16\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/import.js\":\"d0a986cd36953e21\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/index.js\":\"b1f07ddc45dd1ad3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/plan.js\":\"2341938730063a5b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/plugin.js\":\"6d2df72abfa002f2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/promotion.js\":\"de083175932686e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/properties.js\":\"4cb73a41b83ad2f6\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/references.js\":\"168096db1debd730\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/report.js\":\"59b3c15c30a2e45c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/roamMemo.js\":\"0e3a34ef0593ee42\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/runtime.js\":\"0d94b7bcc4e1bdc9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/schemaReconciliation.js\":\"280a07ced87c0135\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/srsMarkers.js\":\"8845935807e12923\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/todo.js\":\"21500cec7398d8bc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/typeCandidates.js\":\"dc977547dfc3b150\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/roam-import/types.js\":\"b9628257721ad5cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/search-health/index.js\":\"8774559484d292bf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/search-health/store.js\":\"c00d8706a281ca57\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/HeaderItem.js\":\"25ea5e6e5be6b1f7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4e2bc40a11550bcd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/index.js\":\"a79ca14e333defa3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/model.js\":\"bf2c2edb2c1bcfd3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/toggleStore.js\":\"913d44285a7c66f9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/shortcut-help/useKeyInspector.js\":\"6c094fb55dddf7f1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a39ac01dfb5d3cdb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/ShellDecorator.js\":\"a238a02968f8294e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/actions.js\":\"6e5c54a4b39bdc36\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/exclusionsFacet.js\":\"083b400f836993a1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/index.js\":\"abf94990f8a392d2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/shell.js\":\"fb907bc64369f840\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/surface.js\":\"2522b6f427832afc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/spatial-navigation/walker.js\":\"ca3c0ca45b463cb2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ee4ff52ce7e64cec\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/dataExtension.js\":\"4a1002c82e5ac01a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/index.js\":\"b1dd9f2d27d2582c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/indicator.js\":\"1c0d28aaee6b74f5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/moveSrsState.js\":\"8042daaeb109ab5a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0afa939ab75e8aee\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/scheduler.js\":\"129dc86545d3dafa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/schema.js\":\"d3dddb9bb934d65a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"93829c700b76b9a3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/srsClipboard.js\":\"b371d4a8510bbee1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c4d1cf6c851a7eed\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b99be087dbdd09b5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/DeckPicker.js\":\"1438faadd51b925b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/ReviewControls.js\":\"a8ecb1f8d4cd91e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ea254dd360d46b80\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/ReviewSession.js\":\"ca42769f7044f998\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/actions.js\":\"dc478fc92e8a95cd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/archive.js\":\"de3cf8adce3050fc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/dataExtension.js\":\"f54cb1bdcc36d110\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/deck.js\":\"985acbc977f00234\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/dueQuery.js\":\"020143a85f06a7e4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/gradeDecision.js\":\"9aafb719df1cb2d4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/index.js\":\"9f25e7fb0f74fdaf\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/keyHints.js\":\"c626ac761cbdd3d4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/reviewCardLayout.js\":\"fcb20117a7d6ddaa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/reviewProgress.js\":\"aa0199483e634383\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/schema.js\":\"a72c9cbcd331c154\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/srs-review/useDueCards.js\":\"b979f0eb49f2b64b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/startup-metrics/index.js\":\"0fb1074d3618adf3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/startup-metrics/record.js\":\"2ea6c4f7d3d0b160\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/storage-persistence/index.js\":\"cd41ded422ce1aba\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/storage-persistence/persistenceStatus.js\":\"887ef5cb1bef0ab3\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/storage-persistence/requestAction.js\":\"5fb21687a62212dd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/TypeChipsDecorator.js\":\"dc3dc07834792ba5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/codeMirrorExtensions.js\":\"d00ff2b9ded38517\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/index.js\":\"ea4365946e64e3d0\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/supertags/typeAutocomplete.js\":\"82d8697f6f35bc29\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"36549b2ab5d3162c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/actions.js\":\"dc9871e243a1f86c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/anchor.js\":\"d52d5b41a93828c2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/events.js\":\"d73aae161e19482b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/gestureActions.js\":\"25efb0925b11ee16\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/index.js\":\"180891b1738776ab\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9c8cc2ef3351eb66\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/sync-metrics/collect.js\":\"44d40e51003b701b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/sync-metrics/index.js\":\"e10b62b0694e8781\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/sync-metrics/record.js\":\"9390d5ea6c99af93\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/RejectionDialog.js\":\"22d3cfaf6444c9ec\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cc587f72cfe9eed2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/index.js\":\"0a5f676f2c0d0c4e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/model.js\":\"bc62b66ed1c5391c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/queueCounts.js\":\"1ea85666ff7d1c97\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/rejectedHelpers.js\":\"07b42961c90f8762\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/rematerializeAction.js\":\"c3aa220b94e90b1b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/system-status/useHysteresis.js\":\"43a389ff27ef33d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/ColumnHeaders.js\":\"117c6d3b55982804\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/QueryUi.js\":\"b52a358361feefe4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/TableLayout.js\":\"612c9a957b7e3f89\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/actions.js\":\"c96eebe9fd1eaa60\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/cellEdits.js\":\"cf4f1b06b66264af\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/columns.js\":\"e9fa92f6c16c501b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/controller.js\":\"2f9364076dfebf6c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/convert.js\":\"52c841400fef1707\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/dataExtension.js\":\"be67ca46263995b8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/index.js\":\"bd77ea10a55c9452\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/keys.js\":\"86e5aee445674005\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/model.js\":\"c5c7fc77b8667eba\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/navigation.js\":\"c5aa6153cc74891c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/backfill.js\":\"a75254f1056aaeae\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/format.js\":\"2a95a0f7a88448cb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/parse.js\":\"03308d628d1891f9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/queryValue.js\":\"b8a57688714569e7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/query/source.js\":\"9766d94ee62e29bd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/registry.js\":\"523780729f123498\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/schema.js\":\"f4d5de5e035ab4d5\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/tables/sort.js\":\"dade03d55fab39b9\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/theme-toggle/effect.js\":\"9268e3c8a892b04c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/theme-toggle/index.js\":\"57ac40c6e1d8405d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/theme-toggle/theme.js\":\"28e789fca4056477\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/actions.js\":\"c83cff83f0efa0cb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/dataExtension.js\":\"ac685bab8924bdbd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/index.js\":\"b65ba2a55bff87fa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/todo/schema.js\":\"f2333f45fca80a42\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5582d49ec46e9f7d\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/actions.js\":\"b3488c8ffad8476f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/defaultItems.js\":\"b282ddde0d91a015\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/facet.js\":\"346a430b2ab97ba4\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/holdRecognizer.js\":\"642fe27eeb7f0486\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/touch-selection/index.js\":\"016a89fa400cca95\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/update-indicator/UpdateIndicator.js\":\"fa7f1bfef843b6b1\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/update-indicator/index.js\":\"5f9e22c2a9ee092e\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/update-indicator/loadTimes.js\":\"3f46ce05c143e147\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/VideoNotesRenderer.js\":\"1835a5edcdc13966\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/VideoPlayerRenderer.js\":\"ddd5a8cbda23e5ea\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/VideoTimeStamp.js\":\"3dd5491e297a61a2\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/actions.js\":\"871a5292f43e56bc\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/index.js\":\"d9ee5026eb945aaa\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/markdown.js\":\"0cd4e791a866b873\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/notes.js\":\"c79e3f6f6c4d8ddd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/registry.js\":\"d8b55e63e06b728c\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/remark-timestamps.js\":\"7bf5f85fccfbe711\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/video-player/view.js\":\"8254537b909def4b\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/LinkHints.js\":\"749bf13e0adffabd\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/index.js\":\"14926ff60f115f60\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/model.js\":\"bcec7af25778dfeb\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-link-hints/settings.js\":\"25f281caff85060a\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-normal-mode/actions.js\":\"d2f6085d2fb226b8\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-normal-mode/index.js\":\"6e1d0e478241f72f\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/vim-normal-mode/interactions.js\":\"6763164bba025de7\",\"/knowledge-medium/pr-preview/pr-1851/src/plugins/workspace-header/index.js\":\"c53200af3f45be6d\",\"/knowledge-medium/pr-preview/pr-1851/src/registerServiceWorker.js\":\"6e8fc293f070ea3e\",\"/knowledge-medium/pr-preview/pr-1851/src/requestPersistentStorage.js\":\"5c9f849172a30f72\",\"/knowledge-medium/pr-preview/pr-1851/src/services/authRequestDeadline.js\":\"0866a8dec6e4a96e\",\"/knowledge-medium/pr-preview/pr-1851/src/services/authStorage.js\":\"9483d7791338e45c\",\"/knowledge-medium/pr-preview/pr-1851/src/services/powersync.js\":\"2ee73a732feb1a7d\",\"/knowledge-medium/pr-preview/pr-1851/src/services/supabase.js\":\"33b6fa04d7887047\",\"/knowledge-medium/pr-preview/pr-1851/src/services/uploadErrorClassifier.js\":\"96fd170e944778a2\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/ActiveContexts.js\":\"e6f3cfcab5cebfbb\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/HotkeyReconciler.js\":\"5f42dde5eb172f1e\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/WipeLocalDataDialog.js\":\"85b349dfc1f5a3cf\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/actionDispatch.js\":\"3afcec1cbb775c1b\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/actionRefItems.js\":\"521f36432328ed9d\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/applyKeybindingOverrides.js\":\"312586ab679a4d8d\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/blockActions.js\":\"f2db4c016334ea81\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/canonicalizeChord.js\":\"73e6c672794e63fb\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/defaultContexts.js\":\"921a062859bc0edf\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/defaultShortcuts.js\":\"9bc4416c8f6fe671\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/effectiveActions.js\":\"18672e85572510b4\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/gestureAction.js\":\"1a8f3971f1c501c1\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/gestureBinding.js\":\"5d653077898b6426\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/holdRegistry.js\":\"1a37a3b95eabdb39\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/keybindingConflicts.js\":\"8a85f0ef16bd8395\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/keybindingOverrides.js\":\"3ff8c718f0e4c81b\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/pointerAction.js\":\"77f590e3d0e9bcf1\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/resolve.js\":\"138fe37d95961c66\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/runAction.js\":\"809cffc05d0e4d0e\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/sequenceMatcher.js\":\"9cd0152256bf4df4\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/types.js\":\"049166b514f31644\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/useActionContext.js\":\"4cf745625129adff\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/useActionDiscovery.js\":\"e796cf0908e72349\",\"/knowledge-medium/pr-preview/pr-1851/src/shortcuts/utils.js\":\"c63aa80b7f276a14\",\"/knowledge-medium/pr-preview/pr-1851/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1851/src/sw/bootStore.js\":\"8a674b7eeadac9a7\",\"/knowledge-medium/pr-preview/pr-1851/src/sw/previewDatabases.js\":\"c85f8bb8c9f44501\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/byteTransform.js\":\"c120eb5d26105c62\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/attachmentCleaner.js\":\"a7224095112a198c\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/attachmentParts.js\":\"cacc9733fb06cccb\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/bundleParts.js\":\"904b402700ceb467\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/bundleRecord.js\":\"2a7737f1961c93ca\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/manifest.js\":\"f4729bf87161b988\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/takeBundle.js\":\"62a31e1868ed5eb7\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/bundle/verifyBundle.js\":\"b4404c2512da0537\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/cleaningStage.js\":\"3bf5696f9387f56a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/conversionKey.js\":\"4284a771aa1510d6\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/conversionServer.js\":\"772a68e1cff666b9\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/flip.js\":\"7baeacf35bda8ed6\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/flipAttempts.js\":\"3cac42edf1548a32\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/pages.js\":\"5880cecd5f7de716\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/preflight.js\":\"56b8d99990e9e23e\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/reseal.js\":\"010559b263964a66\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/runConversion.js\":\"eaadd39a210df2b6\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/runLock.js\":\"2b34d3313017d32a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/sealing.js\":\"7b46f769c999706c\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/sealingStage.js\":\"634836c2ea97def9\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/stage.js\":\"92be097841b5e8cf\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/conversion/verifyReseal.js\":\"e9c9f193a66a606a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/aad.js\":\"d8514c6519a61d39\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/aead.js\":\"763b402f9fb92aac\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/base32.js\":\"76be7e7cf06257b2\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/base64url.js\":\"2dbcda0c4b40e95c\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/binaryEnvelope.js\":\"6df3924d63694621\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/byteAead.js\":\"14ead1715b9dd207\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/canary.js\":\"968f96e8779c77f5\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/contentHash.js\":\"60a24f132168932a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/contentKey.js\":\"87962962f7a45e6a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/derivedIdNamespace.js\":\"70a59f45586a3ef7\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/envelope.js\":\"efdd2ec2b8c7aad5\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/hex.js\":\"8e22a00581446b71\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/sha256Hex.js\":\"e5de5cfd759463de\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/crypto/workspaceKey.js\":\"91e0f33d2b2cd61b\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/conversionState.js\":\"5ae1006c8edd9f7b\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0e3db942b5c6c1e4\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/pastedKey.js\":\"8b1b03bedc220c2a\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a96cab53e7e64b90\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ef80a3655353a133\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/keyStore.js\":\"d7467c517cacdd39\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/mintWorkspaceKey.js\":\"6940ee63d9aded2e\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/modePin.js\":\"7a9e88c1c88f9468\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/openWorkspaceKeys.js\":\"a5e32c59eae5058e\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/resolveWorkspaceEntry.js\":\"036a7aed99e63d0b\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/resolver.js\":\"453e30ca387981a0\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/keys/workspaceAccess.js\":\"8c13167b0055ec54\",\"/knowledge-medium/pr-preview/pr-1851/src/sync/transform.js\":\"a3dea8b613cb629c\",\"/knowledge-medium/pr-preview/pr-1851/src/themeBootDefaults.js\":\"8ee1e10311422e50\",\"/knowledge-medium/pr-preview/pr-1851/src/types.js\":\"0fcbe91ff74e84b4\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/ClientLocalSettings.js\":\"8f2ee5b1afbbced5\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/abortableSleep.js\":\"59b4a94ebc4c5e07\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/array.js\":\"55114cc0d0aca9c2\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/backlinkAutocomplete.js\":\"a6e90a48c00aa28a\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/blockCrumbs.js\":\"def4d657370ad6ce\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/blockrefAutocomplete.js\":\"c4201e4dae673c22\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/cadencedIdleJob.js\":\"dfc9b57c9efe4b0c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/callbackSet.js\":\"c076b520904123fb\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/clientId.js\":\"c3b19a6c2b01e1d4\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/codemirror.js\":\"63cf463b72f43c11\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/codemirrorCompletion.js\":\"c806fe101e2fdcfa\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/copy.js\":\"c5fdd79bcb75a950\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dailyPage.js\":\"d3194b11a7a66a1f\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dbForensics.js\":\"22ad6b0be636f709\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dbForensicsHooks.js\":\"1c634ede64ecff39\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/deleteBlockThroughUi.js\":\"44d5c362a028bfe7\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dialogs.js\":\"a8a880d8038e9dbd\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/dom.js\":\"1aa92c7c3c276f0e\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/downloadBlob.js\":\"db03ba5ac0b87ad6\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/exportSqliteDb.js\":\"5038d65cc656d9ba\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/fileSystemAccess.js\":\"078116ed66b7ff4f\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/flipSlide.js\":\"d79aed7e6e1eac36\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/fnv1a.js\":\"e2988665790cc8db\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/formatBytes.js\":\"6171cf92d54bbd2b\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/fuzzyRank.js\":\"1ebf913a78523ca5\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/idbKeyedStore.js\":\"d954ed767ba7bc09\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/idleCallbackPolyfill.js\":\"4900c6854d69b148\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/keyboardAwareScroll.js\":\"3c03422a1a69e631\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/keyboardViewport.js\":\"ede79046e0cfb93b\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/lastWorkspace.js\":\"2e05242a748ceb36\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/layoutColumns.js\":\"8714442cfd60972d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/layoutSessionDom.js\":\"e68d8033305e290c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/layoutSessionId.js\":\"d7cfed0473a5a695\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/linkClickGestures.js\":\"9e21ef1b4953f50c\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/linkTargetAutocomplete.js\":\"08529225e02c29f3\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/localDbCorruption.js\":\"89b505169c7783c5\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/localDbRecovery.js\":\"6ddc4ce9a8c492a1\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/markdownParser.js\":\"3d37df1ffdd4c081\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/memoize.js\":\"733d9797c9cb5063\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/nameFieldCommit.js\":\"50d9cedc17b6c338\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/nameList.js\":\"9ab427df5fb54d4e\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/navigation.js\":\"4de49c2c3faa4680\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/omnilinerNamespace.js\":\"57252a9b1490c733\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/opfsPageScan.js\":\"983b5add246a9d4d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelClearance.js\":\"527faf873686bf97\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelHistory.js\":\"62399928af344490\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelLanes.js\":\"96cf4c2d730622ee\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelLayoutProjection.js\":\"e53ace5fc4e0c0cf\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelScrollAnchor.js\":\"6798a89f346b62ae\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/panelUrlFlags.js\":\"fb5a1c05e0671031\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/platform.js\":\"ba205c8d14828704\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/pluralize.js\":\"2a4d01ccb50e94fa\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/propertyCreation.js\":\"f19972d5e312a7d8\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/propertyNavigation.js\":\"f954e1bae9f79d41\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/propertyValueContext.js\":\"bc627e33ab75f8ef\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/react.js\":\"675a8b232c017b9d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/relativeDate.js\":\"04d24653b9177113\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/relativeTime.js\":\"cba4306893fdf8e7\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/renderScope.js\":\"1831ff54c5901f17\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/resolvedThenable.js\":\"cc751edc8653448d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/routing.js\":\"d7049df1dd0f02a0\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/safeMode.js\":\"fc4ac7789a49c042\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/scheduleIdle.js\":\"2aee3030846e7b34\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/screenWakeLock.js\":\"325624da0fa0affe\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/selection.js\":\"50be22726b3db3c5\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/softKeyboardGrab.js\":\"78573bbfdab0c956\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/startupTimeline.js\":\"29f6a38a49ac014f\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/state.js\":\"8dce45acd4bd0200\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/string.js\":\"8104d860ca2f7398\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/surfaceZoom.js\":\"36cc2e7143e8977a\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/time.js\":\"5025faec4753ed1f\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/toast.js\":\"f592ec80238ba365\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/toggleStore.js\":\"b8ed3c3ba9a9a551\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/untilStopped.js\":\"e8d2c1859633c468\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/userActivity.js\":\"e5a3aedec89aeb5d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/viewTransition.js\":\"017b37ad41e3f3fd\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/viewport.js\":\"87fe9fa83b9cd08d\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/webLock.js\":\"b7aeb6867749c4eb\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/workspaceRecovery.js\":\"e9b3d4367ce6f1f7\",\"/knowledge-medium/pr-preview/pr-1851/src/utils/workspaceSnapshotStore.js\":\"97b86b35ae7b3f5a\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-compiler-runtime.js\":\"2ccccda0c9492e33\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-client.js\":\"d4b3dd1d3cb1018f\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-server-edge.js\":\"8aae9ab9ec6fc4ea\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-server.js\":\"7ab37249db24bb08\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-static-edge.js\":\"1677d23d0f9f7ea4\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-static.js\":\"c526ddc152d4d6d2\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom-test-utils.js\":\"2447e6601e02a29b\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-dom.js\":\"4f9d9c1cfc3385b5\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react-jsx-runtime.js\":\"d9631619e2d67dad\",\"/knowledge-medium/pr-preview/pr-1851/src/vendor/react.js\":\"00f7ca44acca105f\",\"/knowledge-medium/pr-preview/pr-1851/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1851/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1851/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
