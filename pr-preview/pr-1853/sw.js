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
		buildId: "ab4311b7422e-7a5835fb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1853/\":\"bdd939569b18d539\",\"/knowledge-medium/pr-preview/pr-1853/index.html\":\"bdd939569b18d539\",\"/knowledge-medium/pr-preview/pr-1853/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1853/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1853/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1853/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1853/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1853/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1853/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1853/assets/FacadeVFS-D2cKTQY3.js\":\"eced0b48bf84359b\",\"/knowledge-medium/pr-preview/pr-1853/assets/OPFSCoopSyncVFS-DpNpV0Uk.js\":\"af1eccb581d77a0c\",\"/knowledge-medium/pr-preview/pr-1853/assets/OPFSWriteAheadVFS-Bc5wJOHI.js\":\"987221683386be0e\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-DVgyRN93.js\":\"0f311009efbb4711\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1853/assets/wa-sqlite-async-Cy0YMqZJ.js\":\"53139d8461676e16\",\"/knowledge-medium/pr-preview/pr-1853/assets/worker-D6_9Bz_8.js\":\"7169df211491b8da\",\"/knowledge-medium/pr-preview/pr-1853/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1853/chunks/app-BQKPjqVR.js\":\"020b4b5aae1fc20a\",\"/knowledge-medium/pr-preview/pr-1853/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1853/index.js\":\"d11ad3a46e38f32a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1853/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1853/assets/AccessHandlePoolVFS-C6-MrP1Y.js\":\"05d7886ac22e0f33\",\"/knowledge-medium/pr-preview/pr-1853/assets/IDBBatchAtomicVFS-B5uk7BH6.js\":\"0f6d11bebdabc6d0\",\"/knowledge-medium/pr-preview/pr-1853/assets/MemoryVFS-GpX9H-BT.js\":\"a0e0f1dc810d2399\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-BOhpH9X4.js\":\"5c1c774a3e1f8791\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-async-B6q1gnGN.js\":\"3016b27955e75280\",\"/knowledge-medium/pr-preview/pr-1853/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1853/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1853/chunks/AccessHandlePoolVFS-9ipf36KE.js\":\"512b4463f850f408\",\"/knowledge-medium/pr-preview/pr-1853/chunks/FacadeVFS-DAXzFp2-.js\":\"8f661916a03bf02b\",\"/knowledge-medium/pr-preview/pr-1853/chunks/IDBBatchAtomicVFS-CtJxQ9aE.js\":\"8f8673696476bb7b\",\"/knowledge-medium/pr-preview/pr-1853/chunks/MemoryVFS-BDdMTBqw.js\":\"ef308c3dd654ac5c\",\"/knowledge-medium/pr-preview/pr-1853/chunks/OPFSCoopSyncVFS-vmmMlHzB.js\":\"c6392643b9a75ce5\",\"/knowledge-medium/pr-preview/pr-1853/chunks/OPFSWriteAheadVFS-wElqsTt1.js\":\"a4166ee2163cd4ee\",\"/knowledge-medium/pr-preview/pr-1853/chunks/Preview-CsOlnmHw.js\":\"a4904d5f4ed4728e\",\"/knowledge-medium/pr-preview/pr-1853/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1853/chunks/card-CVARwbHn.js\":\"ec80453c505cbea1\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dist-4KQq0m_R.js\":\"a4304a7e04731287\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1853/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1853/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1853/chunks/mc-wa-sqlite-16CyqQnj.js\":\"2334ae011fefd3f7\",\"/knowledge-medium/pr-preview/pr-1853/chunks/mc-wa-sqlite-async-Ckkls8UW.js\":\"ac51e01ad2d79bd7\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-C8jJOD6H.js\":\"23fde8fe4cdfa5ee\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-CGS_bLp9.js\":\"067fe048404e76f6\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-CeBbjCZu.js\":\"dbbef43f16af6ca7\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-ChgJJ8cE.js\":\"ed8fba4c5b698e31\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-ChuydIFR.js\":\"02a21f6f335e3b73\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-D-f3IZdM.js\":\"ba2a24c05d5fc7c4\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-DKD9jSXf.js\":\"87971ec884b6115d\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-U9D9PJWH.js\":\"807161d226587735\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-dom-server-legacy.browser.production-DDfTESw8.js\":\"df59528cce00ffd2\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-dom-server.browser.production-BdfTivy_.js\":\"4400e10d4e19a6ff\",\"/knowledge-medium/pr-preview/pr-1853/chunks/react-dom-server.edge.production-JYJ0UPgR.js\":\"1635c500bec50391\",\"/knowledge-medium/pr-preview/pr-1853/chunks/server.browser-DPzylQxT.js\":\"2856c9fdc8d41bb4\",\"/knowledge-medium/pr-preview/pr-1853/chunks/textarea-QvRRiD7S.js\":\"3c7b8d1e1f235741\",\"/knowledge-medium/pr-preview/pr-1853/chunks/ui-DFJuGAsV.js\":\"4cb720eb8ba60ac6\",\"/knowledge-medium/pr-preview/pr-1853/chunks/wa-sqlite-DS1075cn.js\":\"d49ced098caa295b\",\"/knowledge-medium/pr-preview/pr-1853/chunks/wa-sqlite-async-Dcq9Edp7.js\":\"57757bc8be245aad\",\"/knowledge-medium/pr-preview/pr-1853/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1853/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1853/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1853/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1853/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1853/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1853/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1853/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1853/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1853/src/App.js\":\"0df8d1906bb09835\",\"/knowledge-medium/pr-preview/pr-1853/src/appUpdate.js\":\"0a7ceb22ceb3d0aa\",\"/knowledge-medium/pr-preview/pr-1853/src/appVersion.js\":\"19a70f642e83d9c2\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/initialLayout.js\":\"d529db5b44348fa0\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/openWorkspaceData.js\":\"3aa861366f83b639\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/resolveWorkspace.js\":\"efaab6817a8cb3f3\",\"/knowledge-medium/pr-preview/pr-1853/src/bootstrap/workspaceBootstrap.js\":\"43e9b7dff4193d83\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockComponent.js\":\"2570c40f217a9199\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockCrumbs.js\":\"46ab8f82b53a64bc\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockEditor.js\":\"4afd12a00ce67a22\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockLoadingPlaceholder.js\":\"6b542c6910a96443\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockProperties.js\":\"541d0dca5a014a99\",\"/knowledge-medium/pr-preview/pr-1853/src/components/BlockSearchPicker.js\":\"c971e5dfe1165b2d\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ConfirmBulkDeleteDialog.js\":\"8bda93192b13dce3\",\"/knowledge-medium/pr-preview/pr-1853/src/components/DividerHandle.js\":\"8f4f84e840e5e754\",\"/knowledge-medium/pr-preview/pr-1853/src/components/DraftEditor.js\":\"bc2775c13d464a0b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/GutterPill.js\":\"e1304c330a29dd92\",\"/knowledge-medium/pr-preview/pr-1853/src/components/Header.js\":\"02a962829021e699\",\"/knowledge-medium/pr-preview/pr-1853/src/components/LazyBlockComponent.js\":\"faa04ea60fbd4aa0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/Login.js\":\"e94fb9182f792fe1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ZoomableSurface.js\":\"0ee55961b1f21fae\",\"/knowledge-medium/pr-preview/pr-1853/src/components/editModeKeepalive.js\":\"6bea4ab49edebc90\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e36efcbc59a92d13\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4010804c240084bd\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/RefPropertyEditor.js\":\"69e8566a896e4e3e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/RefTargetTypePicker.js\":\"3d21246716d87224\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/SelectPropertyEditor.js\":\"dc7e61ce1eb49220\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/TypesPropertyEditor.js\":\"a35018a6bbcc9849\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/defaults.js\":\"73c0e47abfa47b5e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/kernelValuePresets.js\":\"843ea30ac36b2b83\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/selectablePresets.js\":\"caa4a96aa2598924\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyEditors/typesPropertyUi.js\":\"fe3114a7fce213b3\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/AddPropertyForm.js\":\"c67d4dd26c2fd751\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/PropertyPicker.js\":\"e8a177c3ef0b31d5\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/PropertyRow.js\":\"faeeae6569d05050\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/Rows.js\":\"4374f05631a4a213\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/actions.js\":\"32fa6abf8602b458\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/declarationOnly.js\":\"a99034ca059bbbe5\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/layout.js\":\"567962140796885b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/model.js\":\"8b4b8ce9710b9931\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/shapeUi.js\":\"68fc157cdf5998a0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/shapes.js\":\"b10122ba1ac02c5c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/usePropertyEditingActivation.js\":\"451ed62eeb9a3e32\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanel/visibility.js\":\"8c103317122e22ea\",\"/knowledge-medium/pr-preview/pr-1853/src/components/propertyPanelSections.js\":\"13802acba80761c6\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/BlockEmbed.js\":\"ca70af9632f94aa2\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/BlockLink.js\":\"043e06a8867a102a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/BlockRef.js\":\"2e0d4e6ccd4820ab\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/ReferenceLink.js\":\"955f197fc0fbea03\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/cycleGuard.js\":\"8f6a3934d47cd116\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/cycleGuardContext.js\":\"d1b60beba9d531a8\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/linkInteraction.js\":\"1e4b4a17edfa7954\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/referenceLayout.js\":\"5c4ad2ea7c3dad33\",\"/knowledge-medium/pr-preview/pr-1853/src/components/references/useBlockRefAncestors.js\":\"88ae7e2ae2d3eec9\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BlockGutter.js\":\"4b20dc5601feb2f8\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BlockInfoDialog.js\":\"3a4196bd48aac858\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BlockTypeBlockRenderer.js\":\"bf0cd83ca1d5367e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/BulletHoverCard.js\":\"f81d988a1ff49cb7\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/CodeMirrorContentRenderer.js\":\"32ef7036359c4877\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9705c0187f0c8770\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/ColumnResizeHandles.js\":\"e6d8fbe9074f27b6\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ba32df0fee10eb70\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/DefaultBlockRenderer.js\":\"42956c1a1f520d1c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/LayoutRenderer.js\":\"4b9817dcbfeaa85b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/MarkdownContentRenderer.js\":\"ab57d9e18a195f33\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/MissingDataRenderer.js\":\"e74d13be27001cb0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/PanelRenderer.js\":\"ce0cb325875508e9\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/PropertySchemaBlockRenderer.js\":\"48f1887f92ca80c5\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/TopLevelRenderer.js\":\"f6eff0f52891a0dc\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/blockGutterMode.js\":\"bacbe57d2efa11e0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/blockTitleText.js\":\"4514565e9f72e5ff\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/fieldCreationKeydown.js\":\"ad4fe0ff26ce47d8\",\"/knowledge-medium/pr-preview/pr-1853/src/components/renderer/layoutRootContext.js\":\"ac43c6be6e741f10\",\"/knowledge-medium/pr-preview/pr-1853/src/components/typeChip/TypeChip.js\":\"cf8af315e63fcfae\",\"/knowledge-medium/pr-preview/pr-1853/src/components/typeChip/chipStyle.js\":\"8c147d21b7604702\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/anchored-floating.js\":\"2390c1ce2d994300\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/button.js\":\"1fe7c4b1edbe8d5f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/card.js\":\"108f92d856009d26\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/checkbox.js\":\"fd5a9331dcdee4db\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/collapsible.js\":\"1ba93b53b7a63058\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/command.js\":\"d83e56f0798719be\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/context-menu.js\":\"a0c46e82e3a028c7\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/dialog.js\":\"29b52ce5fefaacee\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/dropdown-menu.js\":\"b6cfb0631616e7f9\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/floating-listbox.js\":\"871e251e33a6863b\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/index.js\":\"2e574a5b95311cfc\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/input.js\":\"91fca2e122fd1ff9\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/kbd.js\":\"f641fab30ce9dea6\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/label.js\":\"7f83d2419c0b0a52\",\"/knowledge-medium/pr-preview/pr-1853/src/components/ui/textarea.js\":\"a578fc116070c17f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/useEditModeYieldKeepalive.js\":\"8c8138c092981495\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/BootFallback.js\":\"58ef8b6a918e8436\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/FocusedRowLazyMount.js\":\"836a1d611268e50c\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/LazyViewportMount.js\":\"695388137f11bf36\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/LocalDbCorruptionFallback.js\":\"438371dd47c032a0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/error.js\":\"12521af85a256359\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/lazyMountRegistry.js\":\"00bd4291a94cb29f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/util/suspense.js\":\"db560e99d93551b4\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/CreateWorkspaceDialog.js\":\"9402af7cdf9daf4a\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/PendingInvitations.js\":\"940dfc956a255742\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/SyncProgress.js\":\"2b4bfb3703509082\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/UnlockProgress.js\":\"8be365b5b0d6f223\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceKeyGate.js\":\"6de7dbb884af2a2f\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceSettingsDialog.js\":\"c716d5918fc737b6\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceSwitcher.js\":\"beec685f1bcd9ca0\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/WorkspaceSyncGate.js\":\"7aafa46bee1e1268\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/ConversionFlow.js\":\"a9c97c5957f414ee\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/ConversionFlowHost.js\":\"e4914151f99e4806\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/EncryptionSection.js\":\"2d4e7e07495ee952\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/attachmentPrompts.js\":\"1ab2938074c22b43\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f65e9a686c59c914\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/conversionFlowDeps.js\":\"ab7ee780dcf063fd\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/conversionFlowStore.js\":\"3c683749db417c1e\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/flowUi.js\":\"778c8c933fd8d0b1\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/conversion/useConversionRun.js\":\"7861a8575a6f7e36\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/keyUi.js\":\"e2a70479bf387100\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/useCloseOnKeyLoss.js\":\"915a55e9d8d94508\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/useCloseOnServerE2ee.js\":\"b65c1450f51c5394\",\"/knowledge-medium/pr-preview/pr-1853/src/components/workspace/workspaceUnlocked.js\":\"e094007336733fcc\",\"/knowledge-medium/pr-preview/pr-1853/src/context/backgroundSubtree.js\":\"94586843a0889ae4\",\"/knowledge-medium/pr-preview/pr-1853/src/context/block.js\":\"6e8febef366cd3f2\",\"/knowledge-medium/pr-preview/pr-1853/src/context/layoutWsContext.js\":\"6539cf2652c705dc\",\"/knowledge-medium/pr-preview/pr-1853/src/context/propertyDisplay.js\":\"e688e89f3301e354\",\"/knowledge-medium/pr-preview/pr-1853/src/context/repo.js\":\"5ffbad3e582bafe6\",\"/knowledge-medium/pr-preview/pr-1853/src/data/aliasClaim.js\":\"c0eb4a09035469df\",\"/knowledge-medium/pr-preview/pr-1853/src/data/aliasSeatNamespace.js\":\"6480df11110ea9ad\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/blockData.js\":\"d1969ea7eb235af2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/blockType.js\":\"ff9177d7279fbf28\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/changeScope.js\":\"dae0663997773a5c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/codecs.js\":\"32c7b33886fcecc0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/derivedData.js\":\"46c4ed92e5661a6c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/errors.js\":\"8e4d8ce1f4d1569b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/events.js\":\"2d7fc69a6daffa70\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/handle.js\":\"eb35f5866dfa7f31\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/index.js\":\"011595bac4506b90\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/mutator.js\":\"1ff09ce04ad22ce8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/processor.js\":\"08f398720a8e8033\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/propertySchema.js\":\"f3e598bb7ca9128d\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/query.js\":\"08bb2630c9ac979d\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/sameTxProcessor.js\":\"b188c7d7a905af03\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/schema.js\":\"eb35f5866dfa7f31\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/tx.js\":\"eb35f5866dfa7f31\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/typedBlockQuery.js\":\"f3ed2d4045ba5429\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/user.js\":\"9846a1b31670cb89\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/valuePresetCore.js\":\"db24ee99b8b8c1ab\",\"/knowledge-medium/pr-preview/pr-1853/src/data/api/valuePresets.js\":\"e7954a40b590c31b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/attachmentCleanerIOVerb.js\":\"2a5643e7d19df3a2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/block.js\":\"6985049b9dd708fe\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockCache.js\":\"93f260092ea6110c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockId.js\":\"0d9630de3574f1e2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockLiveness.js\":\"25936e6223ab1a74\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockMerge.js\":\"38eda7f75cc89197\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockSchema.js\":\"18dba12afe560d41\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockTypeLookup.js\":\"f1904d1e06e5593a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/blockTypes.js\":\"b7f815766046f146\",\"/knowledge-medium/pr-preview/pr-1853/src/data/clientContext.js\":\"08a3ade6ec050158\",\"/knowledge-medium/pr-preview/pr-1853/src/data/dbFileSiblings.js\":\"86ed525f25a60ed4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/definitionSeeds.js\":\"73874028ad54ff42\",\"/knowledge-medium/pr-preview/pr-1853/src/data/derivedIds.js\":\"66b895939ebc6872\",\"/knowledge-medium/pr-preview/pr-1853/src/data/drawnSubtree.js\":\"e88fdd1cbf4da076\",\"/knowledge-medium/pr-preview/pr-1853/src/data/facetBridge.js\":\"0fb45ca7d6dc7429\",\"/knowledge-medium/pr-preview/pr-1853/src/data/facets.js\":\"c00c5961093b85e9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/globalState.js\":\"240d9e6f4cfde7b3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/aliasClaimRederiveProcessor.js\":\"9f3f2b2106ce20dc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/ancestorBatch.js\":\"274d66905b0c8004\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/blockTypeTypeifyProcessor.js\":\"a00dc5f7cfe38f16\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/clientSchema.js\":\"cadc6106e6fa9fce\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/commitPipeline.js\":\"4c56194dd2754679\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/devAssertions.js\":\"c23efd5be3409b15\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/firstSync.js\":\"e8dbda52ec5ca524\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/freshInitialLoad.js\":\"53a954c7f6a76968\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/graphBackfillClaim.js\":\"c27eddab2529c453\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/handleStore.js\":\"eaf92980d61ec361\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/idleMarkerJobs.js\":\"add524bf0755dde5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/initialDownload.js\":\"e463b8039cb4b893\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/initializeClientDatabase.js\":\"d1050ce3081d6d64\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/jsonCanonical.js\":\"d1467c3af855ce96\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/kernelInvalidation.js\":\"c0b483c1c3c5d206\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/kernelProcessors.js\":\"41ec7df95510f5a4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/kernelQueries.js\":\"fa553c1beb5e44c2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/mergeTypeMembershipProcessor.js\":\"cf9ad89395506fee\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/normalizeReferencesProcessor.js\":\"904c769385d0b20a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/poolInstrumentation.js\":\"805a2681ba791de4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/processorRunner.js\":\"81dec1ff072d7177\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyCellBackfill.js\":\"8524044fe4a34b1e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyChildMint.js\":\"4889be905205db60\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyChildrenProcessor.js\":\"d30119fb3794cb07\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7ec36d7b36b47b45\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyDefinitionSynthesis.js\":\"d4a8baf6e66e1b58\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyKeyScan.js\":\"2acd9bfa7a9f5436\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertySchemaResolution.js\":\"a33b36f886518d8b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/propertyValueEdits.js\":\"7e3dd2b9d7818943\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/raiseProtocol.js\":\"07e3d76618bda583\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/readBatch.js\":\"aa42b6f50cd5d9d5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/refProjection.js\":\"b8c63c087f0ab6a8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/referenceTargetLookups.js\":\"024b4435fddafc28\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/referenceTargetProcessor.js\":\"57936ff72f39f561\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/replayMerge.js\":\"840a528e140cfc4f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/sqlBinds.js\":\"f2becb83b988c95b\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c35bb24fe0faaf80\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/arrivalProcessors.js\":\"c64f83d34c570b35\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/invalidate.js\":\"ce3b1195d83d1e3f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/materialize.js\":\"31a1f3cd2d581ce4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/observer.js\":\"6199f7dec4a8e06c\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/syncObserver/reconcile.js\":\"bc2155b36975b07e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/timingMetrics.js\":\"649507d313a2bfff\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/treeQueries.js\":\"5c53ce47273d28d8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/txEngine.js\":\"f49a99645b63e675\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/txSnapshots.js\":\"91e47d746c55b6b8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/typedBlockQuery.js\":\"2503ae27e014b82e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/internals/undoManager.js\":\"53bc802b71f337f6\",\"/knowledge-medium/pr-preview/pr-1853/src/data/invalidation.js\":\"a10e8bfdc49fffc7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/kernelDataExtension.js\":\"b89dfd5b98e84fc1\",\"/knowledge-medium/pr-preview/pr-1853/src/data/kernelPage.js\":\"c4542264449bb6e7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/kernelValuePresetCores.js\":\"8fa97eed57f516e2\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localDbCorruptionSignal.js\":\"0a6969302713e2d4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localDbStorage.js\":\"6119a161b6010bc8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localDbVfs.js\":\"7de0ff514307566e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/localSchema.js\":\"2a61dd26937e3999\",\"/knowledge-medium/pr-preview/pr-1853/src/data/maintenance.js\":\"9a4d6ee35b2514b8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/mergeProperties.js\":\"0e522fce86f1faa3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/metricsConsoleHook.js\":\"624bf8c7bdccd35d\",\"/knowledge-medium/pr-preview/pr-1853/src/data/migrationsPage.js\":\"55e49df7c31b1e17\",\"/knowledge-medium/pr-preview/pr-1853/src/data/mutators.js\":\"e54305b384998351\",\"/knowledge-medium/pr-preview/pr-1853/src/data/orderKey.js\":\"423282a4a0a86bcc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/orderKeyPlacement.js\":\"c6ce0601c0e90d94\",\"/knowledge-medium/pr-preview/pr-1853/src/data/outlineSurface.js\":\"66f7857371c1bf46\",\"/knowledge-medium/pr-preview/pr-1853/src/data/pendingEditorContent.js\":\"c340ba54732bcf4e\",\"/knowledge-medium/pr-preview/pr-1853/src/data/pendingUploadsSql.js\":\"ed6263ab7d51554a\",\"/knowledge-medium/pr-preview/pr-1853/src/data/pluginStateExtensions.js\":\"040a83c534aad83f\",\"/knowledge-medium/pr-preview/pr-1853/src/data/powerSyncLogger.js\":\"a94708adec79d3b0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/projectorRuntime.js\":\"f79c96e2fa053346\",\"/knowledge-medium/pr-preview/pr-1853/src/data/properties.js\":\"c3e6add0ea251e14\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertiesPage.js\":\"d4b9f6fc633df894\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyChildren.js\":\"645da2912ca5c537\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDefinitionFanout.js\":\"ecafe5e3e96c27c0\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDefinitionMetadata.js\":\"1fe7cebc52bbf30d\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDefinitionRegistry.js\":\"b3a96ae85ef28fe9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyDisplayMode.js\":\"dad6e8be3859f2e8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertyRowCreation.js\":\"f935bc202915e684\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertySchemaCreation.js\":\"8cd721bd56bb079d\",\"/knowledge-medium/pr-preview/pr-1853/src/data/propertySeeds.js\":\"ce81a68fa96854cc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/recentsPage.js\":\"d0d133c8f96c3295\",\"/knowledge-medium/pr-preview/pr-1853/src/data/referenceBlock.js\":\"d5990e2e64be99d7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/rejectedUploads.js\":\"49ec82d1812b85d5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/releasePowerSyncConnection.js\":\"146b8b35319c33f5\",\"/knowledge-medium/pr-preview/pr-1853/src/data/repo.js\":\"78dd44870728f534\",\"/knowledge-medium/pr-preview/pr-1853/src/data/repoProvider.js\":\"a068450cbc21afd1\",\"/knowledge-medium/pr-preview/pr-1853/src/data/rowProperty.js\":\"ea7c7a023b75ba96\",\"/knowledge-medium/pr-preview/pr-1853/src/data/searchFilter.js\":\"6520224f584dcd27\",\"/knowledge-medium/pr-preview/pr-1853/src/data/seedIdentityLedger.js\":\"8aea809d0bcc1231\",\"/knowledge-medium/pr-preview/pr-1853/src/data/stateBlocks.js\":\"7539db72b5a304dc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/structuralEditPolicy.js\":\"ef5b9e8e4881befc\",\"/knowledge-medium/pr-preview/pr-1853/src/data/subtreeDelete.js\":\"ebe08fe24ba1b9b9\",\"/knowledge-medium/pr-preview/pr-1853/src/data/syncStreamLock.js\":\"a3e6c17e1362b705\",\"/knowledge-medium/pr-preview/pr-1853/src/data/syncedTableSqlRecognizer.js\":\"e1d0f53c655215c7\",\"/knowledge-medium/pr-preview/pr-1853/src/data/syncedTableWriteGuard.js\":\"464ea98d783b0918\",\"/knowledge-medium/pr-preview/pr-1853/src/data/targets.js\":\"f76a8a19b46e37f4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeColors.js\":\"6bf8e807fb5e35d6\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeDefinitionMetadata.js\":\"c36053304ad32dd8\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeDefinitionRegistry.js\":\"e1def5aced07d064\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeExtraction.js\":\"58fe6c75aed96045\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeInitialValues.js\":\"dfd8792f142f3908\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typePropertyGroups.js\":\"076806afb509c3a3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeSeeds.js\":\"95c4961a2a5783cd\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typeTagger.js\":\"eddf655cceb56eff\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typedRecords.js\":\"2bbd55b8e02ea857\",\"/knowledge-medium/pr-preview/pr-1853/src/data/typesPage.js\":\"92634c564d60cc30\",\"/knowledge-medium/pr-preview/pr-1853/src/data/userPrefs.js\":\"56fb43fbe1806ace\",\"/knowledge-medium/pr-preview/pr-1853/src/data/userSchemasService.js\":\"e45313034a58b102\",\"/knowledge-medium/pr-preview/pr-1853/src/data/userTypesService.js\":\"0f6f94a0a0eab6c4\",\"/knowledge-medium/pr-preview/pr-1853/src/data/valuePresetRegistry.js\":\"8ee4ca4d3e88e512\",\"/knowledge-medium/pr-preview/pr-1853/src/data/visibleChildren.js\":\"baae21aada838570\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceConversion.js\":\"113d428fbcf1aeb3\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceFirstSync.js\":\"5e3d4ea47dd58b15\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceIdNamespace.js\":\"63cbaf36490a8caf\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaceSchema.js\":\"16e825abe083e061\",\"/knowledge-medium/pr-preview/pr-1853/src/data/workspaces.js\":\"92a83f790ef21614\",\"/knowledge-medium/pr-preview/pr-1853/src/data/writeAheadLog.js\":\"64523966d4217203\",\"/knowledge-medium/pr-preview/pr-1853/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/BlockPasteShellDecorator.js\":\"9966ea2e4871a483\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/atTrigger.js\":\"bdbabc575368c42b\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/autocomplete.js\":\"a680e99e6f56becf\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/codeMirrorExtensions.js\":\"eade009f41dc9615\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/contentFlush.js\":\"b79ee00e2af5da66\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/defaultInteractions.js\":\"187b411b7c0e6bde\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/editSettleSignal.js\":\"4412e14e83a6e2a2\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/insertImage.js\":\"409b2aaa3e6abb40\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/referenceCompletionRange.js\":\"43725e3eed5e9c96\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/referenceTargetTypes.js\":\"ead143e25d4b30d8\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/syntaxContext.js\":\"5a6cf144e89457c9\",\"/knowledge-medium/pr-preview/pr-1853/src/editor/triggerMatch.js\":\"185cb4ea8fe7bf4b\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/AppRuntimeProvider.js\":\"36e000f43568dba4\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/BlockFocusShellDecorator.js\":\"570edc6b16cae5af\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/ExtensionRenderBoundary.js\":\"1de3bd29da93743b\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/PanelContentRecovery.js\":\"5ef96f22b9235f79\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/apiCatalog.js\":\"190e3278a69b46c1\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/approveExtensionHere.js\":\"b42ade69133b76b5\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/armedCutAppMount.js\":\"0a36bd3afd06911e\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/batchableKeyedStore.js\":\"72aaf726d73c6430\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/blockInteraction.js\":\"75b2862f3685aec9\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/blockSelectionAction.js\":\"a3825b0292443902\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/compileExtensionModule.js\":\"7ea2c690934e272a\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/compiledModuleCache.js\":\"1837c67830e17e92\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/continuousGestures.js\":\"875bf2d996335f3d\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/core.js\":\"a391ba6a0756ebc6\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/defaultRenderers.js\":\"53e4e554400719c7\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/definitionFanoutAppMount.js\":\"8d8d163f6e4ce55b\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/dialogAppMount.js\":\"86070ba135dd12a5\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/dynamicExtensionSeeds.js\":\"266b8984decdd579\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/dynamicExtensions.js\":\"86c1250d8a418006\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/exampleExtensions.js\":\"a067ce7e5bf1f68e\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionApprovalStatus.js\":\"90b14459d0a29f52\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionLoadErrorToast.js\":\"eb65554042d0602e\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionLoadErrors.js\":\"8b2a7f8c4e4199d6\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionLookup.js\":\"7900244cfdbf8732\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionToggles.js\":\"e55d64520fa83341\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/extensionUtilitiesCss.js\":\"97d7ada8e35e907c\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/kernelPageDeletionGuard.js\":\"6e6eca0dfa96d0ca\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/liveRuntime.js\":\"b8f5d621436c8240\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/openExtensionsSettings.js\":\"dbbe4676cc52ecba\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/overridesCache.js\":\"9d048c3e076e419d\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/pluginIds.js\":\"a5982de8d7d20785\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/processorRejectionToast.js\":\"d73907ca1596ed56\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/runtimeActions.js\":\"a470737ec365fb87\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/runtimeContext.js\":\"bc26cdbd36af5e68\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/staticAppExtensions.js\":\"0244986e9de9a16e\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/staticDataExtensions.js\":\"eb3cc6057589e4e2\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/toastAppMount.js\":\"a19927036af1d869\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/useOverrides.js\":\"18fb3e2b43a6e991\",\"/knowledge-medium/pr-preview/pr-1853/src/extensions/useShortcutSurfaceActivations.js\":\"a0ae8e4fc5c2aa2f\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/discoverToggleTree.js\":\"eaf9ccd88c641da6\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/facet.js\":\"9fb306798e9bccd6\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/resolveAppRuntime.js\":\"fbadbe6dda727f92\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/runtimeEvents.js\":\"3c1bf900b30a240c\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/togglable.js\":\"5783951bdfb89af0\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/variantFacet.js\":\"592240d969ca1944\",\"/knowledge-medium/pr-preview/pr-1853/src/facets/verbFacet.js\":\"a969f66ee4496d33\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/block.js\":\"63e4dad8806fbf36\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/focusedChild.js\":\"ceac21bf446644b8\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/propertySchemas.js\":\"35b9abb1f0b62844\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/typeRegistry.js\":\"770cfcf46620d7d9\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useAncestorCrumbs.js\":\"a3890f5af419ecb7\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useAutocompleteListbox.js\":\"665efba621b74a69\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useDebouncedSearch.js\":\"9e373b000606922d\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useDebouncedValue.js\":\"ff11b01b6d6c966e\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useIsFocalRender.js\":\"1473df23b3870382\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useIsReadOnly.js\":\"4a00c3d4c93ed6ad\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useMaterializeBacklog.js\":\"ceb6c884c7ef2ecb\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useMinuteClock.js\":\"30fe9f4a526e581e\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/usePanelLayoutProjection.js\":\"86829db27f40fc34\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/usePendingInvitations.js\":\"21deb9941fb13c76\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useRendererRegistry.js\":\"6672a2c08ac04c16\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useRetainedFieldRows.js\":\"632fc321af323724\",\"/knowledge-medium/pr-preview/pr-1853/src/hooks/useWorkspaces.js\":\"ab6d6b695a081886\",\"/knowledge-medium/pr-preview/pr-1853/src/lib/utils.js\":\"42fe73caa8922fc0\",\"/knowledge-medium/pr-preview/pr-1853/src/main.js\":\"6446c40513213b39\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/MarkdownImage.js\":\"942ae6e9955fbbde\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/blockSeparators.js\":\"81c215d585f601fc\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/context.js\":\"bbaa6ff87a1b651e\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/defaultMarkdownExtension.js\":\"ae83ee9e5b4f43e5\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/extensions.js\":\"3111815a393fc825\",\"/knowledge-medium/pr-preview/pr-1853/src/markdown/renderMarkdownHtml.js\":\"2c99bdf103f8b380\",\"/knowledge-medium/pr-preview/pr-1853/src/minimal-editor.js\":\"4c1c15f949bef94e\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/armedCut.js\":\"e247b55c235b3710\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/captureMediaVerb.js\":\"46790665f97c915e\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/clipboard.js\":\"32294f0dc06608dd\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/decision.js\":\"e40bc89f83c59625\",\"/knowledge-medium/pr-preview/pr-1853/src/paste/operations.js\":\"3afcccc71d805f57\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/account-header/AccountHeaderItem.js\":\"20c05a6f0ea25593\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/account-header/index.js\":\"f4025c128cc3d879\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"52cd27aa636f478a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/askAgent.js\":\"e080706a3fb78810\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/askedStore.js\":\"4cc4b0f94500357c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5c843fe18ffff094\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/chipState.js\":\"2f7ee5339a42730e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ff3a438e628bfefc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/index.js\":\"e1aa498ff25b7a0b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9db063c4d206d8b6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-dispatch-companion/schema.js\":\"0972e5f227f0d7f6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e7e42bd692bc9c83\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/BridgePairingDialog.js\":\"62c5bb8740ee5edd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/addMedia.js\":\"a94a0b7fc02717c7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a2485d1e3a1499fe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/block.js\":\"9466ccfc278e0141\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/context.js\":\"98f2ab3dfbb25c23\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d141116f07121646\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/index.js\":\"66c9c0de4ecc7978\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/outline.js\":\"dd19d7ba830b2de4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/properties.js\":\"70db67a0f857a131\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/refs.js\":\"a9b4c26be5f44f1c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b8ac6c1e26abd904\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/search.js\":\"c0b771ab28e6f007\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/shared.js\":\"8221600bc3d413f3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e85376126e07b455\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentViews/text.js\":\"173a5adb26be68a0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/agentWrites.js\":\"559ae8c4b0256d6f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/authoringCatalog.js\":\"1c00cf43d4b1d3df\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/blockRefTargets.js\":\"7188404420698c52\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/bridge.js\":\"842581d361f35c72\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/bridgeLoop.js\":\"b13c0735bb990be8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/changeHistory.js\":\"ad61b154520a37e6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/commands.js\":\"08e28825c2933dfb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/commentsCommands.js\":\"be8dca016bc3e417\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/dataExtension.js\":\"7123d14cf8c5fca6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/dataModelGuide.js\":\"b7cf68ec3b202de6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/describeRuntime.js\":\"a6d2dd13e8e37c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/extensionLint.js\":\"fc4dd3d72a288877\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/grainAudit.js\":\"939f8ef5653e95bc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/healthCommand.js\":\"e792f25e71cea7d2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/index.js\":\"085c22bff197ba03\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/presetIdentity.js\":\"1396549998c19eb5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"08644fc6220c3d32\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/readMedia.js\":\"f6148aa4b5d018d0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/schema.js\":\"906d58ef5d9d9123\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/serialization.js\":\"531b336d3f89490a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/targets.js\":\"c80cc531d5ee7257\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/tokens.js\":\"21fb6286de69c3b4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/watchEvents.js\":\"44cd53751986a7d3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/workspaceGuard.js\":\"919879d8ccc2295c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/agent-runtime/writeCommands.js\":\"004b71d73e50f14f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/AliasCollisionToast.js\":\"c2137911c2b8dd12\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/DuplicateNameBanner.js\":\"1ffeb2d9572d66a0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/collisionMerge.js\":\"3fa371f2995f03fe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/dataExtension.js\":\"116007da37281b84\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/index.js\":\"f9316f40d333f157\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/mergeCollisionAction.js\":\"b45c48f93d6806e1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/pageStyling.js\":\"7895f5b461c31e4a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/rejectionToast.js\":\"fe2bf91c3e1bc608\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/alias/syncProcessor.js\":\"1271b4b9ea1fa091\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/actions.js\":\"d6cc28e7169269e8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/addComment.js\":\"84fcf9f19587a5a2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/anchor.js\":\"cb526719bb4328bc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/anchorState.js\":\"96a8b192b6b05b59\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/commentLinks.js\":\"6c370c998363213f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/confirmThreadDeletion.js\":\"6b945805ba30afc5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/container.js\":\"1188bca62921e631\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/dataExtension.js\":\"f37c47a3f866df6e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/deleteComment.js\":\"65975f4da5847d9d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/highlights.js\":\"558b1088d1cbcb0c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/index.js\":\"da6eb0a623800fe3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/linkedCommentsPill.js\":\"e7de30fa769db126\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/margin.js\":\"e5190a0c57da81ad\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/marginSchema.js\":\"9aae6b5541a1e87d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/newComment.js\":\"b323a0ff8dd0653a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/ownThreadPicker.js\":\"8c120f93a9eefbeb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/placement.js\":\"5782413bf9e1e850\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/queries.js\":\"f1e3a49628e8d3b1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/quotePosition.js\":\"d402863c4e281563\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/quotedIn.js\":\"ccbb8216045f83ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/quotedRange.js\":\"4facf95e971f70c1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/rangeRefs.js\":\"6b64a37fe1f25423\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/readHighlights.js\":\"586edd91ae03c9f2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/readSelection.js\":\"958af3c51ea607b3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/readSelectionUi.js\":\"dd6497f83361cfc7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/reanchor.js\":\"e99cdd19c5bc5c6d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/schema.js\":\"2760ed3c03aaf778\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/scope.js\":\"e48f455064666f26\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/scopeThreads.js\":\"fc79a361880f6e2e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/splitRetarget.js\":\"31dc1bbd123f93d1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/suggestionCard.js\":\"69475a28056b461a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/suggestions.js\":\"301f90807cff49f1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/summaries.js\":\"6be8dc05bad83e07\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/summaryBatch.js\":\"87f8d76bacc898db\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/surface.js\":\"edb7ea1822ab7da2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/threadNavigation.js\":\"a2c48a5a7eedcb7c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/threads.js\":\"310ad4527f9ab229\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/ui.js\":\"cc9189e507eaa4a2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/annotations/uiStore.js\":\"05d353fe40ddb9eb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-intents/appIntents.js\":\"61de57aaf592393d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-intents/index.js\":\"d129a5aef01a6715\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-update-prompt/index.js\":\"babcf6a343444d54\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/app-update-prompt/status.js\":\"bbb175f70a6a5686\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"63dbf70de305b194\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/MediaBlockRenderer.js\":\"7576ee035ee90ca3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8ffdf8d6f85d7d3e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/MediaUploadReconciler.js\":\"5dd7ef19452d00cd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/assetDownLane.js\":\"29265a9c0cde5d36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/assetResolver.js\":\"624e11152895f13a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/assetUpload.js\":\"741d79fe4e9f0224\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/attachmentCleanerIO.js\":\"323451dde55e27c8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ec92cb189cf15ed2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/blobStore.js\":\"828a79db6c58b954\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/byteStore.js\":\"d0fec4cb1b1e5796\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/cleanerIO.js\":\"a2d6e6f690b4d551\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/cleanupAttachments.js\":\"4609a12d6791c1ac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/dataExtension.js\":\"158a896c7467bd0d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/downLane.js\":\"ccc819cbfcdadfdc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/index.js\":\"11e341ba500d8d13\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/insertImageContribution.js\":\"47e39af19f65fd7a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/laneArming.js\":\"1e801ec52d9cef4c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/laneLock.js\":\"7bf692fb710a1fcd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaBlock.js\":\"b7ce85727aaf9d37\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaCapture.js\":\"a1ff0823f57473af\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaViewers.js\":\"830c6e9db002046d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/mediaViewersFacet.js\":\"86a11507b70d00fa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/pasteCapture.js\":\"d8d13fabe9de60cb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/resolver.js\":\"6ddbe55371ae792a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/retryUploadsAction.js\":\"fb1b7c8a51b03b8a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/storagePaths.js\":\"2d4224495394c097\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadDrain.js\":\"e05da8e1001c19d6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadLaneStatus.js\":\"9f5f96d96ab9af55\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadReconcile.js\":\"713494ec6175e923\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadRecovery.js\":\"710588e1c7ec69f2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/uploadStore.js\":\"f1aa1323fcdbed78\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/attachments/useAssetObjectUrl.js\":\"baf91d151247f21e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b43b9a50c61c1e82\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/BacklinksViewSection.js\":\"09e42c790d74df5f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/facet.js\":\"2bd5e0de40b83dc4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/index.js\":\"9c5310957c79b11c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks-view/prop.js\":\"e1c1462517f7c095\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/BacklinkFilters.js\":\"7a4667932f3b10e7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5422635e73606bfb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/BlockEntry.js\":\"21780bba66121d9f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/LinkedReferences.js\":\"23693b36d28a7138\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f30f53d7b0721e76\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/dailyNoteDefaults.js\":\"bcb04d5561c74505\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/dataExtension.js\":\"1ad9ad54a3142a52\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/edgeExclusions.js\":\"f894e22f35834f35\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/filterProperty.js\":\"9ddb57d030d5c8a4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/index.js\":\"4c8c64daee78e6ed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5d154025fe6d9e5b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/applies.js\":\"8ed441f58692d7b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/countQuery.js\":\"4d693ba762c796ec\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d2245ea32818e6f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/index.js\":\"7ff3f55839b41556\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8be193706ff23e72\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/presentationInvalidation.js\":\"f100fa2805e723ab\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/propertyEditorOverride.js\":\"208ced5e14d5ba7b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/propertyFilter.js\":\"d60b2488b44339cf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/query.js\":\"43157f115b22ccf3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/resolveFilter.js\":\"0bd700cebf6f9a9a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/sourceBatch.js\":\"699c5669baa67f0a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/sources.js\":\"699429c5a7bc9dd0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/useBacklinks.js\":\"0896e9b18bbbfd38\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"70f3672c0832d355\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/BirthdayCelebration.js\":\"9dca1746a6d0feeb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/BirthdayOverlay.js\":\"482a60092adf63b8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/gate.js\":\"a19ede46278cb9a6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/index.js\":\"8d4b74ce04ed5ddb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/birthday/wolfTheme.js\":\"13f52c6490136f16\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/BlockDragLayer.js\":\"0bfd627a6ec4fbe4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/dragController.js\":\"7b6f6f3a7a7314ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/dropTarget.js\":\"047be889ac7179e7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/index.js\":\"2c262764871e0d85\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-drag/projection.js\":\"ffa27a1ec5d4a328\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-info/BlockMetaCard.js\":\"1a68e0a39682a541\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-info/index.js\":\"bbc8fe586fb2fb8c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/AddTagDialog.js\":\"c3e898dc9acecde9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c84efc63c6b4430a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/TagNameIssueHint.js\":\"bcdc6514b3162cf7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/addTagAction.js\":\"2fdcf3819d75e1dc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/appendTag.js\":\"5d60e7aec08fed26\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/config.js\":\"9fa298281f20d000\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/dataExtension.js\":\"217f75d43dfc9a63\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/index.js\":\"ec8a33a624ab548e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/block-tagging/propertyEditorOverride.js\":\"c1b3d3fb7df04f34\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/BreadcrumbList.js\":\"88f3616fb81cde32\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"bc97fc6a0efda3ee\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/Breadcrumbs.js\":\"949c81d0e601fe29\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b6391bb7d47a1f80\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b5d28514e594e9fc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/index.js\":\"0f11365d94a36666\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8b7fdfae2b0050c6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/CharacterCountItem.js\":\"031caa83b081157f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1e9103c9eaef8923\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/actions.js\":\"7b3b7fabe4ceb2db\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/blockType.js\":\"9d29734b8c6430ce\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/charCount.js\":\"e064b2ce6822e65e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/dataExtension.js\":\"8a1cf9c900352eb1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/index.js\":\"23c747b0b430f127\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/profiles.js\":\"85fed328f3b74b1f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/properties.js\":\"8f143a29d7298e7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/character-counter/textCounts.js\":\"5c949c1c69953fbb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/colemak-keybindings/index.js\":\"b9c9b02de5006db5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/CommandPalette.js\":\"6e97f3558a80d5ca\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/HeaderItem.js\":\"bd8e371669329616\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/context.js\":\"67671afe92e112ef\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/index.js\":\"dc06ed56663206fd\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/selection.js\":\"439d5faefe35d29d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/toggleStore.js\":\"0406cef18c917b82\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/command-palette/useCommandPaletteActions.js\":\"3dca6e8aa0559d14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/ContributorBadges.js\":\"fbb4d4eec31cd85e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/author.js\":\"fe3554d41077acc2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/codeMirrorExtensions.js\":\"7f2c184eecdf0d40\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/dataExtension.js\":\"3ac6528a82362851\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/index.js\":\"871bc4475544924d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/mentionAutocomplete.js\":\"a6e01cf69bad0406\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/processor.js\":\"67739e43d126f416\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/profiles.js\":\"61b3345a2d6221ff\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/queries.js\":\"cfeb632718315d6c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/contributors/schema.js\":\"4ad69ae84cc26eda\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9c3868e9ce104f74\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ebb3ca7c8dbd962c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/index.js\":\"e8b886650a326880\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a5c68eeb18422937\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"738bb67db2bbb92f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/CalendarGrid.js\":\"1f83131410a7e53a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DailyNotePicker.js\":\"eb0f2196b2694592\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a6d42f166ada734a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DateNavDecorator.js\":\"4a4f8c9c02198309\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/DateScrubOverlay.js\":\"21f9c06af4967981\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/HeaderItem.js\":\"628755374ac6e313\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/ReschedulePicker.js\":\"06f4df4f46b5f31a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f867d1454440f463\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/actions.js\":\"46e4eeba7d8f76af\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/blockDateAdapter.js\":\"0999288dbdd8790f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/calendar.js\":\"d498886bf236ea7d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dailyNotes.js\":\"8b90659d57cd03bc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dataExtension.js\":\"306fce9da791d289\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubActions.js\":\"bbc50b14c5c69a1d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubGesture.js\":\"87b9428f74d3f695\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c847845744797077\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6ffcff5cb9055080\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/deletionGuard.js\":\"6c78f7eb1589ca90\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/dueQuery.js\":\"e9f041b7b19a67ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/index.js\":\"edba0144658191aa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/landing.js\":\"1cad22357e5242b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/localSchema.js\":\"a64bd722c3160a1b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/referenceDateAdapter.js\":\"9bfdef4ba2738ea4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/rescheduleAction.js\":\"bdc5131d645d1cfe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/schema.js\":\"d02c7b2adb8231b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/spreadBlockDates.js\":\"caafdae887107942\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/spreadDatesAction.js\":\"11dc29d0fcd729af\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/today.js\":\"5f66187bb00253a6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"274f10475e56741f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"fed3a55a18e9e844\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/audit.js\":\"ac19cedcfa44a849\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/auditAction.js\":\"cfbd342b58a2a2e1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/auditRanges.js\":\"93751c2b20fdda5a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/diagnosticsSource.js\":\"54f4ec121e8848af\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/divergenceScan.js\":\"da43b80ff3533d8e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/index.js\":\"97c3f312dc0fa17a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8b187ef68fc4c2d7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/referencesMirror.js\":\"e6e3a199c418204b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/rowJson.js\":\"cfe097c463730b83\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/schedule.js\":\"02240c4a79e6daed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/data-integrity/store.js\":\"11a1ec4092b17cda\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-maintenance/action.js\":\"a31ebe3464fac404\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-maintenance/index.js\":\"c67b0d2442726cd9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-maintenance/plugin.js\":\"89b963b1c38e491f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a5f078303e91591d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/actions.js\":\"c40ac8f7b13485c7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/changeMarker.js\":\"96350427440f11b4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/diagnostics.js\":\"5f5a7fe915e4eb4a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/fileSystemAccess.js\":\"01e6985d843c4363\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/filenames.js\":\"b4c3ebf8772116a6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/index.js\":\"5b0390b7342ea891\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/mirror.js\":\"73da16572021ce14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/runLock.js\":\"07a29f01e6e1b249\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/runtimeHealth.js\":\"270be9ed0ca4cf1c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/schedule.js\":\"bc2cdbd2a483567e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/db-mirror/store.js\":\"d0739337cc70ae54\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/default-themes/index.js\":\"a119ae98fbba32f7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/default-themes/themes.js\":\"dd2f0c514f862ede\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/diagnostics/facet.js\":\"a0e251f4063fc294\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/diagnostics/useDiagnostics.js\":\"78153e288a7435f7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/dismissals.js\":\"2d957ec3fdd7d9df\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/index.js\":\"69daf72f24840058\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/status.js\":\"1a581c86632ec16f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extension-prompts/store.js\":\"7fcd8906fb107a7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a6a05ff9cd6cd734\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8820792304ef96b2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/actions.js\":\"9624c18af1fdb186\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/config.js\":\"6116bd1b85b05525\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/dataExtension.js\":\"f99089cc634f5eb2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/effect.js\":\"b2ab79506f8f9651\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/index.js\":\"7bf01e26728ada60\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f6132d767e24f6f7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extensions-settings/useToggleTree.js\":\"ef1fad54faabf094\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/ExtractTypeDialog.js\":\"c3cebc7f078bd229\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6a8ca959292154f5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/PropertyShapePicker.js\":\"950387000ab8a459\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/action.js\":\"f2c7640ec93b3089\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/extract-type/index.js\":\"63d4d756836d4950\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/FindReplaceDialog.js\":\"dfe3ffbcad433452\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/HeaderItem.js\":\"2a1ce9288fdcbbaa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/dataExtension.js\":\"15f3f7ab0c7710bf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/index.js\":\"87b756aa030ab12a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/search.js\":\"be92f18a52188224\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/toggleStore.js\":\"2fa1eabbfcadc8a2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/LocationPropertyEditor.js\":\"61b16bf6890c90a6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/MapView.js\":\"95ef4a285c80bee7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/blockTypes.js\":\"be80c6dcb3c6681e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/codeMirrorExtensions.js\":\"b8e7d1116b2c34eb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/createOrFindPlace.js\":\"a3790b3e52570f5c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/currentLocation.js\":\"92ca03a95431ce18\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/dataExtension.js\":\"e3a25c0082e884c8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/geoContentDecorator.js\":\"9258aeceeaf724c6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/googlePlacesClient.js\":\"a7a085fe76e440fb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/index.js\":\"22a870e1748ccf59\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/locationsPage.js\":\"56002b7de3958b2c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/mapViewport.js\":\"2d036d67c57884ca\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/pickCurrentLocation.js\":\"fafad01d056b469a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/placeAutocomplete.js\":\"057b07bfcc5f29b0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/placeNameCollision.js\":\"5de75c500fd9147f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/properties.js\":\"b89613d00309d7e5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/propertyEditorOverrides.js\":\"5ab098e5071e6470\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/query.js\":\"41185b812597568e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/geo/usePlaceSearch.js\":\"19304b56277204c1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"779340d539c640ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d09b59c12db73d96\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"78d64ae41bddf68c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/config.js\":\"be77b3a67001f136\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/dataExtension.js\":\"f372053594d7fa2a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/facet.js\":\"90fcb6a04bc1e534\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/grouping.js\":\"a903b973a6080169\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/index.js\":\"8bb4017e50c42058\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"77868616e130eab8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/query.js\":\"07903dd5e5b62327\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/resolveConfig.js\":\"02831611f743fb00\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"342ae4ba1a398b4e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"24952cefbd4b26ca\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/HtmlDocumentContent.js\":\"cd8576d64ffb8567\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/HtmlFrame.js\":\"421dd07f34418dc0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/actions.js\":\"17a1c4285e5d19da\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/blockType.js\":\"e723a017161aff99\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/confirmRunScripts.js\":\"f13630d81ad9f897\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/dataExtension.js\":\"8e1a81170efb232f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/frameAnnotations.js\":\"5ec791767d4db699\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/frameDocument.js\":\"a50a9dd0b924eb17\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/frameTheme.js\":\"dd8b1a22a11fda34\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/index.js\":\"cad3a4b8f013affb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/scriptConsent.js\":\"9617b3dc6d7a4e49\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/sourceMap.js\":\"9e5d2df4a6cd5a26\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/html-document/useDocumentScripts.js\":\"a6101245ba35e4e7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/index.js\":\"52c908fc1527c1b1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/record.js\":\"0f26b30f3188f032\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/recordStore.js\":\"6a64fdbfed224a98\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/responsiveness.js\":\"59ee335276d97c46\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/schedule.js\":\"2357ab13f69a71ad\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/interaction-metrics/sessionContext.js\":\"dac078db26046c85\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f4d4907b96469c14\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"770a62ec1d9b096b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/actions.js\":\"87fc2ded1e56734a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/config.js\":\"58f91fc960c86429\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/dataExtension.js\":\"5bef5e4b4b986983\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/effect.js\":\"588f7a720d94078d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/index.js\":\"b418856d57c735ce\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/keyCapture.js\":\"0b17acc6261f4913\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/overrideStore.js\":\"96d890bb23ca88c8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"15bae158e503b373\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/HeaderItem.js\":\"ee06801b9f713f23\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/LeftSidebar.js\":\"6037389d257ad5b2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/actions.js\":\"ba9520d726238480\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/facet.js\":\"006e5217e24e3f86\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/index.js\":\"91a1bdae069490f3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/shortcuts.js\":\"f6846cc9409f7253\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/left-sidebar/toggleStore.js\":\"edf817ecc0c75017\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/MergePicker.js\":\"b8007c9d54501103\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/index.js\":\"4573cda77f9256a7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/mergeAction.js\":\"dd74e9c7ce3b7bb0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/merge-blocks/strategy.js\":\"d8a4260b9405af7d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/Button.js\":\"e8548225495d5a70\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ea18fd87c2b397d1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ffd2e4202465a437\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/facet.js\":\"75b00066791315de\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-bottom-nav/index.js\":\"c4241b84db1a57c4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f5c855d4fdcb0571\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/actions.js\":\"04ac1c185d1e9482\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"062a5a3fda03498a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/facet.js\":\"25f39ca262c44bcb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/mobile-keyboard-toolbar/index.js\":\"2cfb04325ac185b8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2b7246d4e08a13a8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6d867c4cc50accf8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/contextMenuItem.js\":\"e0a070ffc48a893f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/index.js\":\"33a2ea07b28d5e70\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/moveAction.js\":\"e8b9d2020a82bd83\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/moveBlocks.js\":\"ec378fc8c04aa2fc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/move-blocks/selectionAfterMove.js\":\"7cc50f03f3885f5b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/TutorialBanner.js\":\"5c1a797c100ba931\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/action.js\":\"2849d85f96fadf9b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/bannerDismissal.js\":\"ecbd115145b3927e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/documents/cheatSheet.js\":\"ea13d896359d2b86\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/index.js\":\"41719f6df01b9e0f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/keys.js\":\"51f82bcbf05194b5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/landing.js\":\"b10729a36be4cff6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/outline.js\":\"accf2f30f60ce51f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/onboarding/seed.js\":\"d9dada078a158074\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3cc58ae3014e476a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/analyze.js\":\"e9417a0d3eaa18b6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/diagnosticsSource.js\":\"b4b685e8b2a6c53c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/index.js\":\"3b6dcea36db32cb0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/load.js\":\"e8006442fadec5ce\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/monitorRun.js\":\"a6cf634af717e45f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/schedule.js\":\"04d4bc73c97509fa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/series.js\":\"5e5d2b284cf46400\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/store.js\":\"e4b999fbf0176460\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/trendAction.js\":\"5c4e1f51929fb014\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/perf-monitor/verdict.js\":\"93b4195671644f43\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/plain-outliner/clickToEditAction.js\":\"9231c96030fd4f43\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/plain-outliner/index.js\":\"dcad7880fac43073\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/plain-outliner/interactions.js\":\"cb66eb7f22ffc24b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7c1344cc5805a647\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/MigrationGate.js\":\"53430c699f287c3c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/MigrationGateDialog.js\":\"2ea1bf7c2d1c4e0c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/action.js\":\"e7170a62cfc85b02\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/index.js\":\"fae4941c3191d5e2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/localRunMessage.js\":\"b5b9282310794f00\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/plugin.js\":\"2332a922d6f14129\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/progressReport.js\":\"43e8ff73c66af2d2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/properties-migration/sweepProgress.js\":\"3d738cc8ef72cae9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/FieldRowRenderer.js\":\"565db9dcdbc74176\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/ValueRowRenderer.js\":\"8a53112cf454fb6f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/actions.js\":\"45c3b235e1a4953e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/autocomplete.js\":\"5bd6283b36fdf4c6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/fieldRow.js\":\"2b10f6e1c7196a61\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/index.js\":\"771952812ad0aa36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/referenceWarning.js\":\"106864b32737a6b6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/valueAutocomplete.js\":\"f1a43e99c76f9604\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/property-rows/valueSchema.js\":\"209d59c92c1f0d42\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/HeaderItem.js\":\"572217a59bcac93d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/QuickFind.js\":\"b000efe2de324e47\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/index.js\":\"4dc3dc0f6a8a28b3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/recents.js\":\"897de9bbb7cccc9e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/resultItems.js\":\"d9a5926ce661d792\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/selection.js\":\"c91b6c2367a18fca\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/quick-find/toggleStore.js\":\"00763ac76c101d65\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/HeaderItem.js\":\"64488dbd346a46e9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4ad372c0f96e3116\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/grouping.js\":\"4f9fb65054af584a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/index.js\":\"2fe017a8b08177c0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/recents/target.js\":\"74ea79f3f6ca4555\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/codeMirrorExtensions.js\":\"54e6e481e28cef90\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/contentPrefill.js\":\"a67de935f052e35d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/dataExtension.js\":\"97f1c6437ef71b8f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/index.js\":\"5be0cac1663d4c6d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e23cefdfb1a8c554\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/invalidation.js\":\"dfde4ec7d4295449\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/localSchema.js\":\"be5e3e71a4061971\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/blockrefs/index.js\":\"ed07aaa70de56c40\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"86df90b3a7cd203e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/index.js\":\"94d7867cf9e6d580\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/referenceNode.js\":\"3551576c1e446ace\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/remark-reference-occurrences.js\":\"63976979966c95d8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6a1da0bf56a66012\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/index.js\":\"5cbcccddf8ffb9b4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7db1eafe16a088ed\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"91031d9f41344c6c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/mergeRetargetProcessor.js\":\"5d03c7a32f5544aa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/parseFence.js\":\"82bcf2d8f8fc3657\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/referenceParser.js\":\"cce04d63de39dc5a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/referenceProjection.js\":\"4d6f65552251dc0a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/referencesProcessor.js\":\"bb27574407fd1d66\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/renameProcessor.js\":\"e699632374338980\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/references/spanReplacement.js\":\"561e615f6c47db48\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/htmlToOutline.js\":\"5b9d10f17428a599\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/index.js\":\"b0f086d4e9b8746e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/normalizeClipboardDom.js\":\"85c8955f7a8a0a62\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/rich-paste/pasteDecision.js\":\"7744a680fcae43e2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/action.js\":\"c650959eace760f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/blockIds.js\":\"75686f16150c7909\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/content.js\":\"439cef1b4cca49c7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/effect.js\":\"9eaba1458bb647b8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/ids.js\":\"792771eb8104b500\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/import.js\":\"e61e6c71cb06fb53\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/index.js\":\"3594355ff34fe099\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/plan.js\":\"1fbba06a0cc5558b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/plugin.js\":\"326addf927883ff6\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/promotion.js\":\"eaab78fc9a5fe138\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/properties.js\":\"169bf2ede3adb6e4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/references.js\":\"fbd1d670c9dbec3a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/report.js\":\"55c065eca3004b8f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/roamMemo.js\":\"5a87fc56e95b1bd0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/runtime.js\":\"84bcd62d60995cf1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/schemaReconciliation.js\":\"3d209b472216948b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/srsMarkers.js\":\"fe0037480f2381bb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/todo.js\":\"d116e1c77beace49\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/typeCandidates.js\":\"24258439c4105052\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/roam-import/types.js\":\"532abbcc4c0daaa7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/search-health/index.js\":\"2cb96ed3ad5911e9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/search-health/store.js\":\"b29800805ee252f1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/HeaderItem.js\":\"d4bbf7f619766f59\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"21b49bd57bbe6b7f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/index.js\":\"11fd4aba6c8066ca\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/model.js\":\"2be70dd6c3348928\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/toggleStore.js\":\"abf56493d78fba35\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/shortcut-help/useKeyInspector.js\":\"e639b1ad99a5b5fc\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"09d62a148c4341c1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/ShellDecorator.js\":\"3ebc66be97f7d532\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/actions.js\":\"059661c480c09aaf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/exclusionsFacet.js\":\"98398f3a6b258f49\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/index.js\":\"1146073282fe0337\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/shell.js\":\"0560d13952601e36\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/surface.js\":\"103d24b42971e271\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/spatial-navigation/walker.js\":\"7780b32341211ef0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/RescheduleToast.js\":\"15445f5fa918cee7\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/dataExtension.js\":\"2cc8fa97b76faeee\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/index.js\":\"5e36a1c7f0f5cfbb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/indicator.js\":\"afc87cbc334f0fe8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/moveSrsState.js\":\"a4a081e03010f3f8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"58764419d999d4f5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/scheduler.js\":\"813a5044c6346f73\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/schema.js\":\"016415ade3223e98\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"400a203d96b6131a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/srsClipboard.js\":\"c5f0093165c0a634\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"fec221e1baa26dea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d63d95ba0b98435f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/DeckPicker.js\":\"c40ddcc3f9f200ce\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/ReviewControls.js\":\"cab89fec1418319b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/ReviewDeckRenderer.js\":\"75b69b4461c048d9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/ReviewSession.js\":\"5b63185ed4ae91bf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/actions.js\":\"ae92c13b34bb0fa5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/archive.js\":\"50b587b9db824fd2\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/dataExtension.js\":\"b8ec1332bfd2ea1b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/deck.js\":\"d4fe0c9d030b5f74\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/dueQuery.js\":\"0afd8cd1d50d004b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/gradeDecision.js\":\"9d76bb3a34102151\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/index.js\":\"8761210aff3fa926\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/keyHints.js\":\"a571aa9cd9caec17\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/reviewCardLayout.js\":\"2b41bda62cb7cb72\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/reviewProgress.js\":\"8abb5a43f875fb10\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/schema.js\":\"522c6d5b154499f5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/srs-review/useDueCards.js\":\"15b717955e0b2a33\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/startup-metrics/index.js\":\"ee7146854bff30ae\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/startup-metrics/record.js\":\"edcaa4859bbddf1e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/storage-persistence/index.js\":\"26010e126433ec10\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/storage-persistence/persistenceStatus.js\":\"f0c34d466a52b72a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/storage-persistence/requestAction.js\":\"95e52f7561a71d11\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/TypeChipsDecorator.js\":\"30113127c7d92fa1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/codeMirrorExtensions.js\":\"d6b8375ef5ef28f1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/index.js\":\"8282ecf23bfa5c7a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/supertags/typeAutocomplete.js\":\"84324490a2de3252\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"33bf3c9c9da5cafa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/actions.js\":\"3f065c61943c8788\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/anchor.js\":\"1f9d2c8eac5a201f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/events.js\":\"90c8c57c890cc093\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/gestureActions.js\":\"371b1e956d5abed0\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/index.js\":\"8487bc93b5413d6b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9734ab6f4ab3f9ea\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/sync-metrics/collect.js\":\"951308a4d446ea87\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/sync-metrics/index.js\":\"42ef3537175ad98f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/sync-metrics/record.js\":\"db47b89ac639569b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/RejectionDialog.js\":\"5467fd463bf018d3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6af3d456b35b1a95\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/index.js\":\"f2cece88769d0758\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/model.js\":\"702a315d68d3afa5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/queueCounts.js\":\"87999f5be8fbc690\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/rejectedHelpers.js\":\"1f4346ae3afad496\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/rematerializeAction.js\":\"cfafa08d2d593a9a\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/system-status/useHysteresis.js\":\"615e55ba43786aa4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/ColumnHeaders.js\":\"bd1c0a965b56f3cf\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/QueryUi.js\":\"c4f0b9d0f948b1fe\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/TableLayout.js\":\"3d5775e8e6e14c78\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/actions.js\":\"ea42b828a8b62fd5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/cellEdits.js\":\"1d1dd94fa59c5822\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/columns.js\":\"22743b35f42700be\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/controller.js\":\"e835621343bd3714\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/convert.js\":\"5ccf3ef2a9dc10df\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/dataExtension.js\":\"e1257f755b58b076\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/index.js\":\"20e0d1e9c2c01498\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/keys.js\":\"7943a77c6f3ef14e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/model.js\":\"0aaba24724130415\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/navigation.js\":\"e5a600e8cbd8397b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/backfill.js\":\"1dfdee81e287cf8b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/format.js\":\"d407896e73bfedaa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/parse.js\":\"21be86b9fdb1ee0d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/queryValue.js\":\"f3f48a78c6cc7571\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/query/source.js\":\"75de14d96af34416\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/registry.js\":\"1de915a469d56da5\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/rowGutter.js\":\"54646052fcfcdb25\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/rowVerbs.js\":\"c7ec6d5baf012997\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/schema.js\":\"a8d27678eef3f77b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/tables/sort.js\":\"86ad5009ec9c677f\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/theme-toggle/effect.js\":\"c422562316c2498d\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/theme-toggle/index.js\":\"4ece597cee1b51ef\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/theme-toggle/theme.js\":\"73c9105dbdaf2c01\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/actions.js\":\"3434b110e4716caa\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/dataExtension.js\":\"6906ccd0340c30f4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/index.js\":\"a50571ac35f58949\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/todo/schema.js\":\"5e6cb3fcba69df52\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f5f84f3f463667e3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/actions.js\":\"535105b6ee86f2d4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/defaultItems.js\":\"fd74ac203b5ba8a1\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/facet.js\":\"e79704a8af310af8\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/holdRecognizer.js\":\"530f156da601d377\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/touch-selection/index.js\":\"de0ad3b28f8a89ac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/update-indicator/UpdateIndicator.js\":\"c8f5c056447e1b64\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/update-indicator/index.js\":\"cfaa90490f1ccaa9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/update-indicator/loadTimes.js\":\"7a7db4357823bb31\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/VideoNotesRenderer.js\":\"2e64234b81e5f664\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/VideoPlayerRenderer.js\":\"cd7c1671849d7ccb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/VideoTimeStamp.js\":\"69777ad5e5bcafd3\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/actions.js\":\"5f0f27d3667a91b9\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/index.js\":\"6e88ca7623095543\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/markdown.js\":\"1d05149d0871ad5c\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/notes.js\":\"bd98174eceaf3255\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/registry.js\":\"66836f7416cf3938\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/remark-timestamps.js\":\"421ee30e0ffc9df4\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/video-player/view.js\":\"42eaf2818e58e10e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/LinkHints.js\":\"baa4764a60eec004\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/index.js\":\"ede541dfb557dcde\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/model.js\":\"e1079da5b280a6cb\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-link-hints/settings.js\":\"d07234236dc3fc93\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-normal-mode/actions.js\":\"dce0953691c8b60e\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-normal-mode/index.js\":\"f15a3ab1f2de3fac\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/vim-normal-mode/interactions.js\":\"66984de66b171a5b\",\"/knowledge-medium/pr-preview/pr-1853/src/plugins/workspace-header/index.js\":\"7c2346613aa7913d\",\"/knowledge-medium/pr-preview/pr-1853/src/registerServiceWorker.js\":\"917f78709b3258c3\",\"/knowledge-medium/pr-preview/pr-1853/src/requestPersistentStorage.js\":\"57b286b1894fc462\",\"/knowledge-medium/pr-preview/pr-1853/src/services/authRequestDeadline.js\":\"cb41f0f95f39e57c\",\"/knowledge-medium/pr-preview/pr-1853/src/services/authStorage.js\":\"7ef38d54fbef4cf9\",\"/knowledge-medium/pr-preview/pr-1853/src/services/powersync.js\":\"55f2aa9ee8dae099\",\"/knowledge-medium/pr-preview/pr-1853/src/services/supabase.js\":\"61465152a793d4c3\",\"/knowledge-medium/pr-preview/pr-1853/src/services/uploadErrorClassifier.js\":\"a540eda322cbe5b2\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/ActiveContexts.js\":\"1f9ee6487054718d\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/HotkeyReconciler.js\":\"35929ec9a7bd9e15\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/WipeLocalDataDialog.js\":\"781fc7247fc91f4e\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/actionDispatch.js\":\"c306b6202dd985ad\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/actionRefItems.js\":\"a130d2390f06b3a2\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/applyKeybindingOverrides.js\":\"2570c3300b38945c\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/blockActions.js\":\"4160bc2db0d335ab\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/blockMergeGesture.js\":\"7f07f26f0dab0c7d\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/canonicalizeChord.js\":\"fa2c954ffdeb7598\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/defaultContexts.js\":\"d04297ff0ffc0a60\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/defaultShortcuts.js\":\"11dba6824cb9fb96\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/effectiveActions.js\":\"483dde8223301887\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/gestureAction.js\":\"5959ce301a6e0c9e\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/gestureBinding.js\":\"d419671fa3790419\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/holdRegistry.js\":\"221e3406b37c29b2\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/keybindingConflicts.js\":\"df6f30cb06d3da40\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/keybindingOverrides.js\":\"4b7fed4efe1f434f\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/pointerAction.js\":\"8fad78c8a6a6f23c\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/resolve.js\":\"f37a2c04c3c08154\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/runAction.js\":\"d2456d8519eb7945\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/sequenceMatcher.js\":\"66f15fdb78e47922\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/types.js\":\"246d431f99bab1a9\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/useActionContext.js\":\"b30c2265f7b79d6c\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/useActionDiscovery.js\":\"1ba56e795b2c9470\",\"/knowledge-medium/pr-preview/pr-1853/src/shortcuts/utils.js\":\"03f58633906938af\",\"/knowledge-medium/pr-preview/pr-1853/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1853/src/sw/bootStore.js\":\"21fe74dae613ba78\",\"/knowledge-medium/pr-preview/pr-1853/src/sw/previewDatabases.js\":\"9286787dee3555eb\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/byteTransform.js\":\"e50574bb1ee5a1d4\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/attachmentCleaner.js\":\"48f11feb39f2851f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/attachmentParts.js\":\"14abb5c888a209cc\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/bundleParts.js\":\"cde2d375477085de\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/bundleRecord.js\":\"b5761728034ed85f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/manifest.js\":\"313e34a80d32ac09\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/takeBundle.js\":\"94b8a7624e25e629\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/bundle/verifyBundle.js\":\"36caf309e1054d2e\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/cleaningStage.js\":\"1d8cb56138b9f381\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/conversionKey.js\":\"08027e83e7cffc5d\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/conversionServer.js\":\"0561da8a29e8265e\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/flip.js\":\"714fee607458c809\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/flipAttempts.js\":\"3fb72def81c02e23\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/pages.js\":\"bd22e5ff4d67186d\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/preflight.js\":\"1f79ccb01be83ab0\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/reseal.js\":\"ed4ec2a587e2e5ad\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/runConversion.js\":\"92779ec04b59d9bc\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/runLock.js\":\"53ae3abe47694e8e\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/sealing.js\":\"9d3dad90274d57ba\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/sealingStage.js\":\"6146b4b4a70db0ac\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/stage.js\":\"1cd26bc08e923201\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/conversion/verifyReseal.js\":\"eea545dc89e90fd5\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/aad.js\":\"18ed4e8c4db0aefb\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/aead.js\":\"74a9068fd3c749f6\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/base32.js\":\"3f9f6a72a95a435f\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/base64url.js\":\"d03830d2a7c0b298\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/binaryEnvelope.js\":\"81add9c9836396d9\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/byteAead.js\":\"f5acf3fd455d5c33\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/canary.js\":\"fdd40afd3bd9a6de\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/contentHash.js\":\"4fbaa9b5cf9c16a8\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/contentKey.js\":\"7fe52ad8afa961f1\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/derivedIdNamespace.js\":\"7263803d0b95cdff\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/envelope.js\":\"9b740cb05cc8f09b\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/hex.js\":\"3aa661472689690e\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/sha256Hex.js\":\"1e169811da418d62\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/crypto/workspaceKey.js\":\"43bfeff7ec5f02a4\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/conversionState.js\":\"c0ae81fd224df740\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/createEncryptedWorkspace.js\":\"467770af935f1a36\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/pastedKey.js\":\"2ceb6ad30af20baa\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"44ab4ccbea172d4c\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/flows/upgradeWorkspacePin.js\":\"344ff24561deb946\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/keyStore.js\":\"49a920edfd3b7974\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/mintWorkspaceKey.js\":\"71f7a0686851fed6\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/modePin.js\":\"579adc111b702ebb\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/openWorkspaceKeys.js\":\"23e83fa62be4362c\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/resolveWorkspaceEntry.js\":\"523b78447b813b23\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/resolver.js\":\"9ed7327ff45cec57\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/keys/workspaceAccess.js\":\"16790e10364e6814\",\"/knowledge-medium/pr-preview/pr-1853/src/sync/transform.js\":\"458f9fc209a77d1d\",\"/knowledge-medium/pr-preview/pr-1853/src/themeBootDefaults.js\":\"8c41391a55f9a91c\",\"/knowledge-medium/pr-preview/pr-1853/src/types.js\":\"5baf5c235c137ca1\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/ClientLocalSettings.js\":\"2396d2bcf42e75d8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/abortableSleep.js\":\"67b28a2463430d20\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/array.js\":\"05e3e60ef315e601\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/backlinkAutocomplete.js\":\"5dd4a22760ecb5f3\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/blockCrumbs.js\":\"7d8f6aaf6eabe70b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/blockrefAutocomplete.js\":\"40e94f360b7edf87\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/cadencedIdleJob.js\":\"f062c41ec52c208f\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/callbackSet.js\":\"ef6bd5e45510afcb\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/clientId.js\":\"c4a47d7f9b42336e\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/codemirror.js\":\"ee3b2a2faa2eb1a5\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/codemirrorCompletion.js\":\"067756a8ab5e0aeb\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/copy.js\":\"9d3169736c79311b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dailyPage.js\":\"27470023e945163f\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dbForensics.js\":\"28aeaac33a2870ab\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dbForensicsHooks.js\":\"324885f364a7a3d9\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/deleteBlockThroughUi.js\":\"d7a1f19888b13dad\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dialogs.js\":\"e60b2b73ed381504\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/dom.js\":\"7d5d20e293280b9a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/downloadBlob.js\":\"fada63ff62b4d07a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/exportSqliteDb.js\":\"cb3c52282e70e684\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/fileSystemAccess.js\":\"305b23d60fc2a1ee\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/flipSlide.js\":\"a90e1446065669bc\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/fnv1a.js\":\"9e5e8e51896fa198\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/formatBytes.js\":\"f1285f8349ae707d\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/fuzzyRank.js\":\"428547ae7b9edc2a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/idbKeyedStore.js\":\"7835aba6a9314ac8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/idleCallbackPolyfill.js\":\"761ad969ac5e21ee\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/keyboardAwareScroll.js\":\"3a70a8bb1fb01581\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/keyboardViewport.js\":\"6ea2c15cd28d2ce6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/lastWorkspace.js\":\"2f76bb3bdea184fd\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/layoutColumns.js\":\"359cc37386709ff3\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/layoutSessionDom.js\":\"e269c2b7442c44e1\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/layoutSessionId.js\":\"09e5be6c2e36cf8a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/linkClickGestures.js\":\"fedde851e2a6eeb9\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/linkTargetAutocomplete.js\":\"0f0d2805ffd35ec7\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/localDbCorruption.js\":\"922fdab0452589d3\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/localDbRecovery.js\":\"f324a5dbc124c299\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/markdownParser.js\":\"0005d2a13c597fe6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/memoize.js\":\"e7f55e1965ad174d\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/nameFieldCommit.js\":\"ceb4cc7803dccf68\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/nameList.js\":\"583989f75bbba84d\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/navigation.js\":\"daff45c17f5f277e\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/omnilinerNamespace.js\":\"ebb7c500bceed5ba\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/opfsPageScan.js\":\"7f98e20c849d4ce6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelClearance.js\":\"f40d3b25b7e3d54c\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelHistory.js\":\"72de8591a6bdd8a8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelLanes.js\":\"a40c33650a53441c\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelLayoutProjection.js\":\"d9aac2f8a3b12b82\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelScrollAnchor.js\":\"e489175b4ef8f1e2\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/panelUrlFlags.js\":\"bf9e43e834d419c6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/platform.js\":\"e908690fdbe2a7bc\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/pluralize.js\":\"0be408c16671e792\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/propertyCreation.js\":\"dc98c831918ac095\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/propertyNavigation.js\":\"ab1e4278bf07d570\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/propertyValueContext.js\":\"482b448452aaf367\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/react.js\":\"2c0c626d99d9674d\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/relativeDate.js\":\"e1c8eaeb18adbdf5\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/relativeTime.js\":\"8cde9ce44bd469cd\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/renderScope.js\":\"ef71a89ff14022ae\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/resolvedThenable.js\":\"7a464e7e57b032f6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/routing.js\":\"357c55b1c9ffec55\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/safeMode.js\":\"69144f16dcc8c98a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/scheduleIdle.js\":\"2f3f04bc798efd5b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/screenWakeLock.js\":\"85c1024cc194b503\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/selection.js\":\"144b4567cb6affd5\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/softKeyboardGrab.js\":\"3d54d52106b6d2cd\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/startupTimeline.js\":\"fb084a511bcbce83\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/state.js\":\"7cd9321724c1ac73\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/string.js\":\"729a0078ca5384f2\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/surfaceZoom.js\":\"12dbf8fb644b2885\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/time.js\":\"3cb473cfd668f9a0\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/toast.js\":\"dd5785eb0a9c55f9\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/toggleStore.js\":\"8ffa5a501020aa4b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/untilStopped.js\":\"161cb4bc70dfa463\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/userActivity.js\":\"15df38a5e12a0cd8\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/viewTransition.js\":\"0a63f7e68e4b180b\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/viewport.js\":\"2d8ec5ada49c44f2\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/webLock.js\":\"bc73e80b9f34fd2a\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/workspaceRecovery.js\":\"65d05df785bee926\",\"/knowledge-medium/pr-preview/pr-1853/src/utils/workspaceSnapshotStore.js\":\"dbc9dc768507c2f3\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-compiler-runtime.js\":\"3847287f0398618c\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-client.js\":\"95723eea0eb291bc\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-server-edge.js\":\"91ed9b88e89cfb9d\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-server.js\":\"79b9d6bf5617ce6e\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-static-edge.js\":\"8b5c97cd6a2bba55\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-static.js\":\"01d4e1ab59b18571\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom-test-utils.js\":\"798dc93c8095cbd9\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-dom.js\":\"08715a7bc2f51d18\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react-jsx-runtime.js\":\"d886728f6bc509bc\",\"/knowledge-medium/pr-preview/pr-1853/src/vendor/react.js\":\"1fb5c11bafcb3e7f\",\"/knowledge-medium/pr-preview/pr-1853/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1853/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1853/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
