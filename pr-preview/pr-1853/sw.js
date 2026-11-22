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
		buildId: "6480963307b9-b9e3d47b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1853/\":\"89913f62189910d8\",\"/knowledge-medium/pr-preview/pr-1853/index.html\":\"89913f62189910d8\",\"/knowledge-medium/pr-preview/pr-1853/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1853/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1853/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1853/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1853/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1853/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1853/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1853/assets/FacadeVFS-D2cKTQY3.js\":\"eced0b48bf84359b\",\"/knowledge-medium/pr-preview/pr-1853/assets/OPFSCoopSyncVFS-DpNpV0Uk.js\":\"af1eccb581d77a0c\",\"/knowledge-medium/pr-preview/pr-1853/assets/OPFSWriteAheadVFS-Bc5wJOHI.js\":\"987221683386be0e\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-DVgyRN93.js\":\"0f311009efbb4711\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-async-Cy0YMqZJ.js\":\"53139d8461676e16\",\"/knowledge-medium/pr-preview/pr-1853/assets/worker-D6_9Bz_8.js\":\"7169df211491b8da\",\"/knowledge-medium/pr-preview/pr-1853/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1853/chunks/app-QjpWeW3O.js\":\"f1e14f174a640062\",\"/knowledge-medium/pr-preview/pr-1853/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1853/index.js\":\"5d4a79b80dedeeba\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1853/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1853/assets/AccessHandlePoolVFS-C6-MrP1Y.js\":\"05d7886ac22e0f33\",\"/knowledge-medium/pr-preview/pr-1853/assets/IDBBatchAtomicVFS-B5uk7BH6.js\":\"0f6d11bebdabc6d0\",\"/knowledge-medium/pr-preview/pr-1853/assets/MemoryVFS-GpX9H-BT.js\":\"a0e0f1dc810d2399\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-BOhpH9X4.js\":\"5c1c774a3e1f8791\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-async-B6q1gnGN.js\":\"3016b27955e75280\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1853/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1853/chunks/AccessHandlePoolVFS-D4iIqhIz.js\":\"fbb1b85de7cd2d27\",\"/knowledge-medium/pr-preview/pr-1853/chunks/FacadeVFS-Dpb7zSmf.js\":\"5bc73fb4458098e4\",\"/knowledge-medium/pr-preview/pr-1853/chunks/IDBBatchAtomicVFS-CX4_KB-I.js\":\"bcfe6ea2ef7ce188\",\"/knowledge-medium/pr-preview/pr-1853/chunks/MemoryVFS-DNM1cV3E.js\":\"b73943f170b1b80e\",\"/knowledge-medium/pr-preview/pr-1853/chunks/OPFSCoopSyncVFS-CoPfpD7I.js\":\"2ee5d439f5bd78f4\",\"/knowledge-medium/pr-preview/pr-1853/chunks/OPFSWriteAheadVFS-CGSxiNyW.js\":\"b8af47aa9ba3cf64\",\"/knowledge-medium/pr-preview/pr-1853/chunks/Preview-FZ4r0AS5.js\":\"25213f50077e8f3d\",\"/knowledge-medium/pr-preview/pr-1853/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1853/chunks/card-C_m7ouAZ.js\":\"89c934a31487b0e8\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dist-D9kCpmYj.js\":\"cb51c193ada491ff\",\"/knowledge-medium/pr-preview/pr-1853/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1853/chunks/mc-wa-sqlite-16CyqQnj.js\":\"2334ae011fefd3f7\",\"/knowledge-medium/pr-preview/pr-1853/chunks/mc-wa-sqlite-async-Ckkls8UW.js\":\"ac51e01ad2d79bd7\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-3_lemzfq.js\":\"d16335ad104f5bef\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-BVr4_SOb.js\":\"da0f3ae2b3225c1e\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-BzD7cZce.js\":\"17c44c0911dacbcc\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-BzT4i9NT.js\":\"8e1386dd916801ec\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-D0pb8paN.js\":\"495340b91b4c9f23\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-DevN7aVZ.js\":\"e57d8c7e271f2b39\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-O-9bOkv9.js\":\"058f12bda65baff0\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-dom-server-legacy.browser.production-C36YQxP-.js\":\"f1768905c72eaa03\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-dom-server.browser.production-B0tf0nHI.js\":\"d86bbf17792ca7f4\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-dom-server.edge.production-CISO8Ppz.js\":\"d1899e6c3d9143e8\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-ra716VhD.js\":\"3e56c08626c433dd\",\"/knowledge-medium/pr-preview/pr-1853/chunks/server.browser-DCjILpDf.js\":\"2395e2597ece88c1\",\"/knowledge-medium/pr-preview/pr-1853/chunks/textarea-Db5edK7h.js\":\"fbe368b960a4f180\",\"/knowledge-medium/pr-preview/pr-1853/chunks/ui-tWbsWoNY.js\":\"14b28b084637b6a1\",\"/knowledge-medium/pr-preview/pr-1853/chunks/wa-sqlite-DS1075cn.js\":\"d49ced098caa295b\",\"/knowledge-medium/pr-preview/pr-1853/chunks/wa-sqlite-async-Dcq9Edp7.js\":\"57757bc8be245aad\",\"/knowledge-medium/pr-preview/pr-1853/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1853/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1853/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1853/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1853/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1853/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1853/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1853/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1853/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1853/src/App.js\":\"3732cb017497dea1\",\"/knowledge-medium/pr-preview/pr-1853/src/appUpdate.js\":\"b877f6dc6b9d7432\",\"/knowledge-medium/pr-preview/pr-1853/src/appVersion.js\":\"54c427089ad3406b\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/initialLayout.js\":\"c90354e900b7160f\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/openWorkspaceData.js\":\"543446c52b6abc59\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/resolveWorkspace.js\":\"d0d3d50d52af936d\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/workspaceBootstrap.js\":\"8095d3e483fe48e0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockComponent.js\":\"2c2915219e3a8d4a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockCrumbs.js\":\"332ebd1903a3c837\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockEditor.js\":\"f4e851eac373228a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockLoadingPlaceholder.js\":\"814680cb690b236f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockProperties.js\":\"6ed15edbac8a8dbb\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockSearchPicker.js\":\"870c6fd8c7210f82\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ConfirmBulkDeleteDialog.js\":\"6afba5b8db142b7f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/DividerHandle.js\":\"54977aa7964a7c04\",\"/knowledge-medium/pr-preview/pr-1853/src/components/DraftEditor.js\":\"de5f117ce22b9128\",\"/knowledge-medium/pr-preview/pr-1853/src/components/GutterPill.js\":\"5af08caf0a952a37\",\"/knowledge-medium/pr-preview/pr-1853/src/components/Header.js\":\"ee6b6f556c5f7477\",\"/knowledge-medium/pr-preview/pr-1853/src/components/LazyBlockComponent.js\":\"8e0451cbd9843f7b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/Login.js\":\"c4a45a97a2c1b1f0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ZoomableSurface.js\":\"93c3637a4b4c977c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/editModeKeepalive.js\":\"aae9705f81bd6353\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e338f24b553503e9\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6c059ddbfe27364e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/RefPropertyEditor.js\":\"e640d0272b332f2a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/RefTargetTypePicker.js\":\"25d208949a2cf09d\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/SelectPropertyEditor.js\":\"141bfe68708c42ba\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/TypesPropertyEditor.js\":\"f5211d8158931c6e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/defaults.js\":\"a1918ff2c6994253\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/kernelValuePresets.js\":\"dc2de39b33dc1519\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/selectablePresets.js\":\"43758aceed015f68\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/typesPropertyUi.js\":\"df517d00006d934d\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/AddPropertyForm.js\":\"c99988b88c6be00c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/PropertyPicker.js\":\"092b25c2dfff424f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/PropertyRow.js\":\"0fd171e77daf4a11\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/Rows.js\":\"904cffbd38589b1a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/actions.js\":\"ecc5c7a640096be5\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/declarationOnly.js\":\"b866ba8ac5b3f990\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/layout.js\":\"ee76d64d3aa195e8\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/model.js\":\"02ba2c5e1f399149\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/shapeUi.js\":\"294934069a57c505\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/shapes.js\":\"b00515c2304cafad\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c5894a1e39405664\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/visibility.js\":\"6f517d437251efbd\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanelSections.js\":\"2e79eb5b182401b3\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/BlockEmbed.js\":\"354d972e5fe46b5b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/BlockLink.js\":\"1b806ef9bbae2b72\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/BlockRef.js\":\"e675d8dcfcde242b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/ReferenceLink.js\":\"6e9428cf933fd591\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/cycleGuard.js\":\"c1c361cd85bc4ef1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/cycleGuardContext.js\":\"011b132349436bd1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/linkInteraction.js\":\"58de0d7060fb726f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/referenceLayout.js\":\"a6d969c28a6ea5d1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/useBlockRefAncestors.js\":\"69216b93b36b200d\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BlockGutter.js\":\"ec90e1270acb17e2\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BlockInfoDialog.js\":\"9b784a78eb24d621\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BlockTypeBlockRenderer.js\":\"a8a40a5dea360c38\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BulletHoverCard.js\":\"b789cf8b2f84c972\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/CodeMirrorContentRenderer.js\":\"9cbcf95193e65b5b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e019b3775b6f6638\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/ColumnResizeHandles.js\":\"4609300ac9da99b2\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0dd46827bde3a89d\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/DefaultBlockRenderer.js\":\"bb6ce5098096dba2\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/LayoutRenderer.js\":\"6cc396d696a40dbf\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/MarkdownContentRenderer.js\":\"38ca61aed0860bb6\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/MissingDataRenderer.js\":\"5ce7d0a21a618073\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/PanelRenderer.js\":\"590648afaa4d1dee\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4b170aaa3b9296df\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/TopLevelRenderer.js\":\"2a8e36e678570903\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/blockGutterMode.js\":\"9b837f25d1c59d9c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/blockTitleText.js\":\"f859890e1b78300c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/fieldCreationKeydown.js\":\"4b455cb3200d727a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/layoutRootContext.js\":\"d50dd78bbb01893c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/typeChip/TypeChip.js\":\"1edc147c2ac3bfea\",\"/knowledge-medium/pr-preview/pr-1853/src/components/typeChip/chipStyle.js\":\"7520f67959cf4179\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/anchored-floating.js\":\"c8934f21c5a5b3ec\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/button.js\":\"0a9ee49fe2f7fd49\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/card.js\":\"1577c11d399b2c27\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/checkbox.js\":\"43f07fd7b12e19d1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/collapsible.js\":\"41e1eee5b18bb469\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/command.js\":\"b72956144d4c45e9\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/context-menu.js\":\"e0446c6ce85d449a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/dialog.js\":\"e94ef5b9aac4076a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/dropdown-menu.js\":\"2c741a8dff4038be\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/floating-listbox.js\":\"2160a1cfc8bbb2cc\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/index.js\":\"048e758cc73364ae\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/input.js\":\"31b84240983e400e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/kbd.js\":\"7414a9b45bae96f1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/label.js\":\"abadf804ae802606\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/textarea.js\":\"b2e3df4240d87852\",\"/knowledge-medium/pr-preview/pr-1853/src/components/useEditModeYieldKeepalive.js\":\"f25d31339436db24\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/BootFallback.js\":\"64c2dbe4e2677a8a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/FocusedRowLazyMount.js\":\"6d3e06e03ca04d54\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/LazyViewportMount.js\":\"c89c87e81a030b96\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/LocalDbCorruptionFallback.js\":\"360c4127472893c5\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/error.js\":\"6a1712edecc7c37e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/lazyMountRegistry.js\":\"6f634010e57165b7\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/suspense.js\":\"98b9051d292542ae\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/CreateWorkspaceDialog.js\":\"1c6c23a652582249\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/PendingInvitations.js\":\"b666d73b21030351\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/SyncProgress.js\":\"285cf5daf737350f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/UnlockProgress.js\":\"1b2832b7e2731c04\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceKeyGate.js\":\"5dcb8a7baf1579e1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceSettingsDialog.js\":\"4d7f58b016c88cbc\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceSwitcher.js\":\"2a742a3b002d96bd\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceSyncGate.js\":\"747cf28457501aa1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/ConversionFlow.js\":\"fc71cbbba41bee79\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/ConversionFlowHost.js\":\"2f3a1f8ba6dcf893\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/EncryptionSection.js\":\"ccbb2f6ab17ebec0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/attachmentPrompts.js\":\"d271a2a378103c7d\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/bundleFolderPrompts.js\":\"257cb35ec1769e8f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/conversionFlowDeps.js\":\"a23f26a4886078a8\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/conversionFlowStore.js\":\"59f588c9999462be\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/flowUi.js\":\"84fce5f93e21855e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/useConversionRun.js\":\"e1d02016254abd74\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/keyUi.js\":\"da8f6731bce49c6f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/useCloseOnKeyLoss.js\":\"3f1c2963c3794f95\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/useCloseOnServerE2ee.js\":\"9504d09fb7d17695\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/workspaceUnlocked.js\":\"9e4ae6d3f594a47b\",\"/knowledge-medium/pr-preview/pr-1853/src/context/backgroundSubtree.js\":\"5b530b6ce4397804\",\"/knowledge-medium/pr-preview/pr-1853/src/context/block.js\":\"c54fd66938feda86\",\"/knowledge-medium/pr-preview/pr-1853/src/context/layoutWsContext.js\":\"7bca239158519971\",\"/knowledge-medium/pr-preview/pr-1853/src/context/propertyDisplay.js\":\"5b51f8c624bade35\",\"/knowledge-medium/pr-preview/pr-1853/src/context/repo.js\":\"9128145ca73acea2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/aliasClaim.js\":\"126661d5e7ba8dc7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/aliasSeatNamespace.js\":\"0d222cd35be634b3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/blockData.js\":\"c7577360e6427c4f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/blockType.js\":\"6c278066ad92a07b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/changeScope.js\":\"86da8b80f4e3b289\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/codecs.js\":\"05f65aff3c3af6ce\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/derivedData.js\":\"d8dfeea27de0faf0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/errors.js\":\"7a32c35898a4a4b2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/events.js\":\"2d06abe2b4cc759f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/handle.js\":\"e5ff55e83abd60ea\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/index.js\":\"3a494c57c59b1493\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/mutator.js\":\"c46f8ec933ef85d6\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/processor.js\":\"93c5f5677e53a26e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/propertySchema.js\":\"86855d805d62dd51\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/query.js\":\"5d96224e4a1cee06\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/sameTxProcessor.js\":\"592345be50065303\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/schema.js\":\"e5ff55e83abd60ea\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/tx.js\":\"e5ff55e83abd60ea\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/typedBlockQuery.js\":\"708b4d85d0da991f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/user.js\":\"79f54e10d6e37c9b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/valuePresetCore.js\":\"455693febdc664f2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/valuePresets.js\":\"76ac8ec098e4f5b5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/attachmentCleanerIOVerb.js\":\"18e337d1da122b09\",\"/knowledge-medium/pr-preview/pr-1853/src/data/block.js\":\"a6a714175881effc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockCache.js\":\"e077f75a542a1f10\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockId.js\":\"962046e3fb7b2228\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockLiveness.js\":\"79e6414694ed9002\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockMerge.js\":\"c9fd4c1a21aa608f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockSchema.js\":\"342913553c7c91ea\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockTypeLookup.js\":\"1cf5bd4f2ab8a911\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockTypes.js\":\"01588aab0cfb952a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/clientContext.js\":\"7e41de9dc92a9766\",\"/knowledge-medium/pr-preview/pr-1853/src/data/dbFileSiblings.js\":\"a77bea48f8c92f10\",\"/knowledge-medium/pr-preview/pr-1853/src/data/definitionSeeds.js\":\"3c8d11b402c5c981\",\"/knowledge-medium/pr-preview/pr-1853/src/data/derivedIds.js\":\"ffac681f6ccbab80\",\"/knowledge-medium/pr-preview/pr-1853/src/data/drawnSubtree.js\":\"c712dc9e3c76c84b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/facetBridge.js\":\"ff18b656c7c028cc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/facets.js\":\"c4449ed13183a902\",\"/knowledge-medium/pr-preview/pr-1853/src/data/globalState.js\":\"08e5f8f8f79c4136\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/aliasClaimRederiveProcessor.js\":\"0ac7da9b6da96d56\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/ancestorBatch.js\":\"66b0e7ea517b18c2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/blockTypeTypeifyProcessor.js\":\"4d7d4c57e3cb8af4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/clientSchema.js\":\"1620cb41d12ef56a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/commitPipeline.js\":\"0f4de1565b6196aa\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/devAssertions.js\":\"a0fe1c0ff8917e21\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/firstSync.js\":\"3909cdcc567d8253\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/freshInitialLoad.js\":\"5137254882f1c62c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/graphBackfillClaim.js\":\"10af23fc2fe09cd3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/handleStore.js\":\"8895ea6c112f391f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/idleMarkerJobs.js\":\"9a720f5a212e6fac\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/initialDownload.js\":\"fa099b634e2b0cf8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/initializeClientDatabase.js\":\"c7f1f6bec148c214\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/jsonCanonical.js\":\"f3c1aba1a93cc5cf\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/kernelInvalidation.js\":\"43b015245e46394f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/kernelProcessors.js\":\"cebc17b90a2eb944\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/kernelQueries.js\":\"df12f44f7067f22a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/mergeTypeMembershipProcessor.js\":\"2492b8fa2e4a69e7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/normalizeReferencesProcessor.js\":\"5f0be9b8f0dd3ca0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/poolInstrumentation.js\":\"4d97ac33a8e14d7e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/processorRunner.js\":\"175eb11c7d6b71b8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyCellBackfill.js\":\"b75d8d94055ca336\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyChildMint.js\":\"b08e6b0b4074da36\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyChildrenProcessor.js\":\"b9a66bf71f8f9284\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b3ff8996b3545eea\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyDefinitionSynthesis.js\":\"3d67de1e56e3719f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyKeyScan.js\":\"3e37fc86f916bdcf\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertySchemaResolution.js\":\"5021834a9167a320\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyValueEdits.js\":\"7664e0c7b40eb374\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/raiseProtocol.js\":\"d71f9b946558c0da\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/readBatch.js\":\"f696d3353cda1571\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/refProjection.js\":\"368c7bedd304fe54\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/referenceTargetLookups.js\":\"ef8ef1fc76bc5ec4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/referenceTargetProcessor.js\":\"4ac8a437c9fef13b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/replayMerge.js\":\"5d94f93adec98275\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/sqlBinds.js\":\"c3f56ea9237be1d1\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fed3e1f3db49e76a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/arrivalProcessors.js\":\"b1de956f9c39c718\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/invalidate.js\":\"60925e5bcd3ded74\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/materialize.js\":\"cce4bf7a71dd883c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/observer.js\":\"b7cf7e38827469f1\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/reconcile.js\":\"ebcedefd42293a81\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/timingMetrics.js\":\"813d5cf4a4f7cb59\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/treeQueries.js\":\"b2bd0d1c4db3e698\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/txEngine.js\":\"f01f0fea73e0f61e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/txSnapshots.js\":\"928be806194532ec\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/typedBlockQuery.js\":\"9c404f283820d21f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/undoManager.js\":\"a401be074b78c96e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/invalidation.js\":\"9971eff2e8c7a936\",\"/knowledge-medium/pr-preview/pr-1853/src/data/kernelDataExtension.js\":\"109e7299354682ef\",\"/knowledge-medium/pr-preview/pr-1853/src/data/kernelPage.js\":\"369520536be64096\",\"/knowledge-medium/pr-preview/pr-1853/src/data/kernelValuePresetCores.js\":\"9b55c47468c3f983\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localDbCorruptionSignal.js\":\"e0154f73fb190f51\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localDbStorage.js\":\"8492fb4cce9090e4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localDbVfs.js\":\"347d049a89dff2e6\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localSchema.js\":\"58e4f8cfe023c8f5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/maintenance.js\":\"5f05ed35f5074f06\",\"/knowledge-medium/pr-preview/pr-1853/src/data/mergeProperties.js\":\"f6d8b6c4469ce4e0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/metricsConsoleHook.js\":\"200453e426dbeb34\",\"/knowledge-medium/pr-preview/pr-1853/src/data/migrationsPage.js\":\"96fc25234bbc4cf0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/mutators.js\":\"157d4a9836286d89\",\"/knowledge-medium/pr-preview/pr-1853/src/data/orderKey.js\":\"4c2c87e7a5351b8f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/orderKeyPlacement.js\":\"850334925e0bd1cf\",\"/knowledge-medium/pr-preview/pr-1853/src/data/outlineSurface.js\":\"19961685c8ed51c8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/pendingEditorContent.js\":\"38eb9a5dd70bd8a3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/pendingUploadsSql.js\":\"66b8aeecbfd1ab92\",\"/knowledge-medium/pr-preview/pr-1853/src/data/pluginStateExtensions.js\":\"14241d1a5fde8e00\",\"/knowledge-medium/pr-preview/pr-1853/src/data/powerSyncLogger.js\":\"11592d4ef1af8c3e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/projectorRuntime.js\":\"941a76119c1016a6\",\"/knowledge-medium/pr-preview/pr-1853/src/data/properties.js\":\"1ccffde7b6225ea2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertiesPage.js\":\"3fc25aa0f29db79a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyChildren.js\":\"c31296cf7d861df4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDefinitionFanout.js\":\"2cd06b01d7bb1167\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDefinitionMetadata.js\":\"221264e86629ad7c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDefinitionRegistry.js\":\"1306f57b66722bd1\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDisplayMode.js\":\"b1ed41124f6806f2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyRowCreation.js\":\"3ca20d4a0e093513\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertySchemaCreation.js\":\"d0affbf7d5b4f41d\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertySeeds.js\":\"ea9b020de8d248b7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/recentsPage.js\":\"2d7dc01b77427d92\",\"/knowledge-medium/pr-preview/pr-1853/src/data/referenceBlock.js\":\"33d64e3008b8b854\",\"/knowledge-medium/pr-preview/pr-1853/src/data/rejectedUploads.js\":\"042f3c6931c140e9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/releasePowerSyncConnection.js\":\"95b697dd44a937a9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/repo.js\":\"f689c54473f9f2a9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/repoProvider.js\":\"1329f067f6cc0ef4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/rowProperty.js\":\"ac24b71d2017c5b9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/searchFilter.js\":\"0522fda06c071f0e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/seedIdentityLedger.js\":\"fe4ccec8fed09b42\",\"/knowledge-medium/pr-preview/pr-1853/src/data/stateBlocks.js\":\"2ab0141bf87ea0d3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/structuralEditPolicy.js\":\"95679eedccaa003c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/subtreeDelete.js\":\"dc471a4fefc6b107\",\"/knowledge-medium/pr-preview/pr-1853/src/data/syncStreamLock.js\":\"77c2ec1b2974da40\",\"/knowledge-medium/pr-preview/pr-1853/src/data/syncedTableSqlRecognizer.js\":\"508294c063537a79\",\"/knowledge-medium/pr-preview/pr-1853/src/data/syncedTableWriteGuard.js\":\"df422e48eeef9216\",\"/knowledge-medium/pr-preview/pr-1853/src/data/targets.js\":\"274a5eeb96cd31e5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeColors.js\":\"63bc815845482da1\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeDefinitionMetadata.js\":\"2334a3d7298b4fa7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeDefinitionRegistry.js\":\"2861cc4cdf3d0e57\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeExtraction.js\":\"0905ea48c8237f31\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeInitialValues.js\":\"c4f6d304e9458e60\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typePropertyGroups.js\":\"0f84275cc896c891\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeSeeds.js\":\"0b40f84f8d5d60d5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeTagger.js\":\"b2f34bce5a2c683b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typedRecords.js\":\"e67a9a4e09ae67b7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typesPage.js\":\"4b2b5d82b94f0455\",\"/knowledge-medium/pr-preview/pr-1853/src/data/userPrefs.js\":\"451488d1afae3988\",\"/knowledge-medium/pr-preview/pr-1853/src/data/userSchemasService.js\":\"ca6faa0300e891ce\",\"/knowledge-medium/pr-preview/pr-1853/src/data/userTypesService.js\":\"6d88fb825f51c09c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/valuePresetRegistry.js\":\"3987d406427db970\",\"/knowledge-medium/pr-preview/pr-1853/src/data/visibleChildren.js\":\"5cc3b3b9c29cc0b3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceConversion.js\":\"721ec30432f224e8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceFirstSync.js\":\"f665a0271a72d4bf\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceIdNamespace.js\":\"572c6b5c70b95751\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceSchema.js\":\"b01877b505deaa34\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaces.js\":\"e943f66b5a4c5858\",\"/knowledge-medium/pr-preview/pr-1853/src/data/writeAheadLog.js\":\"c065cb466fdc524a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/BlockPasteShellDecorator.js\":\"402169d41d5fa44e\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/atTrigger.js\":\"837b5bcc4c1651ea\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/autocomplete.js\":\"3b268c2637f7badb\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/codeMirrorExtensions.js\":\"ff423c6615f8348b\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/contentFlush.js\":\"3c8b73afb188d175\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/defaultInteractions.js\":\"965a9c5a402b11a2\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/editSettleSignal.js\":\"8e6c6f076b45ad4b\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/insertImage.js\":\"0ba19f3265d3ae32\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/referenceCompletionRange.js\":\"0323f80a267ce9ba\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/referenceTargetTypes.js\":\"2cb012cbe79cb639\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/syntaxContext.js\":\"4b0f9df3f0c28f2b\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/triggerMatch.js\":\"811645778102dab3\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/AppRuntimeProvider.js\":\"4cad43ed2232e58a\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/BlockFocusShellDecorator.js\":\"e992f8e7a549beb9\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/ExtensionRenderBoundary.js\":\"3fbae5de77befa56\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/PanelContentRecovery.js\":\"d4ae4e9c5bdde940\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/apiCatalog.js\":\"8d1f743f204c12cb\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/approveExtensionHere.js\":\"e08c2736c23d5a2e\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/armedCutAppMount.js\":\"dc2bec070b632142\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/batchableKeyedStore.js\":\"e76b8b733a10180c\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/blockInteraction.js\":\"16a373d118b49f1d\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/blockSelectionAction.js\":\"1fecd8114d69e570\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/compileExtensionModule.js\":\"4a0c91a8a11c282b\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/compiledModuleCache.js\":\"097680a4a000487a\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/continuousGestures.js\":\"8d00a4325843ea90\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/core.js\":\"7cbfeed356a2984a\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/defaultRenderers.js\":\"762509c613242913\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/definitionFanoutAppMount.js\":\"3c0e0cfdba29d494\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/dialogAppMount.js\":\"0576029dc18a1036\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/dynamicExtensionSeeds.js\":\"e1830bc28e0683a3\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/dynamicExtensions.js\":\"404a2be0b91fd944\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/exampleExtensions.js\":\"fa8c371214af2915\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionApprovalStatus.js\":\"557319978236995f\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionLoadErrorToast.js\":\"6ec6ebbe5099b194\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionLoadErrors.js\":\"3073284c2e2ae4fc\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionLookup.js\":\"cfb0793965b2b2ec\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionToggles.js\":\"714703535e9a3f8d\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionUtilitiesCss.js\":\"fc5715f52432bf5d\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/kernelPageDeletionGuard.js\":\"148bae9b118acab9\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/liveRuntime.js\":\"19b72c9f264f1ad0\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/openExtensionsSettings.js\":\"c179f85c9821d41f\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/overridesCache.js\":\"1583aadc0a4aa135\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/pluginIds.js\":\"90be938bf9377873\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/processorRejectionToast.js\":\"2ef9786b734c0854\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/runtimeActions.js\":\"e8778cba94ed7b27\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/runtimeContext.js\":\"69486acaa75f9202\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/staticAppExtensions.js\":\"8040a82d4333d767\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/staticDataExtensions.js\":\"d7f051c5da8ffd95\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/toastAppMount.js\":\"61db5701db5ebec4\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/useOverrides.js\":\"fe08c9b2a92fe58a\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/useShortcutSurfaceActivations.js\":\"cf9bb70e579d8095\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/discoverToggleTree.js\":\"ff509eefe005c22f\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/facet.js\":\"37bfd5ca87434e9d\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/resolveAppRuntime.js\":\"a528c628d13b1dd2\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/runtimeEvents.js\":\"bb4ef98648effdb2\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/togglable.js\":\"e97db4389afc395b\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/variantFacet.js\":\"119806475149ab76\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/verbFacet.js\":\"8e2689d7dd669017\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/block.js\":\"28ea0a255af2c56b\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/focusedChild.js\":\"75da81ef2fd7359b\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/propertySchemas.js\":\"a73f0914c0a6fbfc\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/typeRegistry.js\":\"da15a3ef820256a1\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useAncestorCrumbs.js\":\"bf7fc7a7886f0516\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useAutocompleteListbox.js\":\"6ea57fa17d0c608c\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useDebouncedSearch.js\":\"4ee51ab64b91212b\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useDebouncedValue.js\":\"5bc0683049612a04\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useIsFocalRender.js\":\"e090a397d816cb52\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useIsReadOnly.js\":\"91976d11a78b0a53\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useMaterializeBacklog.js\":\"6ca00a1e1908cd15\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useMinuteClock.js\":\"f7d279bead079745\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/usePanelLayoutProjection.js\":\"371986d77bc68b4f\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/usePendingInvitations.js\":\"ff0d30bf6c624d59\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useRendererRegistry.js\":\"a2b6fbca7bc4269b\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useRetainedFieldRows.js\":\"2ff85e8892256176\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useWorkspaces.js\":\"d27fb104bfa93688\",\"/knowledge-medium/pr-preview/pr-1853/src/lib/utils.js\":\"929da36867058a66\",\"/knowledge-medium/pr-preview/pr-1853/src/main.js\":\"a2083affeb1c9e2b\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/MarkdownImage.js\":\"9ac632054c331ecd\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/blockSeparators.js\":\"73d293e46f259cdf\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/context.js\":\"5e1bc5c4b7ab6531\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/defaultMarkdownExtension.js\":\"8548a844065c9d92\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/extensions.js\":\"4f7acf669800abd7\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/renderMarkdownHtml.js\":\"3108bcb6a17aa902\",\"/knowledge-medium/pr-preview/pr-1853/src/minimal-editor.js\":\"919f22257e0d5be0\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/armedCut.js\":\"ea40b83b4cf3b365\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/captureMediaVerb.js\":\"5c9ef18fabd11886\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/clipboard.js\":\"a9ad768e0161e53e\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/decision.js\":\"36ff52b3eebc5f93\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/operations.js\":\"4da5d5a6b83fdd0d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/account-header/AccountHeaderItem.js\":\"ab6f0f7da1de568a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/account-header/index.js\":\"f0bd174ca0df3052\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"561f67bf9ff2278b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/askAgent.js\":\"d6155ea7f15fe04d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/askedStore.js\":\"944f7395307870ec\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0eb8ae7945a2b9c8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/chipState.js\":\"84c95ca8e0d03adc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5446f64afbe14d01\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/index.js\":\"e1af7fada616ae3e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c4d9d218952477a9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/schema.js\":\"aeaa939509c290e0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6978f969c879be03\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2430de1cb9f6051a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/addMedia.js\":\"c14739060c5a16ec\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1d8ac451116b4166\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/block.js\":\"b48b6c718aa18dbd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/context.js\":\"882ab95ec255483e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/displayIds.js\":\"24f3363304e4eebe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/index.js\":\"e297f9e170beac15\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/outline.js\":\"01d603a6df0483ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/properties.js\":\"974dbeeddf9fc706\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/refs.js\":\"e0b294c707bf4569\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ed6a5eb8bd029529\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/search.js\":\"832634c3d292f58a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/shared.js\":\"00c96706b84d638f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"dc1c9bb9b414e0f0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/text.js\":\"d5a724085d17692f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentWrites.js\":\"ad8cf130213a6f37\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/authoringCatalog.js\":\"bc4a5a237c526824\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/blockRefTargets.js\":\"b2fe1b46ac8c5984\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/bridge.js\":\"a42bc46b4e0eb2b8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/bridgeLoop.js\":\"877eb10592ee8962\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/changeHistory.js\":\"cdf3fd9208d13824\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/commands.js\":\"371066013cedb338\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/commentsCommands.js\":\"d6662e52838c860f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/dataExtension.js\":\"dcd483fe1d91a86d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/dataModelGuide.js\":\"1d10fb6f46112834\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/describeRuntime.js\":\"8889d4e052c0bc89\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/extensionLint.js\":\"a1a1dace70b245e7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/grainAudit.js\":\"a80efcba4c39ae36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/healthCommand.js\":\"d6b05a397d6710d5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/index.js\":\"b1fcf627018c9101\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/presetIdentity.js\":\"24b89f4affa8e3ff\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c183b177272346a9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/readMedia.js\":\"536f510e5f55841a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/schema.js\":\"a1a94963068e91f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/serialization.js\":\"ae8786150fe4ecc5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/targets.js\":\"5f019161bbac74df\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/tokens.js\":\"1465184d5b58fc58\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/watchEvents.js\":\"f34bc4870196d457\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/workspaceGuard.js\":\"3e0b90953afc3625\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/writeCommands.js\":\"e052e92e33d6252d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/AliasCollisionToast.js\":\"bc191ef50b177f23\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/DuplicateNameBanner.js\":\"4145b7b6813f9ac7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/collisionMerge.js\":\"97e127f0316c268c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/dataExtension.js\":\"5ac05c540327319f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/index.js\":\"5862693e61c08fb7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/mergeCollisionAction.js\":\"2856fb4fff9d3ce8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/pageStyling.js\":\"308633e39e7e4215\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/rejectionToast.js\":\"32dae4569c375367\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/syncProcessor.js\":\"c4c808329a499dbe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/actions.js\":\"234ca2f961810074\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/addComment.js\":\"bb5dab704ffb7ddf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/anchor.js\":\"057621701fc84cc6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/anchorState.js\":\"bccfc3a8e8db651a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/commentLinks.js\":\"835dd0af370d8c13\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/confirmThreadDeletion.js\":\"2f5c21e21f5d0a11\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/container.js\":\"0b449a2bc8559d68\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/dataExtension.js\":\"6e85dc8b2c5868e4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/deleteComment.js\":\"d9399c79d414cd36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/highlights.js\":\"760b476d4ab7857a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/index.js\":\"0b8abf2cf4967958\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/linkedCommentsPill.js\":\"928508fc621d2f0b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/margin.js\":\"b1ecfad8a3211011\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/marginSchema.js\":\"0a26e961ebca009c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/newComment.js\":\"a7889ba14562ce4f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/ownThreadPicker.js\":\"5eaceb92a321eda6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/placement.js\":\"d7cdc485779ac46a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/queries.js\":\"15098be3d91ed016\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/quotePosition.js\":\"21dbcfe316b2e3e5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/quotedIn.js\":\"b2b5c21b55d6241c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/quotedRange.js\":\"c9ad973865c5750d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/rangeRefs.js\":\"b0e1889424305d37\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/readHighlights.js\":\"cd96b8776a1044b3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/readSelection.js\":\"1e5422757f3e6f6e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/readSelectionUi.js\":\"f329e274d560b8a5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/reanchor.js\":\"93e8df0b81eefd9c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/schema.js\":\"a581af0021e72144\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/scope.js\":\"9fef844a81b15f57\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/scopeThreads.js\":\"a65af5d98a8cc1a4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/splitRetarget.js\":\"79f21d23b615d7d6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/suggestionCard.js\":\"f3d1ef6db971c1fb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/suggestions.js\":\"49144a611c036452\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/summaries.js\":\"096b3f2b0a0cc534\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/summaryBatch.js\":\"a0326273940bad31\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/surface.js\":\"55791e1ebab5505b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/threadNavigation.js\":\"69069c04a658799a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/threads.js\":\"a6eaf6b334fb65e5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/ui.js\":\"5cf69555211d10d1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/uiStore.js\":\"00e598425529297b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-intents/appIntents.js\":\"000fb964e8c67d0e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-intents/index.js\":\"1dad03f764b00eb9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-update-prompt/index.js\":\"1a7139020aafe659\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-update-prompt/status.js\":\"08dd070b02db3710\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cc4ec4e82bb44ad6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/MediaBlockRenderer.js\":\"b6a646d5b7544a97\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f56686602324d429\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/MediaUploadReconciler.js\":\"370cb420f70b2674\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/assetDownLane.js\":\"dd2b8f1c261459bb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/assetResolver.js\":\"90105361f4d051f2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/assetUpload.js\":\"2971482f11e17fc6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/attachmentCleanerIO.js\":\"800026f57ef6754b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1ac063bd916c1377\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/blobStore.js\":\"2aa97f28e93d2926\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/byteStore.js\":\"ebbd8fa61b73253e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/cleanerIO.js\":\"c337c543aa67b533\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/cleanupAttachments.js\":\"17eb3a86a621f00a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/dataExtension.js\":\"f42df7222727e901\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/downLane.js\":\"f101b4bee7117a35\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/index.js\":\"820b1230429cf564\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/insertImageContribution.js\":\"f186c6d1f7eb8335\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/laneArming.js\":\"13656e9d74cc255a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/laneLock.js\":\"d63571f0996a830a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaBlock.js\":\"8435a0b2137bd68f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaCapture.js\":\"28d94c8bf3b62595\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaViewers.js\":\"23e8922ec28e3e6a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaViewersFacet.js\":\"11bb18dbe3043709\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/pasteCapture.js\":\"34e32c3b7ad830e0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/resolver.js\":\"f73a6d8a058105dd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/retryUploadsAction.js\":\"87e4e25b2de649ca\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/storagePaths.js\":\"de6af3c680368144\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadDrain.js\":\"02d8a085bda8425c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadLaneStatus.js\":\"c9185ba87f18bcd0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadReconcile.js\":\"cbbbc8f820792413\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadRecovery.js\":\"3a5ad10dd06c9f7d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadStore.js\":\"dcfcf5d14ee3588e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/useAssetObjectUrl.js\":\"cdb9bfdccf2341a8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ddc5b61a8e387c05\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a8276cd01c2cccde\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/facet.js\":\"d782696e4b4b9d1f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/index.js\":\"b841f95d51c8535b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/prop.js\":\"7d48b72b1b633c61\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/BacklinkFilters.js\":\"9e2aaf14ad2930a5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6602f63ed9eeb1f1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/BlockEntry.js\":\"d6d9c0ad2ea6394b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/LinkedReferences.js\":\"bf3f5fde88ce88e2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a4e91bd0bdda1271\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/dailyNoteDefaults.js\":\"8fe732c51dec4a0a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/dataExtension.js\":\"ef4296a5d7a23446\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/edgeExclusions.js\":\"934ad58bbea1120b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/filterProperty.js\":\"e600f0edf3ecb109\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/index.js\":\"bebce0143e89a23f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6d603545e9df75e5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/applies.js\":\"cf8db709a563e351\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/countQuery.js\":\"04baab6cae000743\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4315f1e7d105d893\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/index.js\":\"90fc6a7848b5d751\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fe6bcd9ef59109f8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/presentationInvalidation.js\":\"013ca5a8e0cb6211\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/propertyEditorOverride.js\":\"06c72c1da0fb6b85\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/propertyFilter.js\":\"b01ac1cc55f18528\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/query.js\":\"ce5cac79f5f631ac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/resolveFilter.js\":\"31fe010047548bb2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/sourceBatch.js\":\"78fb26bf5bb6f0b3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/sources.js\":\"4d25215a3fbca5ba\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/useBacklinks.js\":\"bfba26c83fc82e12\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9aab1472c7cf2c10\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/BirthdayCelebration.js\":\"744d1936f68398e1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/BirthdayOverlay.js\":\"ed99fe4613bf7d28\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/gate.js\":\"12d34fda6d2fc837\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/index.js\":\"d8cad7ed0c67b3ed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/wolfTheme.js\":\"55000d0b7686745b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/BlockDragLayer.js\":\"f012880af58c032c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/dragController.js\":\"2de218f3aa3972aa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/dropTarget.js\":\"754556465b9f796b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/index.js\":\"481f588d33300c51\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/projection.js\":\"8fc589bde92362ef\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-info/BlockMetaCard.js\":\"8429d203d311e84d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-info/index.js\":\"dcd060cc76764698\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/AddTagDialog.js\":\"987c74a824c96b22\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5230e56b9f556517\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/TagNameIssueHint.js\":\"e1a971927d9b6d36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/addTagAction.js\":\"9befe4ea62f55228\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/appendTag.js\":\"cebeb4681b6c3a66\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/config.js\":\"95662c2b1f56363c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/dataExtension.js\":\"c96d9dace4c1e0b0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/index.js\":\"e70347b3400ce428\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/propertyEditorOverride.js\":\"49720e6868767ba4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ac577353c876c9f7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9e6e24badfec9851\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1f1577402ddfaceb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"60a20b2bcb2a4693\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ff409682add884de\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/index.js\":\"f154b49c81daa63e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"81be322cf1564cb4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/CharacterCountItem.js\":\"9e83a0bb0eaff43a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/ProfilePropertyEditor.js\":\"68f5b4cca66d51ee\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/actions.js\":\"fde83f4c86cb4b64\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/blockType.js\":\"6acf83235cff9e32\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/charCount.js\":\"098c74ff7ba4f76f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/dataExtension.js\":\"58c4209a85e0cf75\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/index.js\":\"dd77df017f5a306e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/profiles.js\":\"1b8dff78296f0575\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/properties.js\":\"b86dd2c5802ded94\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/textCounts.js\":\"6ae956f158b277f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/colemak-keybindings/index.js\":\"7878e97ba90d0431\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/CommandPalette.js\":\"358d3a4a7aff5a92\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/HeaderItem.js\":\"f1d09b1cad06fc25\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/context.js\":\"b89e20e56a9339b8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/index.js\":\"41b838f1ecdaec9e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/selection.js\":\"f83b2847da9d1d0c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/toggleStore.js\":\"cccef72602e7bd65\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/useCommandPaletteActions.js\":\"a24c957294a1d80e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/ContributorBadges.js\":\"c6ce52c3cf911571\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/author.js\":\"c3c41cf3ed29031c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/codeMirrorExtensions.js\":\"4ca3e95ce400c3a5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/dataExtension.js\":\"7758ffb826dc55eb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/index.js\":\"e2256cffdf5e7569\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/mentionAutocomplete.js\":\"cffc8b0d56e7b5b3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/processor.js\":\"be08a1234eb8bbfd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/profiles.js\":\"330de278f1b208dd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/queries.js\":\"3fa71c8036625fdd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/schema.js\":\"755ac60c3b4d018e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7d6d9702e284c76f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/followOrigin.js\":\"26ec1b5043ffe8f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/index.js\":\"21b44c25e7b5d90c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e520bc2de0e9ef60\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"70080d78a11b51e0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/CalendarGrid.js\":\"dc4edbfb3e2cffd8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DailyNotePicker.js\":\"65584bc69ced5580\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c728fc919a037785\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DateNavDecorator.js\":\"0912167027f91413\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DateScrubOverlay.js\":\"4d1c2fb7b199702c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/HeaderItem.js\":\"f735983649cf0dfa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/ReschedulePicker.js\":\"f1641340a094e13a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d8e09af93dd74b3a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/actions.js\":\"eb13a76db12a90f1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/blockDateAdapter.js\":\"b0835689320c7a58\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/calendar.js\":\"6efe030f6acfe4d6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dailyNotes.js\":\"523b2efebd476939\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dataExtension.js\":\"c1f47b63715692ee\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubActions.js\":\"aa607dff0d94a032\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubGesture.js\":\"16408278c2f51baa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3d248efed8b066b7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8d1c48b6c9d8f96c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/deletionGuard.js\":\"7cb9dc3690698f53\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dueQuery.js\":\"be3e24caf3ca3166\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/index.js\":\"37cc19c8b543487c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/landing.js\":\"f47d9cac02d5d1f5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/localSchema.js\":\"98b8dd7ac8c34691\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/referenceDateAdapter.js\":\"03f2f6574beab5ce\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/rescheduleAction.js\":\"2657a751125893cd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/schema.js\":\"edc706e037cd4a66\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/spreadBlockDates.js\":\"1cdb5085553c05df\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/spreadDatesAction.js\":\"8008cf9700c2f382\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/today.js\":\"add8198e542ed67b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f738ceb761b399db\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d2c534193c6020f5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/audit.js\":\"2d6468ae248f2e06\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/auditAction.js\":\"dd4789081483b82e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/auditRanges.js\":\"1e25f961324e8341\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/diagnosticsSource.js\":\"48181adf5c062799\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/divergenceScan.js\":\"a4b85f0f7f52645e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/index.js\":\"06431c1ab816ddd5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/propertyChildrenChecks.js\":\"00ad49a5e702baac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/referencesMirror.js\":\"827d2637f53cd614\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/rowJson.js\":\"aee34ddd5e9a184f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/schedule.js\":\"741bc626dd3d2bc2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/store.js\":\"9fdb68a784bf45f9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-maintenance/action.js\":\"2744f9f2567527b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-maintenance/index.js\":\"4a2c2a0139805df9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-maintenance/plugin.js\":\"754fd99ac4b29f7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d9e5e94c717b0486\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/actions.js\":\"d17d9cca025112bf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/changeMarker.js\":\"0dcf149aa1865d3c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/diagnostics.js\":\"293f8dcd72977e2d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/fileSystemAccess.js\":\"0d72493bf37b1377\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/filenames.js\":\"31df47b333310496\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/index.js\":\"fcb2f7adccaab1ec\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/mirror.js\":\"4bfd47a6a4c01a69\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/runLock.js\":\"c9a5c25b476e8dc5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/runtimeHealth.js\":\"c7f13a63df45913f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/schedule.js\":\"3c846cf75293df87\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/store.js\":\"a5e236eb785065ed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/default-themes/index.js\":\"f5137adb1ad278ee\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/default-themes/themes.js\":\"3eb328a8608c173f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/diagnostics/facet.js\":\"35a6ac5be7bacaa5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/diagnostics/useDiagnostics.js\":\"6006681f2641b551\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/dismissals.js\":\"ef7520c6d6fd9770\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/index.js\":\"8d70e1c8d702da73\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/status.js\":\"5a8dba093028bd78\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/store.js\":\"4e6ec030de572eed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"783761aa8527c50c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3c044cd19952ace9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/actions.js\":\"1cb9f36438d0d9ac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/config.js\":\"efedc71a382fc323\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/dataExtension.js\":\"ca2e7ff56cd0b9e4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/effect.js\":\"2424460e020f9feb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/index.js\":\"ec3912b5f801f0da\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/propertyEditorOverride.js\":\"86cb4475d95f243d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/useToggleTree.js\":\"7f4e68934e2beefa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/ExtractTypeDialog.js\":\"9fa241a57fbef20f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6b98da4b71ce1908\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/PropertyShapePicker.js\":\"d025fa313be05963\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/action.js\":\"6efc6a41a5f2a219\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/index.js\":\"5750d342cd53bf34\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/FindReplaceDialog.js\":\"3e7d34567cd43803\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/HeaderItem.js\":\"27b945bfe20c938f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/dataExtension.js\":\"c9a71b6113f1e8e2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/index.js\":\"d0c9ad921ddef6fe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/search.js\":\"f49ff9836da22800\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/toggleStore.js\":\"e2109f07ce33e02e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/LocationPropertyEditor.js\":\"74186db5ead802d7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/MapView.js\":\"a0bc95cc70b3fb2f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/blockTypes.js\":\"20ac0b07e020f939\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/codeMirrorExtensions.js\":\"da7361e40c89c14c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/createOrFindPlace.js\":\"8e251bf53bfc714c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/currentLocation.js\":\"7729a23f566ae8d4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/dataExtension.js\":\"7318bd6c3733d4f9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/geoContentDecorator.js\":\"d5e149a42c9c92cf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/googlePlacesClient.js\":\"76bfa790a4c35474\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/index.js\":\"481ab4dcda13b434\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/locationsPage.js\":\"9ff125a52b4fc35e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/mapViewport.js\":\"775488565a0a61ed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/pickCurrentLocation.js\":\"bc0caa6d2187f97d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/placeAutocomplete.js\":\"920e570c4b9fd393\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/placeNameCollision.js\":\"47ef6809896b4a9d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/properties.js\":\"dc5cfc8024726d4e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/propertyEditorOverrides.js\":\"2ebd86ec585255db\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/query.js\":\"781ed3e2ce2c92c3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/usePlaceSearch.js\":\"5b51defb42b81add\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0d4215b6b52852e3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cd9125ad74969c48\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"47627a2a79412922\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/config.js\":\"3f99f10080b73f83\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/dataExtension.js\":\"d1463066665572ec\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/facet.js\":\"9fdfe969e0210bc1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/grouping.js\":\"a4a679b340647ac2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/index.js\":\"c4c6aefb27431f7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6bb93047fcd69380\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/query.js\":\"45234afc923ccf92\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/resolveConfig.js\":\"cd662ca9b916caf9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f9fdd8e0591321d3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a2385162c47f4c81\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/HtmlDocumentContent.js\":\"f6b59f4363503759\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/HtmlFrame.js\":\"387d19e8ffabc191\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/actions.js\":\"16190b8192cbeab1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/blockType.js\":\"4b08abc6289f907a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/confirmRunScripts.js\":\"53f6f31dcfc30109\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/dataExtension.js\":\"84f4c128f83e3def\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/frameAnnotations.js\":\"5ad7b72710f2d55b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/frameDocument.js\":\"9ffad3ad87b13b0b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/frameTheme.js\":\"ec11211bd4a7390e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/index.js\":\"522137730a697ff9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/scriptConsent.js\":\"e6df4de217a24b8e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/sourceMap.js\":\"b8c9a79b9e89a9b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/useDocumentScripts.js\":\"6043339e992b1bfa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/index.js\":\"2544581ef8de26c0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/record.js\":\"0011abb06dc6f120\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/recordStore.js\":\"3029c8ecc5dd9baa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/responsiveness.js\":\"624a0f38d5b7495f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/schedule.js\":\"61a8417d560a933e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/sessionContext.js\":\"67180c71dbd0f17a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cd2ef08d567cc00d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c87eb219443e62e2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/actions.js\":\"73bbad0496e35606\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/config.js\":\"e87043e99dc669af\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/dataExtension.js\":\"c1111d416a540077\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/effect.js\":\"6b3cd99d74e4043b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/index.js\":\"fa9f297c8bee51a0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/keyCapture.js\":\"8f2ddb3b25b3efea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/overrideStore.js\":\"7e8e182588ece19b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"713e2207529ac2b4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/HeaderItem.js\":\"6c2d9136b086b159\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/LeftSidebar.js\":\"83c0962e01ab3eaf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/actions.js\":\"d50e028a6acaa30f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/facet.js\":\"c7092cc83f2253c8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/index.js\":\"aaa3230f3b0eb374\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/shortcuts.js\":\"e77562da2c126374\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/toggleStore.js\":\"57bffaabda41b266\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/MergePicker.js\":\"d848a9d51bd1ec29\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/index.js\":\"cbdaaa88e98d92ac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/mergeAction.js\":\"60be22fab60dcf52\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/strategy.js\":\"1776df59912027b1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/Button.js\":\"0aed43545d0af7a1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"48c03b0dccec1549\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f2307533de538a87\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/facet.js\":\"59823335316e7e90\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/index.js\":\"db65ea0c6010dccb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6aa8d25e2a76df94\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/actions.js\":\"df3cef33cfeeadb7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"61c4b465fdaf4352\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0180f53495509470\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/index.js\":\"ee483be9286372a5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bb9dd7bcfdcf0fcf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fb51d73fb0ed6a07\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/contextMenuItem.js\":\"fbf1af232a9efe93\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/index.js\":\"370f00db6fa04635\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/moveAction.js\":\"cb14d3d895ab80a5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/moveBlocks.js\":\"5828284e9ff51487\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/selectionAfterMove.js\":\"2afc3a73642c829d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/TutorialBanner.js\":\"7f72c5eefb105a9e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/action.js\":\"85d0f3370548f8a4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/bannerDismissal.js\":\"80652312ddfa2a10\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/documents/cheatSheet.js\":\"c8e5a7efa7ace6b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/index.js\":\"2a0a5c365e8b9c54\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/keys.js\":\"14f13d670f647c03\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/landing.js\":\"8ba462b77e2210c6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/outline.js\":\"c544dec6374b841e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/seed.js\":\"08e9d6b7cd31f340\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/PerfTrendDialog.js\":\"dda58124bd297d7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/analyze.js\":\"27e783703559cae2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/diagnosticsSource.js\":\"98357b6a6f200357\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/index.js\":\"86fe05d75e30d79e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/load.js\":\"8232e15e66d0e317\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/monitorRun.js\":\"2b9d5dbbbbf17e94\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/schedule.js\":\"dde2e49a7ffbca0c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/series.js\":\"d180fae7b80f1805\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/store.js\":\"14a55bef41827caa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/trendAction.js\":\"4879769f34f1241c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/verdict.js\":\"d6ff8100a71c9b81\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/plain-outliner/clickToEditAction.js\":\"6ff5d4ec2bdb53ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/plain-outliner/index.js\":\"943a87017573dd43\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/plain-outliner/interactions.js\":\"45e8cd084fa0fe8e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a5612a4a29f314c3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/MigrationGate.js\":\"b841d3e5a90c5e3e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/MigrationGateDialog.js\":\"214ca151299e6bb7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/action.js\":\"3a71f3d583638b53\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/index.js\":\"49c9d994b8fa78cb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/localRunMessage.js\":\"dfc825c8ddd266b0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/plugin.js\":\"6b3a4fc20e43dcd5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/progressReport.js\":\"8558ad19885b68fc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/sweepProgress.js\":\"0b12765235332dcf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/FieldRowRenderer.js\":\"ced0def5739db298\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/ValueRowRenderer.js\":\"c4942d2194f20eba\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/actions.js\":\"6221de96b3d8f6fa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/autocomplete.js\":\"e81f38242397b627\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/fieldRow.js\":\"b13346e0fbaeda13\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/index.js\":\"2d1db9db6c923cb8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/referenceWarning.js\":\"b566ff453063a50d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/valueAutocomplete.js\":\"fedbdbfe5fc3cb08\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/valueSchema.js\":\"292c99f7cca8f2a8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/HeaderItem.js\":\"455125a4959abeb1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/QuickFind.js\":\"70ff2a4505049367\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/index.js\":\"d159116c27b9c43e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/recents.js\":\"c14b13867a5632be\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/resultItems.js\":\"7eaf5032c71abb38\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/selection.js\":\"28fc8101fa23ac81\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/toggleStore.js\":\"8b62776f886994c8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/HeaderItem.js\":\"4b942a079441b4f5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c521c4d85f4389bf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/grouping.js\":\"7b18d4ec1ac52aa5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/index.js\":\"7a29578943462ca8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/target.js\":\"c165349e841b53c1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/codeMirrorExtensions.js\":\"ebf9fccd11ae0c43\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/contentPrefill.js\":\"47e7a8d45ce72df1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/dataExtension.js\":\"8bff4ac5c3577bf9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/index.js\":\"e18269a77a22b121\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0d506811466127e2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/invalidation.js\":\"be90e101d2329bfd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/localSchema.js\":\"16ae673a7d39aedb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/blockrefs/index.js\":\"06b60f4f01672590\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f2fb262d982edce7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/index.js\":\"fbdd2be5bee1744f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/referenceNode.js\":\"0b7cf0df72e5917a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c23861828023cd21\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e4570285c8ae2090\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/index.js\":\"f6b976b38aa0a322\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"9f1490622f550028\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c404fb70bf1a5d10\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/mergeRetargetProcessor.js\":\"eb8c25722cda74fa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/parseFence.js\":\"27d1a33fe9042618\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/referenceParser.js\":\"ab98d577c2756f35\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/referenceProjection.js\":\"b03bf01b8daa9e4c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/referencesProcessor.js\":\"523ea2331eb6ac81\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/renameProcessor.js\":\"317c0dd5c7df850f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/spanReplacement.js\":\"6192ee9cb4b17fbc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/htmlToOutline.js\":\"de22576587852c13\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/index.js\":\"b718ccba03d2e3cf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d0786977a7f8f163\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/pasteDecision.js\":\"858884bf25b4e85e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/action.js\":\"39fb51a3e97e39ee\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/blockIds.js\":\"fcdb7e8bb282680c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/content.js\":\"805fe5915dc0012a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/effect.js\":\"c9f8e50c2bd11fb4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/ids.js\":\"a1bbd148a5ca1e3b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/import.js\":\"4a84e9398dc049b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/index.js\":\"21ab4b6725d4232a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/plan.js\":\"76144f749fed0455\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/plugin.js\":\"fb5c5fa8da360917\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/promotion.js\":\"d0640d13bf076b41\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/properties.js\":\"42c19c38d4fd67f7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/references.js\":\"0c2126be077f9e07\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/report.js\":\"f99f6c0c933348cc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/roamMemo.js\":\"e44f57fd77374b83\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/runtime.js\":\"96bd60ebfe8833e3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/schemaReconciliation.js\":\"9ef54f6ec8bc947f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/srsMarkers.js\":\"140f49dfd4a85da8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/todo.js\":\"268f349dabfef795\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/typeCandidates.js\":\"284ee353d15de092\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/types.js\":\"1cf90e3e2249d7c5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/search-health/index.js\":\"a94d9988be3292f9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/search-health/store.js\":\"382e75016231f5a9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/HeaderItem.js\":\"e472fa4d0c58b2db\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7fa43d00cab0c8dd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/index.js\":\"6d2778751b28be06\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/model.js\":\"5df1316fe3fab2af\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/toggleStore.js\":\"f66d985baedaede7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/useKeyInspector.js\":\"f31eca2a8ed0d999\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3cbf7341e44fcead\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/ShellDecorator.js\":\"4d63b12f924e83fd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/actions.js\":\"6e2028fc6eb7abf9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/exclusionsFacet.js\":\"193d8f3ed95c5263\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/index.js\":\"8e3743a21926a075\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/shell.js\":\"1a871ae1591fffd7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/surface.js\":\"4d97cf1627763947\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/walker.js\":\"1e344ec8e5ce345e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d590cb53ad760b23\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/dataExtension.js\":\"093951bfcb12e214\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/index.js\":\"e09665d3838e8bf2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/indicator.js\":\"000b071a2920e2e0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/moveSrsState.js\":\"00c2863ab86d1edb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"71ae7a1f9f58c6f8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/scheduler.js\":\"0ec79b35ed5af477\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/schema.js\":\"a23a16730f0375ab\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"35d74162e3863c08\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/srsClipboard.js\":\"9d07eab2d62f0872\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b81c988d472c9b97\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/DailyNoteReviewHint.js\":\"52ace0184ef960ac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/DeckPicker.js\":\"ba95bd6bc3837f03\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/ReviewControls.js\":\"9f17c6606684e97a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1abb73820c9b9c98\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/ReviewSession.js\":\"f5bf9b8f5d7bf8c1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/actions.js\":\"ac5c054016089236\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/archive.js\":\"2585a2dac353b46f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/dataExtension.js\":\"40884d0837ecd81c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/deck.js\":\"d0a586b46ffef734\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/dueQuery.js\":\"44b74db7722ffb54\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/gradeDecision.js\":\"80bbededcb4fdd19\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/index.js\":\"f3d38042f5d2b24b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/keyHints.js\":\"4ce2ca9b4b053b73\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/reviewCardLayout.js\":\"4b6c61f9492399b8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/reviewProgress.js\":\"113bc86ea293ddc1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/schema.js\":\"270836c50e66a450\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/useDueCards.js\":\"e20f9b5024fa2188\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/startup-metrics/index.js\":\"859172a831fbcc6b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/startup-metrics/record.js\":\"ab6826b693f06481\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/storage-persistence/index.js\":\"3513f116de006947\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/storage-persistence/persistenceStatus.js\":\"59a1551ced6ca07f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/storage-persistence/requestAction.js\":\"9c4b9e331bfc943a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/TypeChipsDecorator.js\":\"bf4ab9ebbea0e736\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/codeMirrorExtensions.js\":\"80cfea437ec14763\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/index.js\":\"74d709d360f94c0f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/typeAutocomplete.js\":\"91d42f423ff9feac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d4029059434ddc65\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/actions.js\":\"a32fff37614d8dda\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/anchor.js\":\"e81fe074ff510d36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/events.js\":\"6c8fec1e98173f67\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/gestureActions.js\":\"efe02256a4036108\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/index.js\":\"5246c749f79e4feb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"133bae681bb9cd7a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/sync-metrics/collect.js\":\"3dc2d58a6b6362e7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/sync-metrics/index.js\":\"24c808512d2525f2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/sync-metrics/record.js\":\"9558b1d271a822b3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/RejectionDialog.js\":\"0899afd3172337b7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1130d082022461fd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/index.js\":\"cb24ebee75eeb944\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/model.js\":\"2b5c6442afd32df4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/queueCounts.js\":\"0c1e81d71c5c5a35\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/rejectedHelpers.js\":\"0a68f4b670ad8294\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/rematerializeAction.js\":\"f23bfc4fd8104b92\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/useHysteresis.js\":\"7fc3de2fe52a6e89\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/ColumnHeaders.js\":\"975ff0d1a5e39000\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/QueryUi.js\":\"a121cace8a36e587\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/TableLayout.js\":\"1832c85c63f51103\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/actions.js\":\"b61770d492e12799\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/cellEdits.js\":\"ef61391a2d2182ff\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/columns.js\":\"6889ebd4fde6f09f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/controller.js\":\"1cd5ce8248cf7d9e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/convert.js\":\"c26efa61926ffa88\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/dataExtension.js\":\"55d93c8106a67361\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/index.js\":\"43538e82bbef11c6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/keys.js\":\"a3300c47fcbc9ded\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/model.js\":\"12371a88237f7aa6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/navigation.js\":\"d3cef6bc044dd9b6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/backfill.js\":\"c318432838719e04\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/completion.js\":\"3dba81bf42e104ef\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/format.js\":\"b8c39c87350a65ed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/parse.js\":\"64326e844efe79e1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/queryValue.js\":\"efc56f42f22ad8cb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/source.js\":\"3df2916ae3f1b277\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/registry.js\":\"dffd00168b1b11f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/rowGutter.js\":\"5bdc8ee79f11bebb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/rowVerbs.js\":\"ae7a55dc82637f0e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/schema.js\":\"6860cd9ea894aa30\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/sort.js\":\"0118f8d50baad893\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/theme-toggle/effect.js\":\"fc8d1571fee489e0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/theme-toggle/index.js\":\"778b1f70569496d2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/theme-toggle/theme.js\":\"cd1442cd78e68c6e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/actions.js\":\"d55c660f5b210a7e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/dataExtension.js\":\"fceee3770606eec4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/index.js\":\"7ab81e7a77d83310\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/schema.js\":\"8ad1e66652b42a7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8f22bc863563bbf9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/actions.js\":\"ac3b33b92806640a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/defaultItems.js\":\"b7cab1f644bbd769\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/facet.js\":\"69f2364c882708d9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/holdRecognizer.js\":\"b954d537f91b7dfb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/index.js\":\"3423a0f919a0a2e6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/update-indicator/UpdateIndicator.js\":\"df4c7d1bfaeedd13\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/update-indicator/index.js\":\"8c2245dc4bd63b7a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/update-indicator/loadTimes.js\":\"56f8f78c2271a35c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/VideoNotesRenderer.js\":\"cf84b69712882c1b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/VideoPlayerRenderer.js\":\"9a3a356e8e522747\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/VideoTimeStamp.js\":\"3f8140f7fb29b5fa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/actions.js\":\"746f18c0a74b7965\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/index.js\":\"a7d3227e0ef31b2d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/markdown.js\":\"c080e00875f4dcfd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/notes.js\":\"a549f6f58770337f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/registry.js\":\"153cb82b20abcb7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/remark-timestamps.js\":\"f8b4f628155a4d94\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/view.js\":\"92b2a594711f906f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/LinkHints.js\":\"46e611dea90aff8e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/index.js\":\"c99338b348050234\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/model.js\":\"30d9556be41119cf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/settings.js\":\"28aadf32045d6635\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-normal-mode/actions.js\":\"f2fbbd1e1b4aa4f0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-normal-mode/index.js\":\"ec839ce32a42083f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-normal-mode/interactions.js\":\"7b31794a6a55bc15\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/workspace-header/index.js\":\"5624b7bf11f3fe86\",\"/knowledge-medium/pr-preview/pr-1853/src/registerServiceWorker.js\":\"28ae8265f7f2f475\",\"/knowledge-medium/pr-preview/pr-1853/src/requestPersistentStorage.js\":\"eb5ca4df651e9732\",\"/knowledge-medium/pr-preview/pr-1853/src/services/authRequestDeadline.js\":\"58c52ed802175327\",\"/knowledge-medium/pr-preview/pr-1853/src/services/authStorage.js\":\"9d823bec6c27cc3d\",\"/knowledge-medium/pr-preview/pr-1853/src/services/powersync.js\":\"c9a9738d22a0b697\",\"/knowledge-medium/pr-preview/pr-1853/src/services/supabase.js\":\"fb7503930fe8933f\",\"/knowledge-medium/pr-preview/pr-1853/src/services/uploadErrorClassifier.js\":\"c6e9a95daac38d53\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/ActiveContexts.js\":\"b14cdd49a74aabe3\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/HotkeyReconciler.js\":\"3282ff74e3a0df9a\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/WipeLocalDataDialog.js\":\"fb3b0bc83f6fed66\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/actionDispatch.js\":\"0c1a7ac11bf0ebb1\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/actionRefItems.js\":\"b5a91662e32b85e2\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/applyKeybindingOverrides.js\":\"617302a81a0067ab\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/blockActions.js\":\"a25d02c1eba664ba\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/blockMergeGesture.js\":\"f6d23dcb43e59f04\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/canonicalizeChord.js\":\"6b53a7b3f23b9ac7\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/defaultContexts.js\":\"c8f5fb8a46bce5f4\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/defaultShortcuts.js\":\"f4f86ddcafb07c32\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/effectiveActions.js\":\"734e7ed637404149\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/gestureAction.js\":\"f2b402a97ec2a64c\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/gestureBinding.js\":\"d140957b13bf5bd3\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/holdRegistry.js\":\"2da90a88b3c16993\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/keybindingConflicts.js\":\"b89ad3c6aa389dec\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/keybindingOverrides.js\":\"9a40f7a46ee54a99\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/pointerAction.js\":\"1091f6a644bba1ea\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/resolve.js\":\"a6206b394c5cb988\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/runAction.js\":\"a97515b06c8196b1\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/sequenceMatcher.js\":\"98abcbeb59074b31\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/types.js\":\"ad3e4816f85df6bf\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/useActionContext.js\":\"cc9a62a5640d58c1\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/useActionDiscovery.js\":\"c0d9c1460ba199e3\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/utils.js\":\"af3e970e77bcfd76\",\"/knowledge-medium/pr-preview/pr-1853/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1853/src/sw/bootStore.js\":\"dda9ba0dc91d786e\",\"/knowledge-medium/pr-preview/pr-1853/src/sw/previewDatabases.js\":\"ccdb74f09a1e9e31\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/byteTransform.js\":\"a1977ffdd479f615\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/attachmentCleaner.js\":\"d01baac030cef7dd\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/attachmentParts.js\":\"d77b23c28712fca2\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/bundleParts.js\":\"7ac070dcc64267bc\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/bundleRecord.js\":\"44591ca9355a1436\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/manifest.js\":\"6e0c95ca4f1fa62e\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/takeBundle.js\":\"1a14f20b39741df0\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/verifyBundle.js\":\"89fca02d27a22a15\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/cleaningStage.js\":\"9f423bea35460e60\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/conversionKey.js\":\"6f783850f9dc308f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/conversionServer.js\":\"d8ae17da3d12d7ff\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/flip.js\":\"1acd75a70d8c743f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/flipAttempts.js\":\"7e54a732a33ce156\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/pages.js\":\"a42d37544a41d0f2\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/preflight.js\":\"156db6fb5c8c5834\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/reseal.js\":\"2237dfbf51f54303\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/runConversion.js\":\"d149c33e4e028b6e\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/runLock.js\":\"0f134f76656484c1\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/sealing.js\":\"25285792be526e96\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/sealingStage.js\":\"f5eebdb5d88d9075\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/stage.js\":\"4527ea99a45e36d7\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/verifyReseal.js\":\"5fac219602856ce9\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/aad.js\":\"6b7ca3fdc2425102\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/aead.js\":\"1ac7e47879c281ab\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/base32.js\":\"2170c3de5715d762\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/base64url.js\":\"1296d779ddccc7b4\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/binaryEnvelope.js\":\"6f76c710bb54f7e8\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/byteAead.js\":\"6a826be6fdb65f8f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/canary.js\":\"d79f79f3cbbd7790\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/contentHash.js\":\"86422ff7e3f420eb\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/contentKey.js\":\"05a44ca1eec9f066\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/derivedIdNamespace.js\":\"dbc93a528ffa5038\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/envelope.js\":\"c52eaf9b05224d8f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/hex.js\":\"cef3c1728c9a51bb\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/sha256Hex.js\":\"9a43c2efe76e7c04\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/workspaceKey.js\":\"272541ffc51b996c\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/conversionState.js\":\"36539f470bb15644\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7325796759f95b98\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/pastedKey.js\":\"c5b2a0e0b3195158\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"668a6b71141633a8\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7c1b319f59d86d7f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/keyStore.js\":\"c4e92901cabb8840\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/mintWorkspaceKey.js\":\"b60eee72b70ec9d2\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/modePin.js\":\"3972c272e4b4a551\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/openWorkspaceKeys.js\":\"b938a5361b83beae\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/resolveWorkspaceEntry.js\":\"7d144598114b3695\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/resolver.js\":\"9a56d91337828818\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/workspaceAccess.js\":\"75454bebec867935\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/transform.js\":\"27c0507f3237dab9\",\"/knowledge-medium/pr-preview/pr-1853/src/themeBootDefaults.js\":\"7ef931e4867b1482\",\"/knowledge-medium/pr-preview/pr-1853/src/types.js\":\"65cbb02ff8d20906\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/ClientLocalSettings.js\":\"f45e9cfcf684f874\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/abortableSleep.js\":\"485b5f3e4dd2f79b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/array.js\":\"687cd44b881ff0d2\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/backlinkAutocomplete.js\":\"8d68ae6dc119c10f\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/blockCrumbs.js\":\"59773d14510a2ef0\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/blockrefAutocomplete.js\":\"d1426baf602c7d44\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/cadencedIdleJob.js\":\"2c9ea086869795c7\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/callbackSet.js\":\"c6866a9eda3204f8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/clientId.js\":\"578ad84e5eae8e5e\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/codemirror.js\":\"eef777c2633745a1\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/codemirrorCompletion.js\":\"388512b0b0f86631\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/copy.js\":\"d07d44fa3aa0fa37\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dailyPage.js\":\"c4c2dc54fc1f256a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dbForensics.js\":\"8491138e3cd9c69c\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dbForensicsHooks.js\":\"3c7019e733999bb8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/deleteBlockThroughUi.js\":\"23facf3555d0da5f\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dialogs.js\":\"8aed0cc9958efa09\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dom.js\":\"8dca164207bf3374\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/downloadBlob.js\":\"693ba8670eeaa342\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/exportSqliteDb.js\":\"d6d178780adb69d5\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/fileSystemAccess.js\":\"21dbd54e0c3ea044\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/flipSlide.js\":\"36a6cf76236a5de8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/fnv1a.js\":\"b6e4a33de5cad3e8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/formatBytes.js\":\"41ed19bec94fa11f\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/fuzzyRank.js\":\"df8eb9e1ea19e121\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/idbKeyedStore.js\":\"c8505a1a9c434fa3\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/idleCallbackPolyfill.js\":\"2b2ecd282d6b174a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/keyboardAwareScroll.js\":\"ee1a1693cb78c622\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/keyboardViewport.js\":\"90837b67b6f331f6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/lastWorkspace.js\":\"07df25da1b5c2a18\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/layoutColumns.js\":\"f8d93650b78dabe6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/layoutSessionDom.js\":\"0e97063b199d6b66\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/layoutSessionId.js\":\"378e962d3a8692eb\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/linkClickGestures.js\":\"67dd6a46ac8d8142\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/linkTargetAutocomplete.js\":\"10e0a4fb207991f4\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/localDbCorruption.js\":\"1a0efcda8cc0f60c\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/localDbRecovery.js\":\"89c1ed24a29e1b56\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/markdownParser.js\":\"661f1baa8e95c092\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/memoize.js\":\"762cbe1aed7842dc\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/nameFieldCommit.js\":\"6db4b3b6de99563a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/nameList.js\":\"32b10c203d1d98ad\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/navigation.js\":\"1861c6680b54a4a8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/omnilinerNamespace.js\":\"9e1c6ec951d2e994\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/opfsPageScan.js\":\"3e7e9db2236bc95a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelClearance.js\":\"d5d29eaf01abed43\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelHistory.js\":\"ea195c1771c96ea6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelLanes.js\":\"2f2f4b4b62d75afc\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelLayoutProjection.js\":\"0f0da6b5df31b375\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelScrollAnchor.js\":\"2b5e8ca9c4bdf125\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelUrlFlags.js\":\"ef2116e836a351d5\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/platform.js\":\"e0ed49ebf2698cc1\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/pluralize.js\":\"fe3ed1328188a074\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/propertyCreation.js\":\"9f802b52833971bd\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/propertyNavigation.js\":\"87c9ea2d8188918e\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/propertyValueContext.js\":\"ae1bb3a21b150c24\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/react.js\":\"9d812f15ac17d6d2\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/relativeDate.js\":\"06cc290bb0a32a77\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/relativeTime.js\":\"cb3261722667707c\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/renderScope.js\":\"7b68a7467e1fe7c9\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/resolvedThenable.js\":\"62e5ef31ee721eac\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/routing.js\":\"d941b4aa53b82e6a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/safeMode.js\":\"1979917e2c52f69c\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/scheduleIdle.js\":\"44e2db8d24fd937f\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/screenWakeLock.js\":\"b05918457616164d\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/selection.js\":\"fb34974e685fdb9d\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/softKeyboardGrab.js\":\"81278aaabc5ae396\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/startupTimeline.js\":\"78f238cdeb1c9eba\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/state.js\":\"e28d22e6bbe1c4a9\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/string.js\":\"655ba8aaa1c47776\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/surfaceZoom.js\":\"68151a4bbd06ee06\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/time.js\":\"5eb1813ec8a9b106\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/toast.js\":\"535c7275d917611a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/toggleStore.js\":\"1da392cc61e84767\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/untilStopped.js\":\"fab68e89a43c8464\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/userActivity.js\":\"93c9ec470b89ddd6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/viewTransition.js\":\"fc54a5598c87108b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/viewport.js\":\"13fe7d97079f53f1\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/webLock.js\":\"a924c73367242770\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/workspaceRecovery.js\":\"196a0b82f44b6e20\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/workspaceSnapshotStore.js\":\"26c871b95118eecc\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-compiler-runtime.js\":\"67012941e0b371b9\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-client.js\":\"a46d074aed037a62\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-server-edge.js\":\"a20fee3d243d3c61\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-server.js\":\"710a082474b21dcb\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-static-edge.js\":\"a0046a9634c5e94b\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-static.js\":\"37076589e209e1c7\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-test-utils.js\":\"855be93f39949f06\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom.js\":\"a770828099a7304b\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-jsx-runtime.js\":\"8b0b22a56c296b55\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react.js\":\"0969c9137b55869f\",\"/knowledge-medium/pr-preview/pr-1853/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1853/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1853/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
