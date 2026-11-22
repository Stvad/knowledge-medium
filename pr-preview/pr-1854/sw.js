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
		buildId: "64f71d560515-17239186",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/\":\"924b6d600f21d469\",\"/knowledge-medium/pr-preview/pr-1854/index.html\":\"924b6d600f21d469\",\"/knowledge-medium/pr-preview/pr-1854/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1854/assets/FacadeVFS-CgyFc0Or.js\":\"f7107b3c2f669b35\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSCoopSyncVFS-DpzJl27D.js\":\"4eebe9f25a48ab79\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSWriteAheadVFS-DlGdIEBC.js\":\"7286765a34b08730\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-Bskxs-KJ.js\":\"76879e9c640f248f\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-D6RHqS6G.js\":\"fa520a03ccd3efd9\",\"/knowledge-medium/pr-preview/pr-1854/assets/worker-C1WrjI8d.js\":\"194e79e7a5aed343\",\"/knowledge-medium/pr-preview/pr-1854/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1854/chunks/app-DpsYxXSh.js\":\"f1c888a7cf010a1e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1854/index.js\":\"2989f5d9f48e30fd\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1854/assets/AccessHandlePoolVFS-BIZVIYHj.js\":\"17f189cb83277d1a\",\"/knowledge-medium/pr-preview/pr-1854/assets/IDBBatchAtomicVFS-DJ5yp1vN.js\":\"6b5f5e2d91dc8f44\",\"/knowledge-medium/pr-preview/pr-1854/assets/MemoryVFS-DXct_1M1.js\":\"feb5dd2246f4ee28\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-DD5iVoiM.js\":\"5dc2477c8b15c381\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-7pYGBX1v.js\":\"d1424086317a28af\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1854/chunks/AccessHandlePoolVFS-CxEgFJLk.js\":\"c65edb790911f00c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/FacadeVFS-tEyEEh63.js\":\"db42cf14438a6cb2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/IDBBatchAtomicVFS-7Q-55ud0.js\":\"6cd8f8acff8b019f\",\"/knowledge-medium/pr-preview/pr-1854/chunks/MemoryVFS-C82vOmK6.js\":\"483176f4ac88c414\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSCoopSyncVFS-C6X4wy0b.js\":\"48e884d2c6a583b9\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSWriteAheadVFS-DoDyfT6l.js\":\"19b015fa44732d6d\",\"/knowledge-medium/pr-preview/pr-1854/chunks/Preview-sUyFzg-_.js\":\"fa0441585afae5de\",\"/knowledge-medium/pr-preview/pr-1854/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/card-CUDpk8tl.js\":\"c68bb7e095ec8c54\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-CLzvz6mC.js\":\"fc46bf5d36e1e508\",\"/knowledge-medium/pr-preview/pr-1854/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-async-B_gUl_26.js\":\"8344e870a30a45b2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-lGjJtpDF.js\":\"58bd26143f3f1728\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-53sMW5zx.js\":\"a510621fb298b74f\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-B5rFzUM2.js\":\"4c5dcfc9e29e6468\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-B6Xgo6CA.js\":\"3a375150e8f3c962\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-BFkOG8G-.js\":\"2c1321f532629254\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-Ce3Krumn.js\":\"ae8098b9c992a0db\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-D1tzZisb.js\":\"c4a0aaab58f27dab\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DpiJiqpF.js\":\"c16a6f6d058c710c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-FStfRCPQ.js\":\"ae855634ed1803ab\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server-legacy.browser.production-C3cbMNzS.js\":\"12d0fb986bfeb2a0\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.browser.production-4Qw9J_m0.js\":\"9a3ad7ae543943aa\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.edge.production-25koqvrf.js\":\"db29784c47b5ab74\",\"/knowledge-medium/pr-preview/pr-1854/chunks/server.browser-twr53Yn9.js\":\"54c562a124fafe36\",\"/knowledge-medium/pr-preview/pr-1854/chunks/textarea-90VlTid0.js\":\"6d6cb9d7bfd2e3c0\",\"/knowledge-medium/pr-preview/pr-1854/chunks/ui-3Miol2zm.js\":\"0404e305fb809e81\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-D1cMDcN9.js\":\"8eb29dd69d737fcf\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-async-CW024GuI.js\":\"7811e05034a45856\",\"/knowledge-medium/pr-preview/pr-1854/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1854/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/src/App.js\":\"4eb4c721096752b2\",\"/knowledge-medium/pr-preview/pr-1854/src/appUpdate.js\":\"280971ce5bdb4e8d\",\"/knowledge-medium/pr-preview/pr-1854/src/appVersion.js\":\"c2a18853715e1344\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/initialLayout.js\":\"0beb53b4e81f9ce5\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/openWorkspaceData.js\":\"224434bf89699ccf\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/resolveWorkspace.js\":\"6c234bb01b4869df\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/workspaceBootstrap.js\":\"b7776a2cfdb12c8d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockComponent.js\":\"7cabcf9462d60fad\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockCrumbs.js\":\"df611dfca782adf2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockEditor.js\":\"1f413537e7b26ac7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockLoadingPlaceholder.js\":\"b0e3940c72c6f0b8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockProperties.js\":\"a23b16acfefb1c76\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockSearchPicker.js\":\"3939f6b84da4b41c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ConfirmBulkDeleteDialog.js\":\"b38ffda13659c8b0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DividerHandle.js\":\"422244102b9cc5b7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DraftEditor.js\":\"e857b28a5273aa56\",\"/knowledge-medium/pr-preview/pr-1854/src/components/GutterPill.js\":\"b04a7e200aa33cd2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Header.js\":\"49e062c9de9f87bc\",\"/knowledge-medium/pr-preview/pr-1854/src/components/LazyBlockComponent.js\":\"e7b40eb03a74fa99\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Login.js\":\"fd99d806cacfe2ae\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ZoomableSurface.js\":\"6e1d08bcac8f47ee\",\"/knowledge-medium/pr-preview/pr-1854/src/components/editModeKeepalive.js\":\"02bf6b76b9f90f44\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyDisplay/PropertyDisplayScope.js\":\"07273881e5e711c4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"544304ae60f607fe\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefPropertyEditor.js\":\"a6505ab8322f5fcd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefTargetTypePicker.js\":\"b1a026855975b011\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/SelectPropertyEditor.js\":\"a5d49ade7c06c54e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/TypesPropertyEditor.js\":\"34df4dc13ee03ab2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/defaults.js\":\"d31a508e344e8d9a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/kernelValuePresets.js\":\"44ed187d6d6e4912\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/selectablePresets.js\":\"ea2ad12ca8b08e09\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/typesPropertyUi.js\":\"d4d3b3060d89904e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/AddPropertyForm.js\":\"b12ba3962ed07e3b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyPicker.js\":\"4643e8bb8e69e568\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyRow.js\":\"82c9a0bea1156463\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/Rows.js\":\"1853eb23c2647205\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/actions.js\":\"ee373412874eadd1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/declarationOnly.js\":\"4d44be48f636f9f4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/layout.js\":\"e0e1409783bff698\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/model.js\":\"c42c8d85dd5c5f63\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapeUi.js\":\"0b80897d10b22292\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapes.js\":\"ab62160fffbbfcb8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e39e95d8e44ad6bd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/visibility.js\":\"0bdb294acecd8728\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanelSections.js\":\"6cd846c7d9c0c8b4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockEmbed.js\":\"439f3f2098736a66\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockLink.js\":\"95e7f19a00138f37\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockRef.js\":\"56280a6f7d2b6dea\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/ReferenceLink.js\":\"d1f41f13659081d5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuard.js\":\"d4328b33a1f7a8cb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuardContext.js\":\"4caa1c15e12d3d96\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/linkInteraction.js\":\"89424b7cc4746653\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/referenceLayout.js\":\"ba5f1af0a1cd0eba\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/useBlockRefAncestors.js\":\"9447ec28249ffbdb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockGutter.js\":\"6baadca7ea93d253\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockInfoDialog.js\":\"9051dddefaf42b55\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockTypeBlockRenderer.js\":\"e09fd834bd30fe6e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BulletHoverCard.js\":\"db473a705fb21ff2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorContentRenderer.js\":\"df76d0dc3237491d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fd569bc41671705f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ColumnResizeHandles.js\":\"a61ed8a71564a847\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d5defaa2da84f255\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/DefaultBlockRenderer.js\":\"48653debcefd3ca6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/LayoutRenderer.js\":\"c7f2310ee193880d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MarkdownContentRenderer.js\":\"c98ce31c7614fb2a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MissingDataRenderer.js\":\"c6a09b7aec7c070a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PanelRenderer.js\":\"fe7410284deccf00\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PropertySchemaBlockRenderer.js\":\"bc46c61f1886a90c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/TopLevelRenderer.js\":\"f092945d8c326f1b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockGutterMode.js\":\"c1b16b3746f474e4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockTitleText.js\":\"3a04ac9f4cea0344\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/fieldCreationKeydown.js\":\"ea93cd4febebe0cd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/layoutRootContext.js\":\"2ebc6c341fc4d33d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/TypeChip.js\":\"4554e7f2fee856f6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/chipStyle.js\":\"2bf3943d712c0c69\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/anchored-floating.js\":\"1878312d09913591\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/button.js\":\"957b13b0153d59f3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/card.js\":\"3b02d7dda82ce4b1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/checkbox.js\":\"facfff24db330d8e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/collapsible.js\":\"0316c3f1cd4ff0d5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/command.js\":\"3883b8f14f242b3b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/context-menu.js\":\"9cf6e7bad5861bec\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dialog.js\":\"69b5d885d62283e8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dropdown-menu.js\":\"293d0e32eae6851f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/floating-listbox.js\":\"c44411c87d2a86ec\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/index.js\":\"d8cd7569bf2b1c9e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/input.js\":\"b40071b522414173\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/kbd.js\":\"b6ee5b0a74c7af62\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/label.js\":\"18b02c386302f519\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/textarea.js\":\"994aaf2f00618f4d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/useEditModeYieldKeepalive.js\":\"643dda5b11db93a7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/BootFallback.js\":\"60f27b300b836a59\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/FocusedRowLazyMount.js\":\"37ecc8beb596e4a1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LazyViewportMount.js\":\"e3b4d030e7a85752\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LocalDbCorruptionFallback.js\":\"63a78efd31ac79c2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/error.js\":\"8078b5e741108ee7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/lazyMountRegistry.js\":\"a360824a28435a84\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/suspense.js\":\"311de93e2a0a3f5b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/CreateWorkspaceDialog.js\":\"7acb0d61a8447945\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/PendingInvitations.js\":\"d7b2f8f9ebffd521\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/SyncProgress.js\":\"db61afc6acce21fb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/UnlockProgress.js\":\"e36bc71ae5055a32\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceKeyGate.js\":\"515ca771f935251a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSettingsDialog.js\":\"27a8f8d44068aff1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSwitcher.js\":\"b13897c9b3b42ddd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSyncGate.js\":\"191aa6540f83604d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlow.js\":\"1f5c3afb89fb607a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlowHost.js\":\"b1eed3ea1dfb53b2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/EncryptionSection.js\":\"04f2f7890fa7cbf0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/attachmentPrompts.js\":\"215d0b2273378e77\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/bundleFolderPrompts.js\":\"07844cb4ab282a5e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowDeps.js\":\"bc272fcaabaf0de9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowStore.js\":\"e73bd8e345d49986\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/flowUi.js\":\"f258c44c0db39029\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/useConversionRun.js\":\"6355bb296b9a3201\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/keyUi.js\":\"eda9f18f84b731ea\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnKeyLoss.js\":\"63fd9c3357eb1698\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnServerE2ee.js\":\"09aa3ac815edd839\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/workspaceUnlocked.js\":\"a733e2275e244237\",\"/knowledge-medium/pr-preview/pr-1854/src/context/backgroundSubtree.js\":\"7d4d574e458d1925\",\"/knowledge-medium/pr-preview/pr-1854/src/context/block.js\":\"6ed5084c85d8c28b\",\"/knowledge-medium/pr-preview/pr-1854/src/context/layoutWsContext.js\":\"9c8c68e2d35b9780\",\"/knowledge-medium/pr-preview/pr-1854/src/context/propertyDisplay.js\":\"59684add45799076\",\"/knowledge-medium/pr-preview/pr-1854/src/context/repo.js\":\"0b3719c1e697973c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasClaim.js\":\"95913fa01a544749\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasSeatNamespace.js\":\"5b35fce93817c008\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockData.js\":\"c9717255b5b0f4c5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockType.js\":\"381ffe92f0c36c6c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/changeScope.js\":\"62ca072cad11476b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/codecs.js\":\"f71a0f84cedd01b6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/derivedData.js\":\"76ae59d6fed4e0f4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/errors.js\":\"124d308aa7ffdc08\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/events.js\":\"aac40f94ae62f586\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/handle.js\":\"219bab9ebe261da8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/index.js\":\"a7d58c31a1e55e21\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/mutator.js\":\"19730824636390cd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/processor.js\":\"58783c9490eefbd1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/propertySchema.js\":\"4378fb0c32a921b6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/query.js\":\"3959d3143bbe4fd3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/sameTxProcessor.js\":\"d513e965b7701f0d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/schema.js\":\"219bab9ebe261da8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/tx.js\":\"219bab9ebe261da8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/typedBlockQuery.js\":\"f0d4614840a88255\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/user.js\":\"96da0ad61d182fb2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresetCore.js\":\"051427eb51034949\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresets.js\":\"74e12e84d5dd9cc6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/attachmentCleanerIOVerb.js\":\"bf016df426fc7e12\",\"/knowledge-medium/pr-preview/pr-1854/src/data/block.js\":\"c56fb7de0516c38c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockCache.js\":\"2896f290a07190fc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockId.js\":\"9a47184cc6a6fdcd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockLiveness.js\":\"addd13dbde5f7f53\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockMerge.js\":\"73c65e0ac2956c96\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockSchema.js\":\"a07d5c9c230b7dd9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypeLookup.js\":\"99b42b97e83706d2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypes.js\":\"1fe837e6e9a3bc24\",\"/knowledge-medium/pr-preview/pr-1854/src/data/clientContext.js\":\"0843037f6d560b07\",\"/knowledge-medium/pr-preview/pr-1854/src/data/dbFileSiblings.js\":\"0fdfca5c6afbd0bc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/definitionSeeds.js\":\"28a9d8bedf1afcfd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/derivedIds.js\":\"b57ae379239fb302\",\"/knowledge-medium/pr-preview/pr-1854/src/data/drawnSubtree.js\":\"17581793699f89aa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facetBridge.js\":\"7a636f079ccaae3f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facets.js\":\"f2480ac1f9e840dc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/globalState.js\":\"6a65a48d9b3bfe71\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/aliasClaimRederiveProcessor.js\":\"cce3ee3c0679fb25\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/ancestorBatch.js\":\"3fb66e254e38b5de\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/blockTypeTypeifyProcessor.js\":\"7214851f79f6980e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/clientSchema.js\":\"fadec6adde5106cb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/commitPipeline.js\":\"24412d54dbf615e4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/devAssertions.js\":\"1c2e66403587fdd3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/firstSync.js\":\"8bf407e6d4fe763e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/freshInitialLoad.js\":\"873b339509c6a297\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/graphBackfillClaim.js\":\"2d0f529e4482af00\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/handleStore.js\":\"3fee1422ae76f265\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/idleMarkerJobs.js\":\"d8f085fe4b2a8e5b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initialDownload.js\":\"c8307de0fbbb365a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initializeClientDatabase.js\":\"594e1773a6952498\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/jsonCanonical.js\":\"68a8c5f05a24e4de\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelInvalidation.js\":\"0aabb932a6d21f06\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelProcessors.js\":\"a945938f165003e5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelQueries.js\":\"a0b004b0798e861f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/mergeTypeMembershipProcessor.js\":\"6bf6be0aed1038a6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/normalizeReferencesProcessor.js\":\"a185a854d4b63837\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/poolInstrumentation.js\":\"9a5707ab275bc4d8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/processorRunner.js\":\"4c5cb274e2fd7838\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyCellBackfill.js\":\"5304c4e7735b71ec\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildMint.js\":\"d0d2f5d0030e5ae8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildrenProcessor.js\":\"a99d942660bee4e1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4d2603254af9f2bc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionSynthesis.js\":\"a5aa2976bedc50ea\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyKeyScan.js\":\"0229fcca19578992\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertySchemaResolution.js\":\"d1aca3bc5c2beab5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyValueEdits.js\":\"934eacc50bfe4d65\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/raiseProtocol.js\":\"a233b600d62cea01\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/readBatch.js\":\"67f805922b4a3735\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/refProjection.js\":\"03a7188425989300\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetLookups.js\":\"be0865250a094c17\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetProcessor.js\":\"0c30ad6a48e97ac9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/replayMerge.js\":\"71aa8774a3e470fa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/sqlBinds.js\":\"40566a90dbe82a33\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"909ffa02177646bb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/arrivalProcessors.js\":\"e99c4dde7027be9e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/invalidate.js\":\"7365fd3bddef46b3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/materialize.js\":\"126380f53813bec2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/observer.js\":\"6dfe8c5811026844\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/reconcile.js\":\"d788f7c53e42e491\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/timingMetrics.js\":\"9cdf811389694396\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/treeQueries.js\":\"1ed44ba7bba92286\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txEngine.js\":\"5fafc69630cbeeba\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txSnapshots.js\":\"25ef029e10d85cc5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/typedBlockQuery.js\":\"d6d66d539994310f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/undoManager.js\":\"ea1442e2d4cab7e2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/invalidation.js\":\"ccc2ca364e4e6cbd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelDataExtension.js\":\"cf5c5787bba9210c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelPage.js\":\"cc6b9f1cbbbbc5e2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelValuePresetCores.js\":\"22209844f83b0e6e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbCorruptionSignal.js\":\"b4701648c99c77b5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbStorage.js\":\"6f70ff7794a45d79\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbVfs.js\":\"db6a321604224e9d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localSchema.js\":\"dcd13468d7ca977b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/maintenance.js\":\"611dc49e1adbe333\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mergeProperties.js\":\"6b795e6b52d92964\",\"/knowledge-medium/pr-preview/pr-1854/src/data/metricsConsoleHook.js\":\"ca435c389360a3a5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/migrationsPage.js\":\"7e197a60ff860fd7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mutators.js\":\"887c7dea6fdb74ad\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKey.js\":\"04525f50a0b651df\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKeyPlacement.js\":\"b5a4280b2f368418\",\"/knowledge-medium/pr-preview/pr-1854/src/data/outlineSurface.js\":\"24a11db472576aaf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingEditorContent.js\":\"dcac4296287adf5b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingUploadsSql.js\":\"1698bd1f43da5786\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pluginStateExtensions.js\":\"3c3040dbf149a947\",\"/knowledge-medium/pr-preview/pr-1854/src/data/powerSyncLogger.js\":\"7de46842608b7254\",\"/knowledge-medium/pr-preview/pr-1854/src/data/projectorRuntime.js\":\"f79db66122709188\",\"/knowledge-medium/pr-preview/pr-1854/src/data/properties.js\":\"a165020bc1a87a0d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertiesPage.js\":\"2c0aa894b604579c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyChildren.js\":\"80cae060ad928f9e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionFanout.js\":\"09aa45f34546edc4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionMetadata.js\":\"1b1e13c7e8ecbc6b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionRegistry.js\":\"583de79714f83b3f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDisplayMode.js\":\"d26c55c728b345c5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyRowCreation.js\":\"5796f8c20cda04e1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySchemaCreation.js\":\"ae781ad1cdedfc8b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySeeds.js\":\"27a99702072d84c5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/recentsPage.js\":\"6771c303addfdae7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/referenceBlock.js\":\"47b5c750211253a9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rejectedUploads.js\":\"ae781ac24491b157\",\"/knowledge-medium/pr-preview/pr-1854/src/data/releasePowerSyncConnection.js\":\"a7baca9c7846f9ed\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repo.js\":\"c1b787c320d59095\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repoProvider.js\":\"8dead8a45eca9fb2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rowProperty.js\":\"a133aeac72b78e10\",\"/knowledge-medium/pr-preview/pr-1854/src/data/searchFilter.js\":\"ed35615f7e7124fa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/seedIdentityLedger.js\":\"e7f4e0621b41d18d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/stateBlocks.js\":\"9ab7ce3dcd272b20\",\"/knowledge-medium/pr-preview/pr-1854/src/data/structuralEditPolicy.js\":\"f5af3846decd526c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/subtreeDelete.js\":\"f9e5bb26a27bb295\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncStreamLock.js\":\"cf6441c561f6bb4b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableSqlRecognizer.js\":\"dc4132b935d6c7bc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableWriteGuard.js\":\"8e781e57293d4a85\",\"/knowledge-medium/pr-preview/pr-1854/src/data/targets.js\":\"f345006d977a17ae\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeColors.js\":\"bd292e4853f9a16e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionMetadata.js\":\"cae834e8cbde1d39\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionRegistry.js\":\"925d7dbccce65f49\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeExtraction.js\":\"356580604227fd82\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeInitialValues.js\":\"fa45244ac1974505\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typePropertyGroups.js\":\"ec2b8be7236b2c5f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeSeeds.js\":\"2332d8f60f7937d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeTagger.js\":\"f6d2e96e0d24f001\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typedRecords.js\":\"4407bf0092887cbc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typesPage.js\":\"fe99894b0de93fdf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userPrefs.js\":\"be95ed6f347dc1d3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userSchemasService.js\":\"05d3346f672df601\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userTypesService.js\":\"c2295ba843e3cc98\",\"/knowledge-medium/pr-preview/pr-1854/src/data/valuePresetRegistry.js\":\"af758a675d3f7c68\",\"/knowledge-medium/pr-preview/pr-1854/src/data/visibleChildren.js\":\"a4b8929dc300390d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceConversion.js\":\"b5700617724b5f62\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceFirstSync.js\":\"7488b42775144bab\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceIdNamespace.js\":\"0bc6999cf8ef66bd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceSchema.js\":\"b25f83203dcd182a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaces.js\":\"d4eee22e3b9eeb93\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadLog.js\":\"46913b811c93f4dc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/BlockPasteShellDecorator.js\":\"f6bb61ca8c893aa3\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/atTrigger.js\":\"f84fc404b91b53fa\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/autocomplete.js\":\"671db31a7488ae98\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/codeMirrorExtensions.js\":\"e8edaba6f44c9da6\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/contentFlush.js\":\"46acc2f9de787315\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/defaultInteractions.js\":\"4f21b667cd974abe\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/editSettleSignal.js\":\"716f27ab2e896628\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/insertImage.js\":\"9c43268cb69cf951\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceCompletionRange.js\":\"e268de228ac4aafc\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceTargetTypes.js\":\"796f6fd609af142b\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/syntaxContext.js\":\"6040fc9b3fed9cc6\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/triggerMatch.js\":\"51012dd2403789ac\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/AppRuntimeProvider.js\":\"bf8e997ab5c8816d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/BlockFocusShellDecorator.js\":\"ddb77caa578cfc14\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/ExtensionRenderBoundary.js\":\"5c59e1ee5021a9d6\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/PanelContentRecovery.js\":\"af02f89778443d07\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/apiCatalog.js\":\"c9c0dc8fa219011a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/approveExtensionHere.js\":\"fc91ae9b54e69d12\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/armedCutAppMount.js\":\"a4ee4a08e5222e18\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/batchableKeyedStore.js\":\"27a06b0d7423f4de\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockInteraction.js\":\"06772b36a906c1de\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockSelectionAction.js\":\"cd5c28cfcd2fe89e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compileExtensionModule.js\":\"2b13dfccaee3091a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compiledModuleCache.js\":\"56b32e0d4cc6f725\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/continuousGestures.js\":\"72ec167324c12c92\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/core.js\":\"55cd94489197af50\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/defaultRenderers.js\":\"8c06ac858304d986\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/definitionFanoutAppMount.js\":\"ee895fc1e74ee4c0\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dialogAppMount.js\":\"ef65b5510908687a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensionSeeds.js\":\"026b049d45724987\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensions.js\":\"e2f12b4b367f2c33\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/exampleExtensions.js\":\"ccb98de0baa4f260\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionApprovalStatus.js\":\"95eeabc60ed72916\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrorToast.js\":\"b7921ef36cb6a270\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrors.js\":\"e26bbe6c5b9efd04\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLookup.js\":\"09e73cc9f83f0c0a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionToggles.js\":\"85641e7c6ff1df12\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionUtilitiesCss.js\":\"1e6f33fb1c9cf59f\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/kernelPageDeletionGuard.js\":\"0c121d6952520002\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/liveRuntime.js\":\"0a2e772b5b3a8e10\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/openExtensionsSettings.js\":\"b02f781d9978a544\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/overridesCache.js\":\"0d270f4541751378\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/pluginIds.js\":\"8c05c4bf3e8bf309\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/processorRejectionToast.js\":\"1b7029aa7d4cef75\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeActions.js\":\"6654f188df24cccf\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeContext.js\":\"bfc6e71092c3134e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticAppExtensions.js\":\"231c39c597c4c742\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticDataExtensions.js\":\"f634e2264fa3d82e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/toastAppMount.js\":\"7095a924ba4708d6\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useOverrides.js\":\"65a2e857882d4b69\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useShortcutSurfaceActivations.js\":\"4062b5e0cb3064c3\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/discoverToggleTree.js\":\"ad5148d73f3f8617\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/facet.js\":\"77d8aa53f96c99bc\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/resolveAppRuntime.js\":\"576ef47c1f9d26b6\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/runtimeEvents.js\":\"26bb1843919ffb53\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/togglable.js\":\"c92f3406716c98b8\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/variantFacet.js\":\"d5746a9ed8f05a1f\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/verbFacet.js\":\"6cb53399fc93a267\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/block.js\":\"62655e1d65902308\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/focusedChild.js\":\"5413cde729b70668\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/propertySchemas.js\":\"ed819c088328a1ed\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/typeRegistry.js\":\"fcbf460760d3c9ac\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAncestorCrumbs.js\":\"b88ab1e07d7ec624\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAutocompleteListbox.js\":\"38a66491b2957504\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedSearch.js\":\"43333307139a7a3f\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedValue.js\":\"814121a53f148aad\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsFocalRender.js\":\"4b4aee4bf6769451\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsReadOnly.js\":\"2cdbdc54b6aaae65\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMaterializeBacklog.js\":\"4188861f079451ed\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMinuteClock.js\":\"96d9a4b4f18d5fb0\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePanelLayoutProjection.js\":\"2f71a82ca6b52db2\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePendingInvitations.js\":\"55c8653a15fdfe5c\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRendererRegistry.js\":\"6623f8e8e4171d29\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRetainedFieldRows.js\":\"29ade7e5cad72da2\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useWorkspaces.js\":\"8593e2ae60a44b84\",\"/knowledge-medium/pr-preview/pr-1854/src/lib/utils.js\":\"fa5bfa9b428ddeab\",\"/knowledge-medium/pr-preview/pr-1854/src/main.js\":\"73e6f36e50e26f9b\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/MarkdownImage.js\":\"6fff03dcb7b5adeb\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/blockSeparators.js\":\"bb6d0939b3182e0a\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/context.js\":\"8ece5144a660722e\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/defaultMarkdownExtension.js\":\"e0234faaaf05cbd0\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/extensions.js\":\"753469c15d4f030d\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/renderMarkdownHtml.js\":\"6cea3f7fcbacc66d\",\"/knowledge-medium/pr-preview/pr-1854/src/minimal-editor.js\":\"e31c18498f363284\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/armedCut.js\":\"f559f9262fc67b05\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/captureMediaVerb.js\":\"105901dfb62d6fcf\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/clipboard.js\":\"db147daef6290cd9\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/decision.js\":\"dde0ecd78b9ca8e3\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/operations.js\":\"c13d4e49ccedf2dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/AccountHeaderItem.js\":\"c4158f618b844361\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/index.js\":\"c258c32bddc3d8e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c63846530ff5696d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askAgent.js\":\"e021cdfd5beaba91\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askedStore.js\":\"e06012356f4f01bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"198fccec37af285c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/chipState.js\":\"de788af1b75d2bda\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3a1faed19f3a942c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/index.js\":\"f7bde3d833dc192b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e2266fe1a2b7c8de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/schema.js\":\"789367e5b8eaa633\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/AgentTokensDialog.js\":\"54b76323d7e44265\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c19e9e733f26bdb4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/addMedia.js\":\"da8a8bcc8169d800\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/backlinks.js\":\"991836cc49fb29ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/block.js\":\"de7b706ba09ad783\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/context.js\":\"7a856a623978a622\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1c76b985e1879064\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/index.js\":\"c03e881ea8b85c5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/outline.js\":\"63efab00ef705e45\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/properties.js\":\"a30d8537bbc79eab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/refs.js\":\"eb0067210bcd1754\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1da0e300f26ab442\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/search.js\":\"a372dcad04fe180f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/shared.js\":\"daefcb4b5c398ede\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"58af3369b0654366\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/text.js\":\"3fbabceaf6b77482\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentWrites.js\":\"cd79fe0854bf9318\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/authoringCatalog.js\":\"a2816ae77376cc35\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/blockRefTargets.js\":\"e79552e9410d57c4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridge.js\":\"6b577d04a0ed8210\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridgeLoop.js\":\"2cdc25fbd47e60cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/changeHistory.js\":\"a1a1993a43023157\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commands.js\":\"f69877fb865ec5b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commentsCommands.js\":\"4f9191bc5f9a71af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataExtension.js\":\"8ee3adfff59f570e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataModelGuide.js\":\"9599bc65db5d4c6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/describeRuntime.js\":\"2fd9a34388d39428\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/extensionLint.js\":\"ab4d784674553231\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/grainAudit.js\":\"3b32b460826bd190\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/healthCommand.js\":\"154d35569c0adcb3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/index.js\":\"a93fecba4194b67b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/presetIdentity.js\":\"be7351d59402f51d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"46f9772c4cc47c22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/readMedia.js\":\"ee3dc0974596ef9e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/schema.js\":\"d233a7e1f151b4de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/serialization.js\":\"12ab04d72c11058b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/targets.js\":\"6beadd97ddc61a56\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/tokens.js\":\"6c3e224d38f0fbe9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/watchEvents.js\":\"6f8f2e90906d7c90\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/workspaceGuard.js\":\"1ca3d741eb6a391c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/writeCommands.js\":\"166949fd6e10b960\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/AliasCollisionToast.js\":\"2368a394444a19ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/DuplicateNameBanner.js\":\"00c50793386857d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/collisionMerge.js\":\"6937452510e27ab7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/dataExtension.js\":\"4bc7da42971371ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/index.js\":\"edffec2ddab89fb8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/mergeCollisionAction.js\":\"c57505ba370996ef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/pageStyling.js\":\"a53ccd58d035616a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/rejectionToast.js\":\"339026f046d88d05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/syncProcessor.js\":\"fab608163913cd41\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/actions.js\":\"6f4a15ad9cf4d0e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/addComment.js\":\"f12c1752938b7a9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchor.js\":\"fbc2f0b82bc1b890\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchorState.js\":\"7c4ce032e6b6e956\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/commentLinks.js\":\"a7849ee0edd702f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/confirmThreadDeletion.js\":\"cc862b88c740cd58\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/container.js\":\"0f41aa25e5d382bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/dataExtension.js\":\"2665b1e221fde296\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/deleteComment.js\":\"47b6d3a058b42342\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/highlights.js\":\"2eb0fa48802be0d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/index.js\":\"de94215a0fad74d8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/linkedCommentsPill.js\":\"b359c849a4b75818\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/margin.js\":\"6a1482cd901e4cd8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/marginSchema.js\":\"9ee1f8296955ba2f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/newComment.js\":\"79bbbbc80d0dc2be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ownThreadPicker.js\":\"1081734956d7923d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/placement.js\":\"dd0e08eb105026d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/queries.js\":\"b67546538b7632e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotePosition.js\":\"da981efad371b759\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedIn.js\":\"49827bc88d716af0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedRange.js\":\"b49cd12985374920\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/rangeRefs.js\":\"3987456917f0b203\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readHighlights.js\":\"2a0eb59acbc81866\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelection.js\":\"831bef507a415efc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelectionUi.js\":\"e96f8a033e1af317\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/reanchor.js\":\"b364d7c239b514bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/schema.js\":\"5f15837ebfc9575a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scope.js\":\"c6abf3eb45e5f3b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scopeThreads.js\":\"0630ea2adf061cef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/splitRetarget.js\":\"19a0b089e70ca084\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestionCard.js\":\"12506dfc877ffbd6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestions.js\":\"084d672e90592fc3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaries.js\":\"83e099c516652ef6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaryBatch.js\":\"44349e2967c260ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/surface.js\":\"682bb458cdc84ad2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threadNavigation.js\":\"fd8eda33bd6d90b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threads.js\":\"1f738db39ddc25e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ui.js\":\"a699e998cac08316\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/uiStore.js\":\"2784bf662a57aec0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/appIntents.js\":\"bacbff8f493e8926\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/index.js\":\"d513dcb5e9004b25\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/index.js\":\"db446e592bd203d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/status.js\":\"bbbd83597139fe01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"372a145a55df95c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaBlockRenderer.js\":\"6f9f1cc6604323f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaDownLaneReplicator.js\":\"de470c5e6b66a06e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaUploadReconciler.js\":\"9552e0b14cc34abb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetDownLane.js\":\"0134941a2fe6cfc7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetResolver.js\":\"3df2ddd622ea070a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetUpload.js\":\"22989f0170ff47ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/attachmentCleanerIO.js\":\"6a0235b53122257f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/supabaseAuditIO.js\":\"525ece873d273cf5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/blobStore.js\":\"c350f6ffda541108\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/byteStore.js\":\"998b2fb7f1db5914\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanerIO.js\":\"20544608735fb02b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanupAttachments.js\":\"38696b8601fd0377\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/dataExtension.js\":\"541038bd7d7ad8f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/downLane.js\":\"55f8ee9e864c1a57\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/index.js\":\"7cdbb0e217e87403\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/insertImageContribution.js\":\"409de288619238c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneArming.js\":\"cc7cef1435c8fe87\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneLock.js\":\"310df82abd8dc767\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaBlock.js\":\"4b162ef0ab7415cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaCapture.js\":\"8c7427529d985a87\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaLanes.js\":\"33878d71a5d5db04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewers.js\":\"3957696b7510c51b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewersFacet.js\":\"235dd43c7ef28c0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/pasteCapture.js\":\"5ce7b7e7aa851356\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/resolver.js\":\"5c28c447023efa9b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/retryUploadsAction.js\":\"9d9e5a22cb8ad160\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/storagePaths.js\":\"e08513a77fbb56cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadDrain.js\":\"b9f93f868118947a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadLaneStatus.js\":\"d48fa6394baf095b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadReconcile.js\":\"61bd93a051163099\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadRecovery.js\":\"a98c090f334cfdb4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadStore.js\":\"498c1eba83913787\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/useAssetObjectUrl.js\":\"2c1ff137f9519bf0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3e8fce2a575cdc41\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksViewSection.js\":\"42fcb3382902b85b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/facet.js\":\"2571d447b6723cd1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/index.js\":\"53b69e459d481368\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/prop.js\":\"9f3ce67f802d90ef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinkFilters.js\":\"8cd4956c2aeb4826\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"835fb1d4094fed87\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BlockEntry.js\":\"66ec882be7d545a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/LinkedReferences.js\":\"73203c27fa036f80\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2343c277366caa05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dailyNoteDefaults.js\":\"fa399550066e9863\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dataExtension.js\":\"a0a797aa49bcfbe5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/edgeExclusions.js\":\"8e743e016597065f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/filterProperty.js\":\"0e28c845a23a8793\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/index.js\":\"38b6f4fb637b6448\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b3544bc4813304ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/applies.js\":\"e851b3ae5622e07e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/countQuery.js\":\"ab039e175dad1999\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a0161d014108c5d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/index.js\":\"a2e88e97abc19899\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a73076406bad975a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/presentationInvalidation.js\":\"b7685dff9a81a93e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyEditorOverride.js\":\"4d6ea18c2afbff16\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyFilter.js\":\"8348c374c0df8c2a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/query.js\":\"9cc85c36d5d1d7c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/resolveFilter.js\":\"15b47183e39364e5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sourceBatch.js\":\"2ce6961f0f327fa5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sources.js\":\"2e826e6eb2410b6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useBacklinks.js\":\"8756f265537afef9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6a0515d253fa53a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayCelebration.js\":\"72a462df91bac076\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayOverlay.js\":\"4673522cef4857dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/gate.js\":\"ab11d8bad6200674\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/index.js\":\"ac616691730ea3ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/wolfTheme.js\":\"a42549812e4420c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/BlockDragLayer.js\":\"601ed8b7e0f73056\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dragController.js\":\"e1af60737b9ac5e9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dropTarget.js\":\"0434965c373f229c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/index.js\":\"c9594f5e1c151cf7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/projection.js\":\"0adfed4cc816a62a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/BlockMetaCard.js\":\"5e45dfe1d3988257\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/index.js\":\"5ef756a0938f3420\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/AddTagDialog.js\":\"a95417715bd9bbf4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8024f3feedda9625\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/TagNameIssueHint.js\":\"d3e1b6c3c272d8b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/addTagAction.js\":\"7a9d9ff1dc2f6b5b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/appendTag.js\":\"ab5d7b5b8516475a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/config.js\":\"ebc8e8c628168da8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/dataExtension.js\":\"ea6d7870fdafabaf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/index.js\":\"28eb9ede086a5b63\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/propertyEditorOverride.js\":\"e66148fbeec0dc81\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9f6d9d79ed151e69\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"737d58f104979bb5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/Breadcrumbs.js\":\"305fdbf5943d9eac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0ec5929607f71ae1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d7fe6cac88ac8d26\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/index.js\":\"70a21663673ffc8b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ddd5a019dfe0d705\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/CharacterCountItem.js\":\"815d615bb1db970c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c426ccd62a8446e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/actions.js\":\"67b2bf0bcb66f808\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/blockType.js\":\"afd7074f03372bc4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/charCount.js\":\"19eaf3213ff9faf1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/dataExtension.js\":\"c2e35288b9fc9b99\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/index.js\":\"ff4bc3b7d134bc7f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/profiles.js\":\"d9c535c10acfabe5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/properties.js\":\"2ef79b729e3d46f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/textCounts.js\":\"02db5e7c53354e32\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/colemak-keybindings/index.js\":\"4cb8b72ca0725569\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/CommandPalette.js\":\"db545679b0ec51b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/HeaderItem.js\":\"cd7011c50ccb60b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/context.js\":\"1d4b8fe7a45a1419\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/index.js\":\"6eb260a72369a8e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/selection.js\":\"d89429e4f01dc163\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/toggleStore.js\":\"d644286ecb53a492\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/useCommandPaletteActions.js\":\"e75f52f112840d99\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/ContributorBadges.js\":\"880fd46904f8361c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/author.js\":\"d8434317225eb3ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/codeMirrorExtensions.js\":\"9004b7b6bbc6714c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/dataExtension.js\":\"6dbe715a4dd75357\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/index.js\":\"1ab3573dec3657d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/mentionAutocomplete.js\":\"3087f09a76cf28ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/processor.js\":\"37e653aaf49da0d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/profiles.js\":\"24033872bdbcb41a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/queries.js\":\"f378585957477b58\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/schema.js\":\"75a131438f3ece8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8d6177b851fe9b73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/followOrigin.js\":\"943c42f1514921cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/index.js\":\"5b3150ead4b9faf9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f7c40972c90e4972\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6855eebdb631e06f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/CalendarGrid.js\":\"48e0dc13f06801a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DailyNotePicker.js\":\"8556eb65a97e830f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ffc51c4ab836172c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateNavDecorator.js\":\"236092d230b40e34\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateScrubOverlay.js\":\"5ed3409feb9a4a48\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/HeaderItem.js\":\"37fb70a8e412375b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/ReschedulePicker.js\":\"1c5d08310082a294\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5b2593eb8b0a4303\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/actions.js\":\"9bb37cb1e10f9be7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/blockDateAdapter.js\":\"6f77cc1f40ab1d52\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/calendar.js\":\"49b7a63cb753fa59\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dailyNotes.js\":\"b3d52fe21caa5ded\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dataExtension.js\":\"c5040be7a0d1e350\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubActions.js\":\"fea81e0296c68c09\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGesture.js\":\"c6679a6d27deb637\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c45e05cd5824c623\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubRecognizer.js\":\"618ecc2cbc2b8997\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/deletionGuard.js\":\"0bf9d464a1ac45d1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dueQuery.js\":\"4ca0f04aa43730aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/index.js\":\"5849dd1cca301792\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/landing.js\":\"b4a0bfe589daff80\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/localSchema.js\":\"d6ae2b6e5a4821e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/referenceDateAdapter.js\":\"5bab2fba5bb969cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/rescheduleAction.js\":\"801314d8093204f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/schema.js\":\"db1d87e39811f2c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadBlockDates.js\":\"b6bab29589c9d9d3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadDatesAction.js\":\"6c078f45ac852998\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/today.js\":\"f6200c7b3f480f28\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"47cc750ddcf08617\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3b475e129ae47aa8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/audit.js\":\"7dffc28392968606\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditAction.js\":\"0aa79524cfd062b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditRanges.js\":\"77d34959420b8b47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/diagnosticsSource.js\":\"6d6568195979cc40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/divergenceScan.js\":\"ff15d49ad6193f18\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/index.js\":\"dd083f66027dfe24\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/propertyChildrenChecks.js\":\"07f1428f3f053362\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/referencesMirror.js\":\"1b1562821c2e2e82\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/rowJson.js\":\"879c402442be4801\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/schedule.js\":\"b5d00defe439fd65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/store.js\":\"6ad0afbe05e1eea9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/action.js\":\"0d23863deeeafac1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/index.js\":\"80d643bfaecf378e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/plugin.js\":\"430fcc3cc061f423\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9ef561206ea77add\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/actions.js\":\"13245c87f4ffd4aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/changeMarker.js\":\"f1fef58e7bdd379c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/diagnostics.js\":\"adaf38e74636d9fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/fileSystemAccess.js\":\"488b1a6cf8fd779b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/filenames.js\":\"56899e778068ea93\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/index.js\":\"eb9662a655d74fe5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/mirror.js\":\"6b18ba9ac053c02f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runLock.js\":\"770af586da602497\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runtimeHealth.js\":\"f3d4104f28ee9e27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/schedule.js\":\"c560508fe28bc0d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/store.js\":\"b3b917de32e466d3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/index.js\":\"e86ca51e1e315757\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/themes.js\":\"fd67de5b59a8634a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/facet.js\":\"0bd222153c59aee5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/useDiagnostics.js\":\"a82513d2b9822f61\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/dismissals.js\":\"51ff8eb60b520e4c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/index.js\":\"62c07ca7a957f475\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/status.js\":\"9f2825e805d5cb1f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/store.js\":\"eed9de8041c3a36c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"078eadefbfc569b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f444506a0ff80bfe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/actions.js\":\"e03a49d5c7def049\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/config.js\":\"7644cc2490a3f712\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/dataExtension.js\":\"d0d96c0abc23d549\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/effect.js\":\"afb409d120af07f7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/index.js\":\"1fcce92ce0313a74\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8e10bb520a369897\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/useToggleTree.js\":\"263e58ab25e94de9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/ExtractTypeDialog.js\":\"e61eceee0d619bd4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5d96795dfbbfc420\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/PropertyShapePicker.js\":\"1bb11e3e8b857287\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/action.js\":\"92c98fd18137ec3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/index.js\":\"bddab8f382133c4b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/FindReplaceDialog.js\":\"744c53bee9d4884c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/HeaderItem.js\":\"a281e5695da82fe0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/dataExtension.js\":\"eb17f153ffbdb9d4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/index.js\":\"96a62bac9597086c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/search.js\":\"41062e67ec056e6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/toggleStore.js\":\"dd9072ffbc9f7f2f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/LocationPropertyEditor.js\":\"3ee7358fa462e594\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/MapView.js\":\"cc6239e93f157207\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/blockTypes.js\":\"281ee80065c9b259\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/codeMirrorExtensions.js\":\"30a415485a50c86f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/createOrFindPlace.js\":\"231af1270f9efcb5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/currentLocation.js\":\"04f4598b7ac40a31\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/dataExtension.js\":\"00b1fd2b5a88fc1d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/geoContentDecorator.js\":\"9cb40f6e3216dca9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/googlePlacesClient.js\":\"d9e9dc0516a7bb6b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/index.js\":\"0494334d9521518a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/locationsPage.js\":\"38eec397554c0693\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/mapViewport.js\":\"4d0c376b5890dfe2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/pickCurrentLocation.js\":\"a20a06447b0b2a12\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeAutocomplete.js\":\"810e0ed6d33543ff\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeNameCollision.js\":\"5cf0943052909e17\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/properties.js\":\"bd6ae1454b492861\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/propertyEditorOverrides.js\":\"44a7f148e237383a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/query.js\":\"298cabe1921cc325\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/usePlaceSearch.js\":\"45e20732528ea7dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"eeddc4be601dd60d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3f4617cecf1b75a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f098cbba0ee46bb7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/config.js\":\"bb2d0fcb54de8a99\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/dataExtension.js\":\"29ef89e6c993de8d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/facet.js\":\"0244680ee632ae25\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/grouping.js\":\"be5ba0d10f64698c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/index.js\":\"83e597e6a4a9850c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"304a5b6ab34e3127\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/query.js\":\"7250600468ee246b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/resolveConfig.js\":\"9cb688bf509db189\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e7ef40bf856fb6a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d57d0eb67d97b41c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlDocumentContent.js\":\"ab8aeab33c17add3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlFrame.js\":\"f88717e8959bd854\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/actions.js\":\"ca7cef4138b78a8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/blockType.js\":\"506b4900346b9821\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/confirmRunScripts.js\":\"511d3707acae0d1a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/dataExtension.js\":\"5edc71ac164f700b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameAnnotations.js\":\"f57bd79e2063bbb1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameDocument.js\":\"6ad62be51a565986\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameTheme.js\":\"b829c9a01cadda7d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/index.js\":\"1db8048f91b9dd43\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/scriptConsent.js\":\"726b590478a854d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/sourceMap.js\":\"03451d19f0c24f4c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/useDocumentScripts.js\":\"2c323adfb11ead54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/index.js\":\"64a36a3b2464e445\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/record.js\":\"64bd2b5be99be283\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/recordStore.js\":\"89dba0bfae2d5043\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/responsiveness.js\":\"73ffeec4576a8dfb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/schedule.js\":\"4eea76ac5e9c886d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/sessionContext.js\":\"5d57c5e95622fe83\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ef0bf3352bce9eee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"055fc130facc47e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/actions.js\":\"2e0f9413b8228dbc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/config.js\":\"b17ba95ff05df36e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/dataExtension.js\":\"0d9f9b040502b75b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/effect.js\":\"f0e8be3d9a454f38\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/index.js\":\"3379890d09f1f5c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/keyCapture.js\":\"6ec7bd7284978b53\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/overrideStore.js\":\"586335055c6bb003\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"1a63a89f85c3eab7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/HeaderItem.js\":\"315fa9ad6835a705\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/LeftSidebar.js\":\"ee858aeb94b76246\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/actions.js\":\"0ea7cc16b059d434\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/facet.js\":\"8d936d22b0fb4f48\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/index.js\":\"5faabb6b1c51d6f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/shortcuts.js\":\"0af89fe18add78eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/toggleStore.js\":\"ca429504a9da2129\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/MergePicker.js\":\"73d7e2a5468b3523\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/index.js\":\"7e9c56bde414d077\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/mergeAction.js\":\"a0d8ae5f60eed40e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/strategy.js\":\"40cbfb9c00e4bb30\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/Button.js\":\"68747a8fe9e14412\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"606478c5ad53dc1a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/defaultItems.js\":\"74b61dcfe1b5ec22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/facet.js\":\"2f2c4913a754d2bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/index.js\":\"9d8b548e58b34d71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"982ad2be9acc82e5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d3410b2b4e7bea23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6f317c80d77d08d4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1dcd26c334d1819a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/index.js\":\"9122aad67addcc44\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d3758502a9f51c4d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/blockSubtreeMembership.js\":\"31a6f7fa0edf584e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/contextMenuItem.js\":\"5c001a36af20589e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/index.js\":\"78b9e8d5744bd5c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveAction.js\":\"d7c00e5a05eec97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveBlocks.js\":\"8c4e92e16e8344bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/selectionAfterMove.js\":\"a92f0ee2785be292\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/TutorialBanner.js\":\"a217f7feb3cbf32c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/action.js\":\"f88fbe6a6ff9845e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/bannerDismissal.js\":\"02f85c6cffba59bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/documents/cheatSheet.js\":\"521aee8551b88c52\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/index.js\":\"5f47e0017db4f258\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/keys.js\":\"05908fa4cb1b8f49\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/landing.js\":\"c02ff8d618155b93\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/outline.js\":\"c7c0edf841f37294\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/seed.js\":\"ad2e1b043f62bded\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8478f8119a2f1f1b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/analyze.js\":\"b3e1cd0b7711d27c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/diagnosticsSource.js\":\"e2da9e83ffa474ef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/index.js\":\"c9363626d1323171\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/load.js\":\"c23e5d292c37b83f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/monitorRun.js\":\"6754eff32da56404\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/schedule.js\":\"d2287ff1fb97d018\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/series.js\":\"32ddfa0bb100c948\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/store.js\":\"00fe2349f8a9b638\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/trendAction.js\":\"a1e7967eb0b99f78\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/verdict.js\":\"0649b497f3366f4f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/clickToEditAction.js\":\"1fad08d15e1786b0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/index.js\":\"4edc19ef8638c8bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/interactions.js\":\"692c81fb18f8de0c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5d837a95ace2a9b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGate.js\":\"da2610f5ad51a178\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGateDialog.js\":\"10f9599ea9618298\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/action.js\":\"769c532711e1e03a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/index.js\":\"c2a2ecb79a3defe1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/localRunMessage.js\":\"63853ea8a4be9962\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/plugin.js\":\"d42ce596dbcc337a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/progressReport.js\":\"d69b7d364cbf2cfc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/sweepProgress.js\":\"c3cf5fc5de6ab09a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/FieldRowRenderer.js\":\"4c84790d661f3358\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/ValueRowRenderer.js\":\"f3cd693e511fa481\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/actions.js\":\"26d56c63e3cc09a7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/autocomplete.js\":\"c6f5cd9d361e1e07\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/fieldRow.js\":\"77220cf2bbbf3811\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/index.js\":\"5a41ad4a5f1e255b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/referenceWarning.js\":\"eaca50d01a3855b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueAutocomplete.js\":\"e51c33de107c00b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueSchema.js\":\"57d6d4d280ade293\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/HeaderItem.js\":\"dde2c9628a160237\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/QuickFind.js\":\"513fc0dd3e2538fb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/index.js\":\"468862887d9b10b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/recents.js\":\"61fa6f2445465480\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/resultItems.js\":\"f416cc52163e3d21\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/selection.js\":\"6705fc7ecce7bcae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/toggleStore.js\":\"bf0bd7e11244e7a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/HeaderItem.js\":\"923078a98716fdba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6e2817ff83f3450e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/grouping.js\":\"3b046a333032e7ae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/index.js\":\"7221d8c334794c03\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/target.js\":\"0662562abfef9259\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/codeMirrorExtensions.js\":\"991e792275acd2d1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/contentPrefill.js\":\"bb8ffe769c68c25c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/dataExtension.js\":\"9232cd0e3378be46\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/index.js\":\"246e8bade3dfabec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"334f704c958c5d13\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/invalidation.js\":\"1cab19447054be05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/localSchema.js\":\"1374019a369c71bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/index.js\":\"75e767b2e840e7e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2395cd4c5421ee2d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/index.js\":\"e086d147fcf3f8d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/referenceNode.js\":\"d50321b756918a14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a47bfaadaadb2da2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"139987eb386e7a0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/index.js\":\"d630e5d54bdf9451\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3de834ec712853fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8d9c572bf2dbf63d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/mergeRetargetProcessor.js\":\"cf9ca3e2f54f1e7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/parseFence.js\":\"fb03c5565659bb8b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceParser.js\":\"e4c4a037c63060b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceProjection.js\":\"79405674c6951d41\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referencesProcessor.js\":\"a0f4b1db09b2c384\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/renameProcessor.js\":\"4445744dd9eb61b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/spanReplacement.js\":\"cc5732d8488c1a51\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/htmlToOutline.js\":\"fbec5b3b20c1b90d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/index.js\":\"fb6c3e7f026db759\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f667afbb846b2d1b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/pasteDecision.js\":\"9ae8169cb3899db7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/action.js\":\"31bffd69b4f734a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/blockIds.js\":\"c16c1795b6f588e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/content.js\":\"39928794b7b3a44f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/effect.js\":\"e02c1f0bdb970f07\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/ids.js\":\"d6d84ce8153124eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/import.js\":\"6df4a71681108327\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/index.js\":\"94c197286e3ef6ef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plan.js\":\"b391cc4a845af9b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plugin.js\":\"2f745fa9a92484f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/promotion.js\":\"0cf8c96994ecc686\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/properties.js\":\"14b4e5013ebe61c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/references.js\":\"565190acb0853e1e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/report.js\":\"62a3a7ebc922da11\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/roamMemo.js\":\"b97ae89cab88bab3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/runtime.js\":\"b57c8b1e5870547a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/schemaReconciliation.js\":\"3348ede37cd9f59c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/srsMarkers.js\":\"fdda0ffd8bb17421\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/todo.js\":\"976fa17dde51a01c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/typeCandidates.js\":\"0b1f412c04b195fa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/types.js\":\"b593aae3c18f767e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/index.js\":\"e6d29ccdefe472cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/store.js\":\"79360f2160eb1196\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/HeaderItem.js\":\"5fd7e53adce14a05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"dd0c18c3bcb1a71d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/index.js\":\"0ba8e38960e284c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/model.js\":\"8932226fb7928a03\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/toggleStore.js\":\"ba14c74aa290960d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/useKeyInspector.js\":\"3d727f53997f2d69\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"761bb2f6baa64e2b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/ShellDecorator.js\":\"5973e44824ca8f02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/actions.js\":\"d7223420ea1272fa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f265e262053259f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/index.js\":\"7ac22d3800d4333e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/shell.js\":\"3a3d083beed125d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/surface.js\":\"55c8979a3bfdb6de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/walker.js\":\"aba7bde1a9b401a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/RescheduleToast.js\":\"fdbfb518db420d10\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/dataExtension.js\":\"aa45fde609c7980a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/index.js\":\"56594a544910763e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/indicator.js\":\"904ce5523a66c6c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/moveSrsState.js\":\"09b94dda7fcc50af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"93e01393d790b551\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/scheduler.js\":\"62b67ddc6a390fc6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/schema.js\":\"51dd8f7d8d140040\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"40adca8c8c3a337d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsClipboard.js\":\"c86463b5cba41744\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bb7239c438243fd3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DailyNoteReviewHint.js\":\"06828a626c75641f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DeckPicker.js\":\"ede7cf443c5b6235\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewControls.js\":\"25810950e042a69d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewDeckRenderer.js\":\"58d2458e3ac95ecb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewSession.js\":\"876d613b817b272b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/actions.js\":\"0dd143be5d3a7ada\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/archive.js\":\"8ae5acb37e62ebec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dataExtension.js\":\"022ffe5f5524ab7d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/deck.js\":\"6e3f9ddc298369bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dueQuery.js\":\"52d684944715d5bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/gradeDecision.js\":\"bd3db295d2f51d76\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/index.js\":\"b412fdf08d0fc0c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/keyHints.js\":\"58fa4a3ba75ce7fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewCardLayout.js\":\"ec33e9419900e422\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewProgress.js\":\"0deb1f93e5fe3189\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/schema.js\":\"1c89440bd8434d37\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/useDueCards.js\":\"6cff21c8fba358bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/index.js\":\"8d8cfdbb7ad1839c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/record.js\":\"7073bd172f4436e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/index.js\":\"cc0b1a563a3b4213\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/persistenceStatus.js\":\"0703c08a909b0384\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/requestAction.js\":\"805d2b794c966cff\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/TypeChipsDecorator.js\":\"0c6896ec05426f91\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/codeMirrorExtensions.js\":\"a88467cb56de2c90\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/index.js\":\"b31615f023f34928\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/typeAutocomplete.js\":\"b32a44d3c731034a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e3fee35582b26940\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/actions.js\":\"1459dd464605883e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/anchor.js\":\"c7581f7a3d055a22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/events.js\":\"60b8d2fafbf6bbc1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/gestureActions.js\":\"a8c6587660c8be73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/index.js\":\"ff7a75dbdbdb100f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5ac719afcee92372\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/collect.js\":\"257a3f91d5c15b24\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/index.js\":\"10dc64c1b9a66e1e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/record.js\":\"5fb8a3e910776d71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/RejectionDialog.js\":\"5d905d8ff0194c2b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fa379ab7121e04e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/index.js\":\"136e85d597e8b897\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/model.js\":\"e526b5870130b56e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/queueCounts.js\":\"0b77f11207d7e26a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rejectedHelpers.js\":\"c293b8a3c8f3356f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rematerializeAction.js\":\"0ae89054534e1500\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/useHysteresis.js\":\"396ab54ff92df6fb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/ColumnHeaders.js\":\"fd01632256b2c8f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/QueryUi.js\":\"ba4f5608dbb19468\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/TableLayout.js\":\"a3a04bcaed75514a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/actions.js\":\"89f1d8f1c8d35237\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/cellEdits.js\":\"6d8e7078bce7f4cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/columns.js\":\"260e32c7f33691cb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/controller.js\":\"e1e1872ac8cf0db2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/convert.js\":\"43838d768c8c2157\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/dataExtension.js\":\"265fe60286c2177b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/index.js\":\"ca4e0f469d314969\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/keys.js\":\"4d312444648d18d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/model.js\":\"7139f6d8b6041c3f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/navigation.js\":\"3e28af51cc57c159\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/backfill.js\":\"fa5ef8f4c43cf1aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/completion.js\":\"a5eac583b0321193\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/format.js\":\"30e94982dbe95507\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/parse.js\":\"788477366be0ea02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/queryValue.js\":\"95eb50c39bf9cc33\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/source.js\":\"f725fe16423d8bf9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/registry.js\":\"dbf17ffb93478fd2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowGutter.js\":\"dc64b70a2c32d84d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowVerbs.js\":\"a33b42600c5fddba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/schema.js\":\"3a5a1d7fbdc606fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/sort.js\":\"fd6134551eb02fff\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/effect.js\":\"3850b47ad75d3a86\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/index.js\":\"9c76781689b62335\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/theme.js\":\"08386a79f836b4be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/actions.js\":\"c71e30799b5d4ceb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/dataExtension.js\":\"fe246005657e13a0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/index.js\":\"718b160de040d4c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/schema.js\":\"40745a5c5c17c7e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d8bffb85f701ff57\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/actions.js\":\"ddebd8beb1a2a7ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/defaultItems.js\":\"36e6ca4f5d1d5287\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/facet.js\":\"f5e732d4279fa94a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/holdRecognizer.js\":\"08cd5d1b6bc25fd4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/index.js\":\"02d2a0ff94589b7d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/UpdateIndicator.js\":\"b4b1cb47b817236c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/index.js\":\"ab4e57bdd75b29db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/loadTimes.js\":\"08061eda0a2f16f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoNotesRenderer.js\":\"343cc84ec5c68c02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoPlayerRenderer.js\":\"8e105d6a26cf9677\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoTimeStamp.js\":\"b7b9e0fd643abc5a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/actions.js\":\"7e0eb585c4498025\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/index.js\":\"b4e645551049c526\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/markdown.js\":\"f8ec05b549453105\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/notes.js\":\"d99d29518e55feeb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/registry.js\":\"e5b442a0f75f5135\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/remark-timestamps.js\":\"26199e3cc01bd1a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/view.js\":\"12bf54fde9d753c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/LinkHints.js\":\"4bf84837926ad906\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/index.js\":\"c1f26f8e3d009be5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/model.js\":\"5a2f192bbcf3b216\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/settings.js\":\"41167eac12080883\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/actions.js\":\"39092afb6d04f61a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/index.js\":\"fcb489ac57e3bf68\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/interactions.js\":\"3cb75a05511cb2bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/workspace-header/index.js\":\"ec4bf2e8e0ca51b5\",\"/knowledge-medium/pr-preview/pr-1854/src/registerServiceWorker.js\":\"e128190f0199c56e\",\"/knowledge-medium/pr-preview/pr-1854/src/requestPersistentStorage.js\":\"31df4a03ec0c616f\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authRequestDeadline.js\":\"bfd6aee0914c91f9\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authStorage.js\":\"7a9659af550f8668\",\"/knowledge-medium/pr-preview/pr-1854/src/services/powersync.js\":\"14f13d2fb9e3361e\",\"/knowledge-medium/pr-preview/pr-1854/src/services/supabase.js\":\"c916cf382cb97842\",\"/knowledge-medium/pr-preview/pr-1854/src/services/uploadErrorClassifier.js\":\"a4dc03b75b0ab39d\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/ActiveContexts.js\":\"1660fa038c72b93d\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/HotkeyReconciler.js\":\"7e643ad7497a18e2\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/WipeLocalDataDialog.js\":\"c067166bb7096478\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionDispatch.js\":\"edbe3d1334be047d\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionRefItems.js\":\"adc7e01fbbea0988\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/applyKeybindingOverrides.js\":\"7bd649feba76c626\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockActions.js\":\"43592d357161fd6f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockMergeGesture.js\":\"a1c1a5b5eafbdd59\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/canonicalizeChord.js\":\"f9806842957d90bf\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultContexts.js\":\"20a145c1f10e359c\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultShortcuts.js\":\"022a41957e3061c3\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/effectiveActions.js\":\"b48ed39f706fafa4\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureAction.js\":\"1a996a6919be1988\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureBinding.js\":\"70e7d44faeec0361\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/holdRegistry.js\":\"9f26e68fa8b8274d\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingConflicts.js\":\"239630d603e3bf47\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingOverrides.js\":\"780aa551d94d8768\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/pointerAction.js\":\"1f831a87447552f6\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/resolve.js\":\"2a6ac867f432b492\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/runAction.js\":\"8e31cbdaef607148\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/sequenceMatcher.js\":\"33c3bb36aad7ab26\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/types.js\":\"1c72d6d282f1b0d5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionContext.js\":\"16a5f7abd56d25a5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionDiscovery.js\":\"2f98a7649361e59a\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/utils.js\":\"9f07e538cd6f9f6e\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/bootStore.js\":\"c5d4ce23ad6b4dcc\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/previewDatabases.js\":\"b0d0fb40b98e9cf7\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/byteTransform.js\":\"3b92be971fd82028\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/attachmentCleaner.js\":\"d8f60345747b1090\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/attachmentParts.js\":\"ee9e3c16ff0ad2c4\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleParts.js\":\"20981f6f706ba697\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleRecord.js\":\"50fc3ec96545764f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/manifest.js\":\"7e9c182e3dbd9c84\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/takeBundle.js\":\"9c40c77a33e022d2\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/verifyBundle.js\":\"8ff9355eee7c779d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/cleaningStage.js\":\"ab247ec6744b82d9\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionKey.js\":\"7f925d30bc8499e1\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionServer.js\":\"a285eb608593af27\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flip.js\":\"74cb3cd3599e4e08\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flipAttempts.js\":\"495a54882079110a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/pages.js\":\"7685a662ae9a0944\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/preflight.js\":\"6b1aab72b105884a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/reseal.js\":\"96a5f3210f607b4e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runConversion.js\":\"f85d00a9bfab5c9d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runLock.js\":\"303c34358e1f48e2\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealing.js\":\"6e0d8c3f016d8b32\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealingStage.js\":\"12f0bbaca9d7c221\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/stage.js\":\"acf59af1f0fe4170\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/verifyReseal.js\":\"a8b6d5e22fb057e1\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aad.js\":\"973a5d3f81b75c90\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aead.js\":\"20b536872c246e0b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base32.js\":\"9d015772b4321962\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base64url.js\":\"d38134ff0733ed5d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/binaryEnvelope.js\":\"d7c6018f86dfad03\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/byteAead.js\":\"4ef0d7f173f77b2b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/canary.js\":\"32a9f29efc69b5cd\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentHash.js\":\"2f01e5e1d7a818be\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentKey.js\":\"f18f5df675de46c2\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/derivedIdNamespace.js\":\"f0becb6f072f3219\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/envelope.js\":\"94f3bf34e89d8211\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/hex.js\":\"f4019c33a6596893\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/sha256Hex.js\":\"568a3158b994fc6c\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/workspaceKey.js\":\"2ae6916aa08132c6\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/conversionState.js\":\"8abbf58053ca80e3\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/createEncryptedWorkspace.js\":\"75bdc071326fd85a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/pastedKey.js\":\"a1853a6c20cd3c5d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4041de8bf2088390\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/upgradeWorkspacePin.js\":\"aa9a0f1be8a882fb\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/keyStore.js\":\"db7c4cb67bf37ea4\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/mintWorkspaceKey.js\":\"919a0404256ad444\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/modePin.js\":\"cbc3635b34249452\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/openWorkspaceKeys.js\":\"a744c90f9ccfba9e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolveWorkspaceEntry.js\":\"c5436a0286656a6b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolver.js\":\"983922bd8b53ea2f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/workspaceAccess.js\":\"0604379d132ecf6d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/transform.js\":\"d6c4904406247127\",\"/knowledge-medium/pr-preview/pr-1854/src/themeBootDefaults.js\":\"e40a5eb7f0f1e1a5\",\"/knowledge-medium/pr-preview/pr-1854/src/types.js\":\"573ff0944bb077cb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/ClientLocalSettings.js\":\"c5aa8d64d8465a04\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/abortableSleep.js\":\"e61cdf85af184b41\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/array.js\":\"e983bdd714f87b9b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/backlinkAutocomplete.js\":\"2e458595428ad383\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockCrumbs.js\":\"7f43cce39df95737\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockrefAutocomplete.js\":\"f8be3e666643b711\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/cadencedIdleJob.js\":\"38397c2de0771e1d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/callbackSet.js\":\"a841c2874551b96c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/clientId.js\":\"0d70804f26aace01\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirror.js\":\"de2253af015b4825\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirrorCompletion.js\":\"ab3e06bbeae1838c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/copy.js\":\"b08201738a422433\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dailyPage.js\":\"51e50ef307dcb60a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensics.js\":\"7b9ac916a4f323f0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensicsHooks.js\":\"be5ac6fa2917d515\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/deleteBlockThroughUi.js\":\"4823ae38b4e4b042\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dialogs.js\":\"643b472924071778\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dom.js\":\"5d59cd2dd88ea984\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/downloadBlob.js\":\"777d3eadb46d16e8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/exportSqliteDb.js\":\"e0af505d8c5ec019\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fileSystemAccess.js\":\"1bf648103c914c56\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/flipSlide.js\":\"85f17009cff63502\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fnv1a.js\":\"5f383943d484a5ad\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/formatBytes.js\":\"902cd0523ce6c8c1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fuzzyRank.js\":\"7f54f95deb195ef1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idbKeyedStore.js\":\"860b3397f1201611\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idleCallbackPolyfill.js\":\"5ee9cb7004a151c9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardAwareScroll.js\":\"130e19d4d8f154f3\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardViewport.js\":\"0b7bcc75bda9b584\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/lastWorkspace.js\":\"d7ba1c5360abfac6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutColumns.js\":\"e554415f41ffef9d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionDom.js\":\"a977ab5be66a3421\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionId.js\":\"4bcb89a7bcf33b19\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkClickGestures.js\":\"15637b6c1c0fdd90\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkTargetAutocomplete.js\":\"9f57012149c79e3a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbCorruption.js\":\"3e8c3c1c57dc4cc6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbRecovery.js\":\"13e557c5a184289b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/markdownParser.js\":\"8cdada02f3d333d8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/memoize.js\":\"a6261affe3c28fd9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameFieldCommit.js\":\"c5a68a265f1a7916\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameList.js\":\"8fd9224fc257b01d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/navigation.js\":\"b9ab58b36ad24d1e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/omnilinerNamespace.js\":\"600867980c40dc00\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/opfsPageScan.js\":\"d1aca139a328fcc9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelClearance.js\":\"1779f953aa4a326e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelHistory.js\":\"a6ec6c43006484df\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLanes.js\":\"23a830ff6f59404c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLayoutProjection.js\":\"a9aac2ecef4c8ffc\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelScrollAnchor.js\":\"292d1bb153aaeb42\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelUrlFlags.js\":\"d1b658ffae92c26c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/platform.js\":\"be1f2ccd259d75f7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/pluralize.js\":\"7ff0baa795d1ba6c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyCreation.js\":\"c2e821778f867cc7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyNavigation.js\":\"81665453b7a69fb9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyValueContext.js\":\"cfd1c47c799ae4c7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/react.js\":\"306958b60bdb6109\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeDate.js\":\"9fe6076db06327c7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeTime.js\":\"7bea62d2b1f28872\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/renderScope.js\":\"2341268cca0ae4df\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/resolvedThenable.js\":\"c3f2df89f89593b6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/routing.js\":\"ee622ad451f947d3\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/safeMode.js\":\"9abed4d2814c2598\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/scheduleIdle.js\":\"d779046504006307\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/screenWakeLock.js\":\"510b6f82af30a49f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/selection.js\":\"3b5393a7c4559f67\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/softKeyboardGrab.js\":\"d0e129a27d27bbeb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/startupTimeline.js\":\"093ab585df631ff4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/state.js\":\"4e5eab991d164ed4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/string.js\":\"9b8f20a9e800a4ad\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/surfaceZoom.js\":\"1e481391bbbb4783\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/time.js\":\"a70411e38196cc83\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toast.js\":\"1d24a1f1cb61bc7c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toggleStore.js\":\"c63a3db474b5a671\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/untilStopped.js\":\"1874a0e22908606a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/userActivity.js\":\"08615b84d85891e5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewTransition.js\":\"621b1864f361a42c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewport.js\":\"2778641a167f4954\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/webLock.js\":\"4100f0738db34998\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceRecovery.js\":\"67390b29cda0506d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceSnapshotStore.js\":\"1ef856ef4097732a\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-compiler-runtime.js\":\"dcedab524edb65eb\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-client.js\":\"9a82bd3500b1da86\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server-edge.js\":\"f0eea113ef8cb3e8\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server.js\":\"0146348127cef911\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static-edge.js\":\"3ff4c3dfd88fde73\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static.js\":\"7c36fe283228b7a2\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-test-utils.js\":\"9bd0190ab9f4fd06\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom.js\":\"e179fec588cfc63f\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-runtime.js\":\"6dbb171fdd39d03e\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react.js\":\"23369d4544ba6d79\",\"/knowledge-medium/pr-preview/pr-1854/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
