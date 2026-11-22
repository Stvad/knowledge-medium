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
		buildId: "1f05f8f6936f-6f7d87b5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/\":\"bdb606764336389c\",\"/knowledge-medium/pr-preview/pr-1854/index.html\":\"bdb606764336389c\",\"/knowledge-medium/pr-preview/pr-1854/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1854/assets/FacadeVFS-CgyFc0Or.js\":\"f7107b3c2f669b35\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSCoopSyncVFS-DpzJl27D.js\":\"4eebe9f25a48ab79\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSWriteAheadVFS-DlGdIEBC.js\":\"7286765a34b08730\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-Bskxs-KJ.js\":\"76879e9c640f248f\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-D6RHqS6G.js\":\"fa520a03ccd3efd9\",\"/knowledge-medium/pr-preview/pr-1854/assets/worker-C1WrjI8d.js\":\"194e79e7a5aed343\",\"/knowledge-medium/pr-preview/pr-1854/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1854/chunks/app-D8sw6OEX.js\":\"eb13f6bdd9cd7511\",\"/knowledge-medium/pr-preview/pr-1854/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1854/index.js\":\"abb283f70e05dd65\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1854/assets/AccessHandlePoolVFS-BIZVIYHj.js\":\"17f189cb83277d1a\",\"/knowledge-medium/pr-preview/pr-1854/assets/IDBBatchAtomicVFS-DJ5yp1vN.js\":\"6b5f5e2d91dc8f44\",\"/knowledge-medium/pr-preview/pr-1854/assets/MemoryVFS-DXct_1M1.js\":\"feb5dd2246f4ee28\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-DD5iVoiM.js\":\"5dc2477c8b15c381\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-7pYGBX1v.js\":\"d1424086317a28af\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1854/chunks/AccessHandlePoolVFS-CMb8cBck.js\":\"9422a91aa7b34804\",\"/knowledge-medium/pr-preview/pr-1854/chunks/FacadeVFS-BNm1ank4.js\":\"1430ca86ba10c8ca\",\"/knowledge-medium/pr-preview/pr-1854/chunks/IDBBatchAtomicVFS-BB87eap-.js\":\"090a1b20220f3fab\",\"/knowledge-medium/pr-preview/pr-1854/chunks/MemoryVFS-BLiC9me4.js\":\"8a29935d3dd97a07\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSCoopSyncVFS-BrVeyPeJ.js\":\"4ab6f473fa1d9b00\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSWriteAheadVFS-zXPqmm9L.js\":\"c7c440959ecba757\",\"/knowledge-medium/pr-preview/pr-1854/chunks/Preview-CSYJ6OKu.js\":\"2272667fb45cae97\",\"/knowledge-medium/pr-preview/pr-1854/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/card-D1x5Qo8a.js\":\"1a0562c5f0cad242\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-Ds75SZMY.js\":\"77661500969d9758\",\"/knowledge-medium/pr-preview/pr-1854/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-async-B_gUl_26.js\":\"8344e870a30a45b2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-lGjJtpDF.js\":\"58bd26143f3f1728\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-B0LgdyF6.js\":\"584d406597c2fa1f\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-Bq128pMK.js\":\"4f220be19c450b75\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CGfJOcl7.js\":\"08736b522e4e682c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-C_ATIHrg.js\":\"400d05c9445b6a07\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CnjxvtVp.js\":\"f14470d4c572ef07\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DX7VtoXv.js\":\"7791cd980d4c0002\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-Dq9OLyQJ.js\":\"8f2871f95eae4c7c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server-legacy.browser.production-BSdYBJSc.js\":\"f6fa0e3c5a90ecbe\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.browser.production-BavF-Mif.js\":\"07704d1acdbdb281\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.edge.production-BgxAZCxG.js\":\"d764adfe71c52dad\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-tygEfwlB.js\":\"2a8d855851b0ed33\",\"/knowledge-medium/pr-preview/pr-1854/chunks/server.browser-Cf2d985O.js\":\"ea45a23914c4b585\",\"/knowledge-medium/pr-preview/pr-1854/chunks/textarea-DH6ELqgz.js\":\"8b9bdc2ee62dd7eb\",\"/knowledge-medium/pr-preview/pr-1854/chunks/ui-BXZ1MJr_.js\":\"29cd098f29e4e946\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-D1cMDcN9.js\":\"8eb29dd69d737fcf\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-async-CW024GuI.js\":\"7811e05034a45856\",\"/knowledge-medium/pr-preview/pr-1854/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1854/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/src/App.js\":\"3f8c26dca8e7dea0\",\"/knowledge-medium/pr-preview/pr-1854/src/appUpdate.js\":\"6396884a6ecccd4f\",\"/knowledge-medium/pr-preview/pr-1854/src/appVersion.js\":\"58d3ba58d26567c8\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/initialLayout.js\":\"7825faf89790da00\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/openWorkspaceData.js\":\"58a15f02966b3995\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/resolveWorkspace.js\":\"d0234a8e1f350498\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/workspaceBootstrap.js\":\"4f71383dd1059630\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockComponent.js\":\"86e7e5caa9d02ec7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockCrumbs.js\":\"3b70547b863fe10e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockEditor.js\":\"e3ebbbf1e5129a75\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockLoadingPlaceholder.js\":\"488c3b3f57502783\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockProperties.js\":\"aba3c2a4853f5591\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockSearchPicker.js\":\"ea06f51ba4a8b0c2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ConfirmBulkDeleteDialog.js\":\"97d360db2d2cc1d8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DividerHandle.js\":\"bfb4bb5dbb60bc24\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DraftEditor.js\":\"ff7264ae1702cf2c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/GutterPill.js\":\"4e267004f9559f9c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Header.js\":\"483f9c33835d905d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/LazyBlockComponent.js\":\"fc95c260fb8f80d3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Login.js\":\"2884db19069ab21a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ZoomableSurface.js\":\"84f5c431d72bfc60\",\"/knowledge-medium/pr-preview/pr-1854/src/components/editModeKeepalive.js\":\"39eac6123cb0cc5d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a455d7e2ca69c95a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6aaf0a8755bf3e46\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefPropertyEditor.js\":\"d6cc3a340c81fc7c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefTargetTypePicker.js\":\"f0782da808a3fd82\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/SelectPropertyEditor.js\":\"693af2890eb27858\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/TypesPropertyEditor.js\":\"642dee829d56781b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/defaults.js\":\"939caefd42cfaaa7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/kernelValuePresets.js\":\"3ea7fd9ae873d04e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/selectablePresets.js\":\"fc3fc13ea43f3fb3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/typesPropertyUi.js\":\"094bddb674455ba5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/AddPropertyForm.js\":\"7c8df0a1d1bfab41\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyPicker.js\":\"0ec0d931fd29c86b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyRow.js\":\"906d2ba285d12970\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/Rows.js\":\"91c212afd917e476\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/actions.js\":\"c29ce9ea6a90caf9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/declarationOnly.js\":\"aa7befd0d14f21a2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/layout.js\":\"7bc6b9e01e518461\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/model.js\":\"50708abdd7403a1e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapeUi.js\":\"e0c842797f6fd4b9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapes.js\":\"4dcf66cd063a39dd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2bf9089a9d36d9e7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/visibility.js\":\"b3c2e93c3b16a93b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanelSections.js\":\"11ba3122652081c0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockEmbed.js\":\"847abfb88cd48cad\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockLink.js\":\"9eba157688f77fda\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockRef.js\":\"cc80cd99c12749f7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/ReferenceLink.js\":\"ee2293fd215907f4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuard.js\":\"f4f55f151f270892\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuardContext.js\":\"37847ade0dbd0be2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/linkInteraction.js\":\"7c2cf0d30e8a8edf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/referenceLayout.js\":\"2cbd0e938639cf80\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/useBlockRefAncestors.js\":\"ee7546ca48e7ba31\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockGutter.js\":\"213c2a08ecf71f30\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockInfoDialog.js\":\"ca500fbf916ba3e5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockTypeBlockRenderer.js\":\"4de886eaa4d3caa8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BulletHoverCard.js\":\"60f20f251444bedc\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorContentRenderer.js\":\"4fc92ecd8f59dd1c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"227161daee13df5a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ColumnResizeHandles.js\":\"87a0988805f47dc4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1aff377d56a88944\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/DefaultBlockRenderer.js\":\"77c488d4082adfbc\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/LayoutRenderer.js\":\"f16a5016d466a7c4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MarkdownContentRenderer.js\":\"940df8ad6520c687\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MissingDataRenderer.js\":\"d745bfbb2da58efb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PanelRenderer.js\":\"7e3d2754ca639e9d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d6198671d8760c14\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/TopLevelRenderer.js\":\"1e13c7a45e060b16\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockGutterMode.js\":\"d74ceb82a91aa00c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockTitleText.js\":\"e8588961062bcb9a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/fieldCreationKeydown.js\":\"c64f4ebc2fa3f9f7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/layoutRootContext.js\":\"aa1b40b9bd8f0fb4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/TypeChip.js\":\"24b955a52978c182\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/chipStyle.js\":\"8c127684e7ce0b69\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/anchored-floating.js\":\"de409a93bdaea92b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/button.js\":\"bd0434b526158a26\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/card.js\":\"3bb4eb777299f15f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/checkbox.js\":\"f3ecda8e9f0e96fb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/collapsible.js\":\"4104f8bcab101b9e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/command.js\":\"22f6f41cb35c67c3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/context-menu.js\":\"ccfc3c3d22912da0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dialog.js\":\"b709ddba3685c11f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dropdown-menu.js\":\"8bd6d8edaee8d872\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/floating-listbox.js\":\"d142b840419dae49\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/index.js\":\"0df43d636d20b448\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/input.js\":\"0553fd09d191a3cf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/kbd.js\":\"e95ef0355d8f80c6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/label.js\":\"3ab64d71d387a5ca\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/textarea.js\":\"bb52e4c0b44bd149\",\"/knowledge-medium/pr-preview/pr-1854/src/components/useEditModeYieldKeepalive.js\":\"85b3fa7d2e609c8c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/BootFallback.js\":\"e0c1969ba61d6241\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/FocusedRowLazyMount.js\":\"32488e79dddb1978\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LazyViewportMount.js\":\"b69dd426ede76b48\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LocalDbCorruptionFallback.js\":\"2f4ce2c97525892c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/error.js\":\"2d3ce7925411ee30\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/lazyMountRegistry.js\":\"f136c6e98b9771f8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/suspense.js\":\"c01ab6a44ab76f9e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/CreateWorkspaceDialog.js\":\"7fd27e93dba8fa3b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/PendingInvitations.js\":\"325d6e85baf7320f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/SyncProgress.js\":\"e34e3f3d1d779fa0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/UnlockProgress.js\":\"17d9d3b5f4fa63b8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceKeyGate.js\":\"73c4fcc66baed7ff\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSettingsDialog.js\":\"fd56ffd22998f42f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSwitcher.js\":\"d4801e0c1f3c9763\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSyncGate.js\":\"a1989cf492ecf924\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlow.js\":\"c37e769ebb1a1daa\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlowHost.js\":\"b35dd2db5db29cda\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/EncryptionSection.js\":\"7e753a70ce48dd14\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/attachmentPrompts.js\":\"4cd62736bff572f9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c1bf331ca1fce9e1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowDeps.js\":\"232a131fffce8439\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowStore.js\":\"97c72db70ffe0fa2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/flowUi.js\":\"13127348c394decf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/useConversionRun.js\":\"f1240f721a74a628\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/keyUi.js\":\"1a605a090257f4d1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnKeyLoss.js\":\"69f7222c14125071\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnServerE2ee.js\":\"157015f04fcba677\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/workspaceUnlocked.js\":\"4cb29a063c65bd57\",\"/knowledge-medium/pr-preview/pr-1854/src/context/backgroundSubtree.js\":\"486caaf90eee23b3\",\"/knowledge-medium/pr-preview/pr-1854/src/context/block.js\":\"b21d5cae363c3dfb\",\"/knowledge-medium/pr-preview/pr-1854/src/context/layoutWsContext.js\":\"de27ec2a2571ee55\",\"/knowledge-medium/pr-preview/pr-1854/src/context/propertyDisplay.js\":\"36c86c30f9ff6ac4\",\"/knowledge-medium/pr-preview/pr-1854/src/context/repo.js\":\"00b606f8d09061df\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasClaim.js\":\"be427dd09fb66fb3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasSeatNamespace.js\":\"cddd7a07c4ea7fc4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockData.js\":\"6dfeb9829bd2e2bf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockType.js\":\"10130d5a59f07b0b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/changeScope.js\":\"3beda64d51bc37e6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/codecs.js\":\"b90f1a0e503e4fc4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/derivedData.js\":\"79820328a3d873cd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/errors.js\":\"6455fd28ba53f5d0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/events.js\":\"bd6b4063b47427a6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/handle.js\":\"ab103cc3e21f37ad\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/index.js\":\"886a9f228016c646\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/mutator.js\":\"4f75f586751c1dbf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/processor.js\":\"076dcac0789ac0cb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/propertySchema.js\":\"3f9971646a390b88\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/query.js\":\"03cceaf64ff0d694\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/sameTxProcessor.js\":\"15dd250a529509e8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/schema.js\":\"ab103cc3e21f37ad\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/tx.js\":\"ab103cc3e21f37ad\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/typedBlockQuery.js\":\"1b5ae8c6b02fb854\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/user.js\":\"042678a313b7072b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresetCore.js\":\"6b271cfc763de62b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresets.js\":\"7032abd13a010d2b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/attachmentCleanerIOVerb.js\":\"9093d32e064d92af\",\"/knowledge-medium/pr-preview/pr-1854/src/data/block.js\":\"5a90eda339d0cf71\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockCache.js\":\"f230332c8ff2ee05\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockId.js\":\"f9291746b9ec6f87\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockLiveness.js\":\"ca47c2e4f9285a59\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockMerge.js\":\"45a963087f6f6a64\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockSchema.js\":\"d41ee9f8e4033afc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypeLookup.js\":\"9cccc4e77eb0b107\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypes.js\":\"031f43ca98359ebe\",\"/knowledge-medium/pr-preview/pr-1854/src/data/clientContext.js\":\"f12de9da6d8d7c0a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/dbFileSiblings.js\":\"3245e0ace3a2e088\",\"/knowledge-medium/pr-preview/pr-1854/src/data/definitionSeeds.js\":\"bc3a03397f2f368f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/derivedIds.js\":\"314cb8524bfd8033\",\"/knowledge-medium/pr-preview/pr-1854/src/data/drawnSubtree.js\":\"12259c3f5df3a03a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facetBridge.js\":\"109e4f010bcd69ab\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facets.js\":\"0f3e7f866ba0de83\",\"/knowledge-medium/pr-preview/pr-1854/src/data/globalState.js\":\"087a779153e3e7be\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/aliasClaimRederiveProcessor.js\":\"cb8aa0ae146da303\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/ancestorBatch.js\":\"37141233f1e873a7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/blockTypeTypeifyProcessor.js\":\"a0b2aba01a2be102\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/clientSchema.js\":\"d6e965b3d89bbe06\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/commitPipeline.js\":\"52b1d87f94c1501d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/devAssertions.js\":\"f43b789d1ed8284f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/firstSync.js\":\"c26aacf039890859\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/freshInitialLoad.js\":\"49618b5187ad3088\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/graphBackfillClaim.js\":\"e6f148be12628908\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/handleStore.js\":\"a5f7af69d4307dd6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/idleMarkerJobs.js\":\"f9e936b5fbc8c8a4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initialDownload.js\":\"8b5884a5104a0413\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initializeClientDatabase.js\":\"a4031e92e647f784\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/jsonCanonical.js\":\"6c7500159b02b222\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelInvalidation.js\":\"ab0f2cb1c80029ee\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelProcessors.js\":\"3e2af3e174e4abf4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelQueries.js\":\"764c9318a86a0732\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/mergeTypeMembershipProcessor.js\":\"fc8656feb6269958\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/normalizeReferencesProcessor.js\":\"f7ee889834b3ed90\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/poolInstrumentation.js\":\"7c7451512dd32c0b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/processorRunner.js\":\"c91be0868d5709c1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyCellBackfill.js\":\"24bb6609deae8c7b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildMint.js\":\"8b0ca78d5f3929b2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildrenProcessor.js\":\"c4585cb812942b67\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3faea1e993e0feac\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionSynthesis.js\":\"3ba648266fd7f473\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyKeyScan.js\":\"a8b550c90094e233\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertySchemaResolution.js\":\"1f096ae653319499\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyValueEdits.js\":\"322f1ef39e910281\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/raiseProtocol.js\":\"e87f1095e07dbfcf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/readBatch.js\":\"0ba8306889f25270\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/refProjection.js\":\"ea8139fd02334222\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetLookups.js\":\"68d58fcbf0b3fe37\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetProcessor.js\":\"80f0df12c5aa083a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/replayMerge.js\":\"dd0ed9f65cacb15c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/sqlBinds.js\":\"90a0fe80d8fee932\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b0cbf4aefc106c4f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/arrivalProcessors.js\":\"6e690ea91f579024\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/invalidate.js\":\"a7f6b20852c2c9d6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/materialize.js\":\"37b6d8bbfdcd978e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/observer.js\":\"fc1eb06fc30090af\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/reconcile.js\":\"4b45acd66363a147\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/timingMetrics.js\":\"cbf7d3cc691e214a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/treeQueries.js\":\"b51d231865ef7b6f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txEngine.js\":\"5df766ef6173fb4b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txSnapshots.js\":\"ecded5abc2cbf375\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/typedBlockQuery.js\":\"ccc38c78f0f30d43\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/undoManager.js\":\"79015bf3845e39d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/invalidation.js\":\"aa169b0846d66925\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelDataExtension.js\":\"f9e0a049e68fbac8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelPage.js\":\"5784a72460b6c25e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelValuePresetCores.js\":\"a2ed10b52ab0df76\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbCorruptionSignal.js\":\"9b90f1d4c3e8d1d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbStorage.js\":\"3f9c3df6a36dde3c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbVfs.js\":\"aa9749a051bdb965\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localSchema.js\":\"df5aed90387f5087\",\"/knowledge-medium/pr-preview/pr-1854/src/data/maintenance.js\":\"0bc062fdae91632b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mergeProperties.js\":\"076d0b6f0c534314\",\"/knowledge-medium/pr-preview/pr-1854/src/data/metricsConsoleHook.js\":\"9d5c06da24acada2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/migrationsPage.js\":\"95267a33b0daf0dd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mutators.js\":\"75f71d85924c6ecc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKey.js\":\"6b5597a5d7715f93\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKeyPlacement.js\":\"01202b1099064cef\",\"/knowledge-medium/pr-preview/pr-1854/src/data/outlineSurface.js\":\"b3564a50a5906937\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingEditorContent.js\":\"49cb7d78f895c77e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingUploadsSql.js\":\"62cae36f3c0d68a0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pluginStateExtensions.js\":\"a4adcb5e71e3fa75\",\"/knowledge-medium/pr-preview/pr-1854/src/data/powerSyncLogger.js\":\"6e3ca00ec38df177\",\"/knowledge-medium/pr-preview/pr-1854/src/data/projectorRuntime.js\":\"6cbb099d62aace1c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/properties.js\":\"2993869d39f6a691\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertiesPage.js\":\"0f1f79b0dc097cf8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyChildren.js\":\"679f1b03b5f8adcd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionFanout.js\":\"5dedbf5dde9fe32f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionMetadata.js\":\"f39271d07cc86d5b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionRegistry.js\":\"fed676fc649457a8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDisplayMode.js\":\"78eff854be003851\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyRowCreation.js\":\"0b95c4bec8a8bdfa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySchemaCreation.js\":\"ec948015dc6f0e4e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySeeds.js\":\"83f64cdd5deaa477\",\"/knowledge-medium/pr-preview/pr-1854/src/data/recentsPage.js\":\"e9aa37bc08289e21\",\"/knowledge-medium/pr-preview/pr-1854/src/data/referenceBlock.js\":\"820d2b55cf32c4f6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rejectedUploads.js\":\"3f95b956ca2eb02f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/releasePowerSyncConnection.js\":\"4182f42195f4bf3a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repo.js\":\"7d1363dc47249b63\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repoProvider.js\":\"1a5658566d34489c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rowProperty.js\":\"fbd6093738b8e419\",\"/knowledge-medium/pr-preview/pr-1854/src/data/searchFilter.js\":\"cccad95d3adfcfbf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/seedIdentityLedger.js\":\"b9993088d41e1a2b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/stateBlocks.js\":\"af8229aef0d8939f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/structuralEditPolicy.js\":\"231202740b6425cb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/subtreeDelete.js\":\"17654fa317a7cc58\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncStreamLock.js\":\"1959b675d6fba2f6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableSqlRecognizer.js\":\"59f14e3fc23e64bd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableWriteGuard.js\":\"6681162811206495\",\"/knowledge-medium/pr-preview/pr-1854/src/data/targets.js\":\"baa7056634003a36\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeColors.js\":\"29aa31f92857a366\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionMetadata.js\":\"6be9481687c032dc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionRegistry.js\":\"791d3b2acf197f99\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeExtraction.js\":\"5e900d78bb5c9675\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeInitialValues.js\":\"7ce42bc9e7ba4ccc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typePropertyGroups.js\":\"d1bf38cd1d2a15cd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeSeeds.js\":\"00ee923e046e0f8a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeTagger.js\":\"971328334db761f0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typedRecords.js\":\"45f5661a5585ebed\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typesPage.js\":\"2a2c6ab93d7e8232\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userPrefs.js\":\"37b8b3551963477e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userSchemasService.js\":\"b810d7e731c12df5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userTypesService.js\":\"db72e74871383d55\",\"/knowledge-medium/pr-preview/pr-1854/src/data/valuePresetRegistry.js\":\"ea9dbca655b913b0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/visibleChildren.js\":\"b523b26b06979994\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceConversion.js\":\"dde04ad7b2473dd9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceFirstSync.js\":\"ac8711ac7f6aaa8d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceIdNamespace.js\":\"5d39f9b9e7e97935\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceSchema.js\":\"a58ac7040b70d2b1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaces.js\":\"6477826390710f47\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadLog.js\":\"64e973fa28dc1622\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/BlockPasteShellDecorator.js\":\"59619ca282c5e9c7\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/atTrigger.js\":\"ae926c3d4d7a9594\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/autocomplete.js\":\"4616cabde8ef1acb\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/codeMirrorExtensions.js\":\"e616dba8fa9a4a95\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/contentFlush.js\":\"aae5ccdcf83eecc9\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/defaultInteractions.js\":\"542a808fbc78a853\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/editSettleSignal.js\":\"e0145916c35c8a4e\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/insertImage.js\":\"340bedf9d6068fbe\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceCompletionRange.js\":\"7a7821bd6a9ebf73\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceTargetTypes.js\":\"fd514bf8607000eb\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/syntaxContext.js\":\"f382cac12f266327\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/triggerMatch.js\":\"27a5435a59d0e7c9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/AppRuntimeProvider.js\":\"ba853351014afadc\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/BlockFocusShellDecorator.js\":\"58f68e2d993c4e3d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/ExtensionRenderBoundary.js\":\"c1c0136bd62cc39b\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/PanelContentRecovery.js\":\"646db14559974d81\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/apiCatalog.js\":\"96b603d08eea4f76\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/approveExtensionHere.js\":\"79a787734defd626\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/armedCutAppMount.js\":\"0fb0c311291dbb36\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/batchableKeyedStore.js\":\"1ef9b22ca80f75c8\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockInteraction.js\":\"048a9702ed7258f5\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockSelectionAction.js\":\"e5f65fa3cebe65d5\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compileExtensionModule.js\":\"e40c52f8cfbf58bc\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compiledModuleCache.js\":\"66ff22b790e86b30\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/continuousGestures.js\":\"02e5a6727193e964\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/core.js\":\"7187decb2eec2c7c\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/defaultRenderers.js\":\"b9882402c690b923\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/definitionFanoutAppMount.js\":\"472cd0b67edbd265\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dialogAppMount.js\":\"6332c0edddf17f53\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensionSeeds.js\":\"fae345b24268721c\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensions.js\":\"b1b3274ab2777efd\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/exampleExtensions.js\":\"3cfa45f609441cbc\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionApprovalStatus.js\":\"09820fa24a6b997b\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrorToast.js\":\"f7ece1cb1f9daf5d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrors.js\":\"0293b4c46caf7e26\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLookup.js\":\"af6770e15a22adcb\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionToggles.js\":\"86abaf0621e36ba0\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionUtilitiesCss.js\":\"3d13a056761c4b3d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/kernelPageDeletionGuard.js\":\"ec74334699bfe1c7\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/liveRuntime.js\":\"c4db8af9f25a0b37\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/openExtensionsSettings.js\":\"50c3eec6fa90a593\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/overridesCache.js\":\"145042e92932b63c\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/pluginIds.js\":\"19267569acb03683\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/processorRejectionToast.js\":\"0b36862907f5b124\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeActions.js\":\"b11ca6bd78844033\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeContext.js\":\"adabead522eb557d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticAppExtensions.js\":\"fee22c09fecb955d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticDataExtensions.js\":\"a7e88491fefbbc4d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/toastAppMount.js\":\"c4c0537453445e93\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useOverrides.js\":\"7566d35c949b64ab\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useShortcutSurfaceActivations.js\":\"027d71043feb1fad\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/discoverToggleTree.js\":\"243f3a5128c8c4f2\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/facet.js\":\"6269731d9d13506a\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/resolveAppRuntime.js\":\"2c3720a6d6baf7a1\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/runtimeEvents.js\":\"a864ba5e64d914a5\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/togglable.js\":\"c5df9479a9b73f70\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/variantFacet.js\":\"877f616a7afc1d1e\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/verbFacet.js\":\"9f6fe6616368af29\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/block.js\":\"1a70be18431a6bfb\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/focusedChild.js\":\"423a516b49fb12fb\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/propertySchemas.js\":\"10330343993fd9bb\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/typeRegistry.js\":\"070b512cf8239d05\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAncestorCrumbs.js\":\"f61f84a07e37dd1c\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAutocompleteListbox.js\":\"59d11ef3608bead2\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedSearch.js\":\"4877e980ef7b1132\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedValue.js\":\"3b00e063ba62a7b7\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsFocalRender.js\":\"74117a46429a2e17\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsReadOnly.js\":\"648b289d30e78464\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMaterializeBacklog.js\":\"75270f79d195a601\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMinuteClock.js\":\"6e7386589c5b8c07\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePanelLayoutProjection.js\":\"2463742de08d83c8\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePendingInvitations.js\":\"a52fc0419dd5e754\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRendererRegistry.js\":\"9eec8121bb449f30\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRetainedFieldRows.js\":\"8fbbca18d94d821a\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useWorkspaces.js\":\"ec3b5c115b90349c\",\"/knowledge-medium/pr-preview/pr-1854/src/lib/utils.js\":\"a01c92428ba6e487\",\"/knowledge-medium/pr-preview/pr-1854/src/main.js\":\"ae436e8f590faffd\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/MarkdownImage.js\":\"fc6292e2f099bda2\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/blockSeparators.js\":\"5a3504c9978b4c9e\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/context.js\":\"96f50cf7ef85c0fb\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/defaultMarkdownExtension.js\":\"2d0287c5c5e904e3\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/extensions.js\":\"b4204bd3234234ef\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/renderMarkdownHtml.js\":\"b6694b3012fb2e2f\",\"/knowledge-medium/pr-preview/pr-1854/src/minimal-editor.js\":\"f2d9a87eb1ec1e87\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/armedCut.js\":\"2bf72cdf1c321178\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/captureMediaVerb.js\":\"f3e1bb79de0a50b2\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/clipboard.js\":\"b42d5cc4d6fe5e5d\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/decision.js\":\"0e617dc9aec3e7f2\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/operations.js\":\"8768d96e86a31ea1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/AccountHeaderItem.js\":\"e11cbb44d9341aaf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/index.js\":\"3e07aed6f825fdb6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a83315ecd89c04b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askAgent.js\":\"c23f2afbe6f72ca9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askedStore.js\":\"49bf6b4d1d186d44\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"81655574956fbad0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/chipState.js\":\"f419b075f135df85\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/dataExtension.js\":\"87e56e89c987a85f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/index.js\":\"5a5c6e6d98a5b5cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a81c9c1483161e10\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/schema.js\":\"2867e1fd636704dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/AgentTokensDialog.js\":\"64bdf29630ee56ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ecae2a274535a2ae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/addMedia.js\":\"9d2b5521800c1e2a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a4970f6fb3b363ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/block.js\":\"d1461f3b2041d790\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/context.js\":\"b985ef05f730834b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/displayIds.js\":\"cc4a905b103dfca5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/index.js\":\"5abacc0c4536668b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/outline.js\":\"e7ff5a65b3aa6731\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/properties.js\":\"72c467af5249aff0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/refs.js\":\"d6e04c6f5a6e288f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"13ad4919ae47b84d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/search.js\":\"f456d0394040eb68\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/shared.js\":\"3763348ff765bea1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c57af250b7677f4e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/text.js\":\"11b715b766132ee6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentWrites.js\":\"9e84fb41ac24510e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/authoringCatalog.js\":\"f15b13a70c3fb3bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/blockRefTargets.js\":\"598c650e9c7fd5f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridge.js\":\"56a27a207102fdf1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridgeLoop.js\":\"9a016cae1924b5fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/changeHistory.js\":\"c56ce2cb270c00da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commands.js\":\"fbd1444b0abc4304\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commentsCommands.js\":\"aeb2fdba778921de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataExtension.js\":\"05aaf73a0f0adb6f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataModelGuide.js\":\"c99d0bd82fb222f1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/describeRuntime.js\":\"0c512563fe037e56\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/extensionLint.js\":\"a96bdcbb48eaea8d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/grainAudit.js\":\"43c43028b48be053\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/healthCommand.js\":\"c96200abbd043016\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/index.js\":\"017be4be43706d97\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/presetIdentity.js\":\"239ccc14b7e61c82\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c0b986e6045187c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/readMedia.js\":\"eb148eaca8193d3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/schema.js\":\"1c577a8cb9ed2ccd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/serialization.js\":\"16973a6ba3fb0a7a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/targets.js\":\"2b357cab734fe1c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/tokens.js\":\"4ecb0c85afce8568\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/watchEvents.js\":\"136785c55f7c73c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/workspaceGuard.js\":\"6df29fc69afd6ee9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/writeCommands.js\":\"aca357832ddf2339\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/AliasCollisionToast.js\":\"a6a76ecfe3fca126\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/DuplicateNameBanner.js\":\"8aff46a80b4696dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/collisionMerge.js\":\"6687ed8bbbf866a7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/dataExtension.js\":\"a51d59378b6d59f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/index.js\":\"3a1a77cd64271a3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/mergeCollisionAction.js\":\"740ac0f08a9b837d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/pageStyling.js\":\"d91d04c8a009675c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/rejectionToast.js\":\"6fd7a1d439f47fb6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/syncProcessor.js\":\"c437046e8f1eaa45\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/actions.js\":\"7407e4fae92cc763\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/addComment.js\":\"9ff40374677e2b17\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchor.js\":\"b9d72a1e90c40428\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchorState.js\":\"f935df8029327f24\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/commentLinks.js\":\"c252fa5b05caf206\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/confirmThreadDeletion.js\":\"bcebf429d9bfaeb7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/container.js\":\"17334f08c4942166\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/dataExtension.js\":\"5b2a022cba65800c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/deleteComment.js\":\"3b2fe80445e3a7fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/highlights.js\":\"aff72e71839b83a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/index.js\":\"e1a9774c22d5b0cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/linkedCommentsPill.js\":\"f6d9e1ae9455338e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/margin.js\":\"d3b71756031ce3fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/marginSchema.js\":\"a0e3cf809b815cfd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/newComment.js\":\"69f3c0dfe8d8870f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ownThreadPicker.js\":\"18070182573d5e92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/placement.js\":\"97ec5f0d699ff186\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/queries.js\":\"035a40c9b83361b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotePosition.js\":\"51f80e2a3de33914\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedIn.js\":\"373356c5273397c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedRange.js\":\"968fe70e48c7ca6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/rangeRefs.js\":\"cb422411bfd625c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readHighlights.js\":\"d5cfccc3407643c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelection.js\":\"71232c655f03601b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelectionUi.js\":\"20223e99f23b6cef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/reanchor.js\":\"dd142cd6c111d239\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/schema.js\":\"baff9f15874a0caa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scope.js\":\"2417f32aa6c77d11\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scopeThreads.js\":\"8c63a9682620e082\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/splitRetarget.js\":\"28fa25d694d85154\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestionCard.js\":\"cb1b425d1fba941a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestions.js\":\"f361d4d4c441a621\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaries.js\":\"a29b1ebe53d1ed89\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaryBatch.js\":\"70f700d9c808982e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/surface.js\":\"4c6b9f5feb5d5f54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threadNavigation.js\":\"41bdbf629965f775\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threads.js\":\"1b1c3bcd7c1bff9b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ui.js\":\"27751046fd818c4e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/uiStore.js\":\"1e2d02a60b96c8d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/appIntents.js\":\"155e7624da456e86\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/index.js\":\"4da2c2494782d3b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/index.js\":\"93f574cab0217aec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/status.js\":\"8e6b91b96b0ffa16\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1c3c5d336270babd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaBlockRenderer.js\":\"0befb5a51b1ad22c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c93fdc6d0408d8e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaUploadReconciler.js\":\"2f180a327fcc0a1b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetDownLane.js\":\"01e59152c00f6849\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetResolver.js\":\"37f563cdda1101e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetUpload.js\":\"9ba69ddb8a937111\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/attachmentCleanerIO.js\":\"982ed0f7bb8f5b2e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a8723baa0e241afb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/blobStore.js\":\"6521360dccb801de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/byteStore.js\":\"1a73f451e19b08aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanerIO.js\":\"335b8381e3470a66\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanupAttachments.js\":\"754b6964dd6bbf72\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/dataExtension.js\":\"ed5c33fa7eb8afe5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/downLane.js\":\"3ab6074241562efe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/index.js\":\"f81616739d105752\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/insertImageContribution.js\":\"e50bd355bae8060b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneArming.js\":\"9572cb050cedcf2b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneLock.js\":\"7f3939adb8788010\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaBlock.js\":\"e85ad2f7bb71e6c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaCapture.js\":\"7c1882c45879d2cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaLanes.js\":\"9334680a5f38a43f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewers.js\":\"998e426437734ae2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewersFacet.js\":\"ccf65fb365860fc8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/pasteCapture.js\":\"c2e170ba588d7fae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/resolver.js\":\"a1b535470863c2cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/retryUploadsAction.js\":\"250b9e43944a492b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/storagePaths.js\":\"9edd1d34b8a05c86\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadDrain.js\":\"29cfc2b613adb740\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadLaneStatus.js\":\"7fc60c5e79b8cdfc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadReconcile.js\":\"d847d43da726314b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadRecovery.js\":\"546ad679fdcb659b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadStore.js\":\"46c426e179bb917b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/useAssetObjectUrl.js\":\"e5cc1ce1a504efd2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9cce56492098e129\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksViewSection.js\":\"91c4958dd9a5a9a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/facet.js\":\"d151e463c7aeca23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/index.js\":\"befbd2ac689e0eaa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/prop.js\":\"16fafe58e26f41f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinkFilters.js\":\"0fa75578058fee90\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1de461c8d3e96a28\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BlockEntry.js\":\"6d9af8cac23b2850\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/LinkedReferences.js\":\"116a3f214acda989\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0aec8c8d2133822b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dailyNoteDefaults.js\":\"35ef74ca1224a965\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dataExtension.js\":\"ff9b46e16f106f73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/edgeExclusions.js\":\"a9aecaaf32358eaf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/filterProperty.js\":\"3fe8a51c7debf40c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/index.js\":\"8279e3cf159315c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0bcf6c6c9f3dfa01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/applies.js\":\"7b60efab25dde4c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/countQuery.js\":\"a893ec32ebdd9e0c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/expansionStore.js\":\"41337784e8ae843a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/index.js\":\"4d9fc61e46cfbf40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"19f61d3e2758047e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/presentationInvalidation.js\":\"313362534380ac16\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyEditorOverride.js\":\"17d1b617586e9af6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyFilter.js\":\"d0d26c83b06b2cc6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/query.js\":\"da4f6e3c7d9105d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/resolveFilter.js\":\"40318a57d20d743a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sourceBatch.js\":\"ae0991264e79fde0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sources.js\":\"332e8fb53efc7191\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useBacklinks.js\":\"515829e03b728c95\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2552cf4c2f3a8d86\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayCelebration.js\":\"5d26360a9af95b6a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayOverlay.js\":\"a6185a11239516f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/gate.js\":\"cebda1933f67a00f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/index.js\":\"95efd0fa8fd5b208\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/wolfTheme.js\":\"fe5f04ee4ab96fbf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/BlockDragLayer.js\":\"521d8910437bb867\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dragController.js\":\"de52b73188ba3609\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dropTarget.js\":\"8777015dc89c7f67\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/index.js\":\"32eb5ee7de809d08\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/projection.js\":\"b9d0e64951165894\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/BlockMetaCard.js\":\"fbf2043af383fdd7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/index.js\":\"cd1cd3f7f5b3710b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/AddTagDialog.js\":\"da6c2143581d67de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7d60b8d5b8ffdda6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/TagNameIssueHint.js\":\"7f42ec299d59c3c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/addTagAction.js\":\"4cad9ca016ec94bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/appendTag.js\":\"12969a1c02b742ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/config.js\":\"a3164531642b7970\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/dataExtension.js\":\"bc5568c5e6b776e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/index.js\":\"9ddd2bc2df557ab2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/propertyEditorOverride.js\":\"12ef98b703b86c53\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbList.js\":\"00f9caf77b869ea6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"31fe0ca394ef9734\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e6d93072c4ae40be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"08dcb30b113e3329\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4f4e3ac2cae3d27d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/index.js\":\"bfd2542b9b77e775\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dcc8e77e8446fd0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/CharacterCountItem.js\":\"36ac7f244e83d095\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fdd007e4005e0979\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/actions.js\":\"64cdfdfd6661ac56\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/blockType.js\":\"d3f56521aa7c1e4d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/charCount.js\":\"3a88e1735b3cb364\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/dataExtension.js\":\"20b74ad7f6c5c24f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/index.js\":\"b38b2118e581ba18\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/profiles.js\":\"bc392eb89876aa63\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/properties.js\":\"2cda980f5cca426b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/textCounts.js\":\"82b7c747179b60ba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/colemak-keybindings/index.js\":\"833e5971a46f60dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/CommandPalette.js\":\"0564ff77353e21b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/HeaderItem.js\":\"f94e2c72226efd73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/context.js\":\"0c3fed51ac6f8f5b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/index.js\":\"70b3b644edfe217b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/selection.js\":\"496b0c823800ed32\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/toggleStore.js\":\"644894ea544966c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/useCommandPaletteActions.js\":\"eaf8e36b9123b2e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/ContributorBadges.js\":\"ce5f1e6ffa7de0be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/author.js\":\"62a0c2ad29d9bfcc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/codeMirrorExtensions.js\":\"254d29af86fef0b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/dataExtension.js\":\"5873143caf4c1b40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/index.js\":\"586119d26d69c33e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/mentionAutocomplete.js\":\"29a0770c35cd8a54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/processor.js\":\"662e9b950676948c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/profiles.js\":\"ae51ab3b8fcc292e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/queries.js\":\"391687520ac1e878\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/schema.js\":\"d2fef6f5f9916fb0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"869c26c098c0ba3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a9e3a6ff1f4b56ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/index.js\":\"2ecc8c2e504cbdc9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4e2d3a0579151009\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9e79bddc473e0b70\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/CalendarGrid.js\":\"0836f4c60095272e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DailyNotePicker.js\":\"7b1eab8645a17197\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"cb2ff600f5e4f05b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateNavDecorator.js\":\"0c779d667e41122e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateScrubOverlay.js\":\"d8fa41043f561726\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/HeaderItem.js\":\"142def833a8d299a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/ReschedulePicker.js\":\"f7cf127c57bb6d41\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cbe90de81a093ffa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/actions.js\":\"d7745b362b3516d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/blockDateAdapter.js\":\"8b16d4bc2ddd447a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/calendar.js\":\"43c14b7221158e4b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dailyNotes.js\":\"f4678db6bd18da40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dataExtension.js\":\"73b88ca61de8a323\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubActions.js\":\"92111423d370cac3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGesture.js\":\"5ccae78e409d993a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c8d6f26653e307fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubRecognizer.js\":\"eeb8418f7ce3a3f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/deletionGuard.js\":\"6c015bf4daaa8484\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dueQuery.js\":\"eb6e58008c3d3fdf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/index.js\":\"f69b504b8162a606\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/landing.js\":\"91ab78e42093928f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/localSchema.js\":\"9226170a51bedeb7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/referenceDateAdapter.js\":\"487799808b2fd7cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/rescheduleAction.js\":\"1f13663b6116ae8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/schema.js\":\"b21218469f3e3480\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadBlockDates.js\":\"fb46dd9eb919ce57\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadDatesAction.js\":\"6b4c4f5390e3e9d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/today.js\":\"b0211c2d3c8b2b03\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"082c5c244402c602\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9d158a4967a0b9cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/audit.js\":\"edc32a94fc8273d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditAction.js\":\"564670ef7ea5266b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditRanges.js\":\"1250be9d9f2e5964\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/diagnosticsSource.js\":\"5c5efe8451c6d90f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/divergenceScan.js\":\"fcac0d994af5042b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/index.js\":\"fa3362c79b355512\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/propertyChildrenChecks.js\":\"93fddd088f40e48e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/referencesMirror.js\":\"5e34210d47f44eb0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/rowJson.js\":\"49fc62d28bda40da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/schedule.js\":\"0e24d68fc2650f0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/store.js\":\"16960f8193ab41a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/action.js\":\"b09991c6e8a9e4df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/index.js\":\"25a4ac6a24e8bbd6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/plugin.js\":\"0c382ee3a192a179\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"917a2600dd61ce1e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/actions.js\":\"7755c3d035dc45a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/changeMarker.js\":\"c1228ffa7eb13c9f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/diagnostics.js\":\"c1cb726c058a7e7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/fileSystemAccess.js\":\"9e8842621b82ec0b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/filenames.js\":\"f3aed5ee830578f7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/index.js\":\"b51e461996be6130\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/mirror.js\":\"ad232aa108a85ec5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runLock.js\":\"de4a4bf5828b68ec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runtimeHealth.js\":\"db95b7d87fbb2854\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/schedule.js\":\"418e3f0dfbe731e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/store.js\":\"349c55c21ce258cb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/index.js\":\"96dd5d2d4845fef1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/themes.js\":\"d85982285e629d4c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/facet.js\":\"37436f901bbdb37a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/useDiagnostics.js\":\"61d85d9fd4281081\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/dismissals.js\":\"784845d7559607a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/index.js\":\"9c20e6f8adbcd8dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/status.js\":\"b74123568ed98e39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/store.js\":\"78f07fbb978d4bcc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"951d7124ef9e2837\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9a7e8c5f94fa9f0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/actions.js\":\"87eb36e10db1fa3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/config.js\":\"413255de5c37fa6b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/dataExtension.js\":\"ddf55d63000b95a0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/effect.js\":\"d35cd0252792cdc8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/index.js\":\"4a9feaf412dedb94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a4d1903733804bd9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/useToggleTree.js\":\"1b68c26448675420\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/ExtractTypeDialog.js\":\"61801a828409f105\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e54a7ec98402a23f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/PropertyShapePicker.js\":\"002926204073e2fb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/action.js\":\"38fccc39742ac5cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/index.js\":\"cb2110568a8561c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/FindReplaceDialog.js\":\"40b340a6da113f86\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/HeaderItem.js\":\"eac411957aa9e48a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/dataExtension.js\":\"bbc14cef440b1de4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/index.js\":\"8830b98b2aa45779\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/search.js\":\"4cc336b125949bec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/toggleStore.js\":\"6b7848887c9d040c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/LocationPropertyEditor.js\":\"0b9298543207c2c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/MapView.js\":\"481a29918e8639e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/blockTypes.js\":\"2387525ff2b3d11d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/codeMirrorExtensions.js\":\"4ea5539433ffebc5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/createOrFindPlace.js\":\"c1fcab81b1a0ccd5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/currentLocation.js\":\"a37828eed1fa0381\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/dataExtension.js\":\"77b5a89905dd392d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/geoContentDecorator.js\":\"e705fbf819c763ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/googlePlacesClient.js\":\"5c699363b9c731e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/index.js\":\"1a094548c6d65e87\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/locationsPage.js\":\"7e86b4689ca7d8c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/mapViewport.js\":\"a4980039b204349e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/pickCurrentLocation.js\":\"cb71118eb41c5f2a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeAutocomplete.js\":\"95959f145207c49f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeNameCollision.js\":\"07e4428b2b28b383\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/properties.js\":\"c657392822ad170e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/propertyEditorOverrides.js\":\"665fa69acd717ae2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/query.js\":\"e765a6284941fbfb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/usePlaceSearch.js\":\"970f4c4e73b1c98b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ce9dbf510a6219e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"50f812af4713deda\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"94be7affc445c47b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/config.js\":\"be80ad74f3db2064\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/dataExtension.js\":\"91c85e7d411103b0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/facet.js\":\"8bdaac8e51914a6e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/grouping.js\":\"1cdb1be9d8aa465b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/index.js\":\"a602787efc81d1b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"54319258a35a51f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/query.js\":\"6f071fee175307b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/resolveConfig.js\":\"cb566924dd19747c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5e2a068126b52e3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3125decfbabea57a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlDocumentContent.js\":\"4e04e072b9afa077\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlFrame.js\":\"4fac7436eab60e40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/actions.js\":\"5cca7601f4d1e21f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/blockType.js\":\"defcf81f517e6f7e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/confirmRunScripts.js\":\"b5388b18d833051c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/dataExtension.js\":\"d1a8791d56dd42ef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameAnnotations.js\":\"3e7043b48b388baa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameDocument.js\":\"c3b2cda08b76bcdc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameTheme.js\":\"8e2a3bb93274b7c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/index.js\":\"280bfa9ace5198fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/scriptConsent.js\":\"b4c9733ed22ea812\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/sourceMap.js\":\"de12df93ff65e171\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/useDocumentScripts.js\":\"642292e89d52cdc7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/index.js\":\"4d3bb07e468c4237\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/record.js\":\"e2fcde6c4dad4103\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/recordStore.js\":\"7113cd30dd989b0f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/responsiveness.js\":\"e3149184d791b6fa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/schedule.js\":\"f59f395c85bbc51a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/sessionContext.js\":\"b6c855879308a80d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bc88e655307dfe3b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"987f24a20dcc4791\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/actions.js\":\"1c90662f44c7dd36\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/config.js\":\"ec7db2a8106eb8a3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/dataExtension.js\":\"ac97394a1ba28660\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/effect.js\":\"850a59673ba2a8aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/index.js\":\"dea913115fd5b12a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/keyCapture.js\":\"1513a05216275df1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/overrideStore.js\":\"d31a45d2ed33c8ad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2c972983901d1c80\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/HeaderItem.js\":\"2b04ed7e3555ee34\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/LeftSidebar.js\":\"4a0e742c4238daf7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/actions.js\":\"0d396a221cd2f92a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/facet.js\":\"62eca7caa1f3112a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/index.js\":\"b268b0e9f807bb66\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/shortcuts.js\":\"ff939b0002c5a7ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/toggleStore.js\":\"7cdcfd33a92fb99a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/MergePicker.js\":\"b022959657f22d13\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/index.js\":\"d086f28cd0efb0bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/mergeAction.js\":\"e001eedd03656033\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/strategy.js\":\"18a693f3a89a2c48\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/Button.js\":\"1d5c4b2f6d10e906\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"805224832617260d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/defaultItems.js\":\"59b92137b38beb04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/facet.js\":\"25d1a123b9a96249\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/index.js\":\"189206db37be4104\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"68fffc1bb0a617ad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/actions.js\":\"940b81eafbd7c585\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"23f535e7f37f421e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/facet.js\":\"5f3a06c40c0540fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/index.js\":\"72271739308ade86\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/MoveDestinationPicker.js\":\"cafe1696a04950f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fe8e8ad6dbd4efcb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/contextMenuItem.js\":\"660de966620da7dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/index.js\":\"36565ed1ed3b1e8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveAction.js\":\"9f1da402e36b416c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveBlocks.js\":\"0871e32ee27dcc1a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/selectionAfterMove.js\":\"dfc56e23ab67f8c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/TutorialBanner.js\":\"4b85ff5b94d3e8f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/action.js\":\"bbc3603dbacd92ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/bannerDismissal.js\":\"60fa695d145ed023\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/documents/cheatSheet.js\":\"28a2313d14406e3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/index.js\":\"97ee0a7500495024\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/keys.js\":\"d769ae13bf62b6b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/landing.js\":\"9382573b2132acf4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/outline.js\":\"11c251f7059dc4df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/seed.js\":\"bae70c2523719f7a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0a2fc4dc11d92d89\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/analyze.js\":\"e259e32f5ee1adc7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/diagnosticsSource.js\":\"6ba70dc3d04ead23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/index.js\":\"6e8fa59a97a8f1c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/load.js\":\"c5fd92e3342a1f69\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/monitorRun.js\":\"53490662a312090c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/schedule.js\":\"9f75ac06ec31bb0e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/series.js\":\"745a187663b08c85\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/store.js\":\"d03cf1d8b4901c67\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/trendAction.js\":\"e91d9569fe485398\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/verdict.js\":\"9940c0f1fc33874c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/clickToEditAction.js\":\"7887689d6f4cee98\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/index.js\":\"ae705efcf22a20de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/interactions.js\":\"cf96517a05359a0e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b7ada99755d5a4b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGate.js\":\"2f50dc55c90c5422\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGateDialog.js\":\"803293101dab5d4c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/action.js\":\"eb61cfdb287f4f44\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/index.js\":\"7e80834b688c0642\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/localRunMessage.js\":\"9fe72da7680dbdc8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/plugin.js\":\"2e11b18eda4527c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/progressReport.js\":\"768a1e9359444ffc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/sweepProgress.js\":\"00dc442eec01c922\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/FieldRowRenderer.js\":\"7e4152368c6a4de7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/ValueRowRenderer.js\":\"3bb751b66b8bad06\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/actions.js\":\"c0d2bda066c1e7b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/autocomplete.js\":\"4e2b310901495780\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/fieldRow.js\":\"5b7270a843b4ec74\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/index.js\":\"2ab4bbc1c8a019ae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/referenceWarning.js\":\"dce996eb5c8c9036\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueAutocomplete.js\":\"eb7e8ea0bcf1b0a7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueSchema.js\":\"b726191cf28df3b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/HeaderItem.js\":\"f32bafd2b111674e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/QuickFind.js\":\"9cbb404545a66e71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/index.js\":\"a27a5f23218e696a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/recents.js\":\"5c540e88e3dc47e5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/resultItems.js\":\"42fd9f62de001c1f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/selection.js\":\"7d80367bedef50d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/toggleStore.js\":\"11d030f79427436f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/HeaderItem.js\":\"dd4575243cfbc031\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d0033d3818df7769\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/grouping.js\":\"1de898bf85a4f2b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/index.js\":\"498f31fd65fe9a33\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/target.js\":\"aa32da444592ac01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/codeMirrorExtensions.js\":\"328e78853f3419e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/contentPrefill.js\":\"7f591419f57bddf6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/dataExtension.js\":\"c99e3e0bf16fc510\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/index.js\":\"31246018f1fde9da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e1949a6a8f321854\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/invalidation.js\":\"5b26c267f226a366\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/localSchema.js\":\"46d9abdc198a7c02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/index.js\":\"aa8588dbb35b5ddc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7b55659733d60377\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/index.js\":\"ca1f451237b73df8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/referenceNode.js\":\"8f741a0c8fd259a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/remark-reference-occurrences.js\":\"23aa079da1c08ea5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"92d0b69a383e3a5d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/index.js\":\"e5b02d300c8b3f10\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2207af1ce064ce06\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"eead8237cfc03815\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/mergeRetargetProcessor.js\":\"52dd5b8fb0c28bfe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/parseFence.js\":\"d6e4f3a097b08b72\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceParser.js\":\"608b1f9b6ae7affd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceProjection.js\":\"d6eaaf3214bd7ba9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referencesProcessor.js\":\"8159b09b4538c458\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/renameProcessor.js\":\"975653cfed34b968\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/spanReplacement.js\":\"8bfe9f5f703ba4b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/htmlToOutline.js\":\"bba0d36819e410f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/index.js\":\"b19d722cd5aa7ad7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/normalizeClipboardDom.js\":\"72b5ecc6e3ea2016\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/pasteDecision.js\":\"e071665e49db8547\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/action.js\":\"3513c4999a38d0ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/blockIds.js\":\"2cdb09f021d1a10f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/content.js\":\"3a9c623a64e39ae2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/effect.js\":\"ca5571bc392c94a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/ids.js\":\"606a212628bfbd55\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/import.js\":\"293ff96eef1ae6f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/index.js\":\"2db225e86a10ca09\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plan.js\":\"77effc302886e949\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plugin.js\":\"b34e218a31a27770\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/promotion.js\":\"3cfb96f3d71753bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/properties.js\":\"00e67f7c48e6b01a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/references.js\":\"19c833e5c1c92850\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/report.js\":\"d83099575dbc3e09\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/roamMemo.js\":\"1c8fb6d4ac1c5fc1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/runtime.js\":\"d44b966dd2daf265\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/schemaReconciliation.js\":\"2501d6f250e77729\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/srsMarkers.js\":\"f85f16a5ba18f7ad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/todo.js\":\"a3c423ee200d77ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/typeCandidates.js\":\"67fe95d3c59bc12d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/types.js\":\"5aee7d5e2a2db347\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/index.js\":\"c85e7e8ba2471a93\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/store.js\":\"0604102101d53f3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/HeaderItem.js\":\"f3e09ff20f04b8fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"78550476223037d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/index.js\":\"34b2df32a70fc384\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/model.js\":\"83865789494d0f6f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/toggleStore.js\":\"865989555d1b0eab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/useKeyInspector.js\":\"407e2ec6b48924b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f4eca4cf7da6fbd6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/ShellDecorator.js\":\"7583af8d32c1fa62\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/actions.js\":\"f88c3efb9b24a7d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8d74c0a3c76c60f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/index.js\":\"b700d525a69c2053\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/shell.js\":\"a2006d8c0736b0a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/surface.js\":\"9862a9a8472661b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/walker.js\":\"ec1e0a2b948390ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/RescheduleToast.js\":\"48751de1d133b429\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/dataExtension.js\":\"af08dbc8a3e27256\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/index.js\":\"369e43d17381447e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/indicator.js\":\"8f95acffbd409e91\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/moveSrsState.js\":\"2b310ef3a498c284\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"86593182f5d5070f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/scheduler.js\":\"1d0f60b50e4c3d24\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/schema.js\":\"ae62784d074999f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9e86e96ecb18fd60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsClipboard.js\":\"d6227e552cd36a33\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"29cfd23501c2cd39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DailyNoteReviewHint.js\":\"64e4f17810a90dae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DeckPicker.js\":\"1c699f409854c3f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewControls.js\":\"54a183e0a3fc65f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2fe526ff8a727494\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewSession.js\":\"17cab1fcd54e312f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/actions.js\":\"b970f1e01c691525\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/archive.js\":\"cb5693606c4dc66c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dataExtension.js\":\"77679934c93d653d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/deck.js\":\"16504257152b3550\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dueQuery.js\":\"82144b571f8913ba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/gradeDecision.js\":\"e52b2265f474ba38\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/index.js\":\"8580e0334dd66c18\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/keyHints.js\":\"27096ae2a9e198ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewCardLayout.js\":\"ee50173f74c5da71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewProgress.js\":\"53b6bf0cf236ab1f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/schema.js\":\"080aafac2d38991c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/useDueCards.js\":\"9717e260a92f77cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/index.js\":\"595964412e80bd45\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/record.js\":\"403bfa24cfc29acc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/index.js\":\"8ea6d193bf36596b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/persistenceStatus.js\":\"00429d619eabc66a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/requestAction.js\":\"92517e30f6fb67ed\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/TypeChipsDecorator.js\":\"a698391bbee77c25\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/codeMirrorExtensions.js\":\"1f8923ce43888883\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/index.js\":\"40dcf9dfe47b4e8b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/typeAutocomplete.js\":\"d9659c1d5afa299f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d081f534bda29401\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/actions.js\":\"944bc415e014df7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/anchor.js\":\"05f0bb512faa264b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/events.js\":\"5ecf8ea007626404\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/gestureActions.js\":\"5645c22479bebb83\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/index.js\":\"8cfed802d6aa0943\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b215f989750aad5e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/collect.js\":\"de1545a80be45b27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/index.js\":\"86bf0a61ea1f5428\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/record.js\":\"a35a5b7b84fb6e43\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/RejectionDialog.js\":\"57c37db71faa8eea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ed0a14f13df22f6b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/index.js\":\"6233a25efccd6b8c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/model.js\":\"6ed70400857d7a02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/queueCounts.js\":\"244ce79bf8de5859\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rejectedHelpers.js\":\"2ecf034b011353a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rematerializeAction.js\":\"5cdcd0bb0babadc7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/useHysteresis.js\":\"618664aea5bfa8a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/ColumnHeaders.js\":\"d18a744435fda152\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/QueryUi.js\":\"ef7ab945b5d4083e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/TableLayout.js\":\"8477e1da349258db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/actions.js\":\"47e77b4098272523\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/cellEdits.js\":\"d9a5d37b2032e9f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/columns.js\":\"c90554499ba49946\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/controller.js\":\"2aa0adb553f9a62c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/convert.js\":\"30ccbe19630afb26\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/dataExtension.js\":\"1f88f9d8c4bbfaae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/index.js\":\"f526d5e2aec7def0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/keys.js\":\"950fdc7b6f0099f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/model.js\":\"29c1ea232f2ba52e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/navigation.js\":\"6a3afe8d50ffabf8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/backfill.js\":\"69c9e180eded7ae0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/completion.js\":\"d89567eb6b6cd18b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/format.js\":\"1519ae29d68fca16\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/parse.js\":\"b5327b73de7b96e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/queryValue.js\":\"3b9455260ca1e14d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/source.js\":\"47bc8803044d1542\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/registry.js\":\"439a45c1e23d5466\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowGutter.js\":\"34fcc9f8933369f7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowVerbs.js\":\"619ec651ca91e033\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/schema.js\":\"25b744d1f5decc63\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/sort.js\":\"b3872d4ca430f0b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/effect.js\":\"0760eb362940de4e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/index.js\":\"8dde8a7cb532b1d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/theme.js\":\"458e5b22a9b96833\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/actions.js\":\"69edf53bfe06401c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/dataExtension.js\":\"3d9ecc1087845ce3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/index.js\":\"7fdac49599444ef8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/schema.js\":\"30409b01c0b81552\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/TouchSelectionLayer.js\":\"feb8a9e640089a8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/actions.js\":\"086163a0221949bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/defaultItems.js\":\"b4b8be9245c6ba70\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/facet.js\":\"3d9786c07b094663\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/holdRecognizer.js\":\"e711e2e884786bd6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/index.js\":\"26d379984b48aca2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/UpdateIndicator.js\":\"ba8816ae2eb33686\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/index.js\":\"e6db8caa15735301\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/loadTimes.js\":\"1945dddddb31a69f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoNotesRenderer.js\":\"c83d9f71cf764c88\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoPlayerRenderer.js\":\"c6a9fa00129e8971\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoTimeStamp.js\":\"b37a454008a15346\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/actions.js\":\"204f310991a93d01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/index.js\":\"3dfd6b5ffc59d1ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/markdown.js\":\"ce03a2ea8acd737a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/notes.js\":\"db3359dd0fbecc60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/registry.js\":\"5389c7666bb2348d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/remark-timestamps.js\":\"ea760dd5e279c731\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/view.js\":\"e35f4298bd1ca118\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/LinkHints.js\":\"cd2d2ffe45681281\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/index.js\":\"b9396063c2b14a47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/model.js\":\"96db5c2c6a41c101\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/settings.js\":\"294a214e1ae4543c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/actions.js\":\"1c715faa9f653555\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/index.js\":\"81565f9755f5ee21\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/interactions.js\":\"f8a83e6f2272ffe8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/workspace-header/index.js\":\"1cc4784a5ed033bb\",\"/knowledge-medium/pr-preview/pr-1854/src/registerServiceWorker.js\":\"85087e2c5a3d04ba\",\"/knowledge-medium/pr-preview/pr-1854/src/requestPersistentStorage.js\":\"fa7383853f1f3aa9\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authRequestDeadline.js\":\"02a222ad568ef0af\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authStorage.js\":\"d899a10f79c1b2b0\",\"/knowledge-medium/pr-preview/pr-1854/src/services/powersync.js\":\"6189ce18552e9754\",\"/knowledge-medium/pr-preview/pr-1854/src/services/supabase.js\":\"c9f8ffc4e3a88807\",\"/knowledge-medium/pr-preview/pr-1854/src/services/uploadErrorClassifier.js\":\"2411d4420cff7007\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/ActiveContexts.js\":\"4b0a6198505dbf7a\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/HotkeyReconciler.js\":\"9447232290563ce6\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/WipeLocalDataDialog.js\":\"a1a49b6fe1cfcd9d\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionDispatch.js\":\"c49fc06c610f49a4\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionRefItems.js\":\"c51c706be48e4009\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/applyKeybindingOverrides.js\":\"ba7fe3ede9b16705\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockActions.js\":\"a3002268afaf81d5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockMergeGesture.js\":\"f3c1dc6ff8013d9f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/canonicalizeChord.js\":\"fff40c2ffa699973\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultContexts.js\":\"05bb4f11b07b7c22\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultShortcuts.js\":\"f4ac5b5945d5e6b7\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/effectiveActions.js\":\"c398dd10fff2fe1d\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureAction.js\":\"90969ed59aa02adc\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureBinding.js\":\"fd2b22fc75a314a9\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/holdRegistry.js\":\"cabb4743b92e852f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingConflicts.js\":\"e046e8bbcc1cee9a\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingOverrides.js\":\"906aaf4a425d653b\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/pointerAction.js\":\"f765b3cc8ba80b21\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/resolve.js\":\"ee296f080a8ae90c\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/runAction.js\":\"e8cf7c41ebdd2932\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/sequenceMatcher.js\":\"1ccf5ecc2d8be9ad\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/types.js\":\"715255430effea51\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionContext.js\":\"d790f590e80ffbd1\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionDiscovery.js\":\"b7bfd9483bbdef73\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/utils.js\":\"a14310062ec208c8\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/bootStore.js\":\"0775b63e42811c12\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/previewDatabases.js\":\"6c74b7e80d2be33d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/byteTransform.js\":\"cb4b6414caa85d8d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/attachmentCleaner.js\":\"e2c9d57e1c4c79b6\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/attachmentParts.js\":\"8833fc4b5bfd7b9b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleParts.js\":\"909a5ad2b33aa4cf\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleRecord.js\":\"6c7c8e00b3717218\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/manifest.js\":\"350be361c15fcd95\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/takeBundle.js\":\"4297654bf6bc5f40\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/verifyBundle.js\":\"c68cbe8b3fc8ff73\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/cleaningStage.js\":\"f304605d1eb12c6b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionKey.js\":\"73f673b8777c244d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionServer.js\":\"1d8ce1c42c28e98e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flip.js\":\"f8db9735e47a7ecb\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flipAttempts.js\":\"fe31e14cef4abf71\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/pages.js\":\"8c87cb4ef252f76e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/preflight.js\":\"8115fe38310422f9\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/reseal.js\":\"aab69b7fc151e8de\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runConversion.js\":\"a50a09c38ad5cc53\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runLock.js\":\"9739f4750b0ae1f5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealing.js\":\"43ae9a9393fa85a5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealingStage.js\":\"b7c1655b9f4ab515\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/stage.js\":\"70768489236bbc44\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/verifyReseal.js\":\"06da3fcf0d17eebd\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aad.js\":\"f50c874831fad143\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aead.js\":\"8b405af57e12c2b9\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base32.js\":\"719d28601bbaae8c\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base64url.js\":\"b493d474cef35f95\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/binaryEnvelope.js\":\"6e0ea93d6a698bf1\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/byteAead.js\":\"006c39735c5851a2\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/canary.js\":\"5dc3a85d4917052e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentHash.js\":\"95ff40519527577d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentKey.js\":\"bcd026b405dd44ef\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/derivedIdNamespace.js\":\"d8f50d218a3c6cf2\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/envelope.js\":\"cbc7ff9cb4010a72\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/hex.js\":\"853f7496cce2d4bf\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/sha256Hex.js\":\"492962cd1c9eaa97\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/workspaceKey.js\":\"99c15cb302be920c\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/conversionState.js\":\"d836a35434441e20\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4c766182b707ab59\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/pastedKey.js\":\"b2a5eb589f84c201\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1782feab27c63588\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a6473d58e27c5b00\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/keyStore.js\":\"641c939442604060\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/mintWorkspaceKey.js\":\"878185ed686764ed\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/modePin.js\":\"2de836fab05129c0\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/openWorkspaceKeys.js\":\"3af1a16fa79e1a52\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolveWorkspaceEntry.js\":\"49a4481c8e211771\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolver.js\":\"692386958177845e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/workspaceAccess.js\":\"aa11ece69c9d99bc\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/transform.js\":\"485b6068c915efd6\",\"/knowledge-medium/pr-preview/pr-1854/src/themeBootDefaults.js\":\"1fa74bc920a6d829\",\"/knowledge-medium/pr-preview/pr-1854/src/types.js\":\"30a5f53f9b9e2886\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/ClientLocalSettings.js\":\"aee81e603c231a12\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/abortableSleep.js\":\"38b87b3a66b3e493\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/array.js\":\"7e42789e6d3f4639\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/backlinkAutocomplete.js\":\"1bd285dd9c93df49\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockCrumbs.js\":\"fa653e6e115472d1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockrefAutocomplete.js\":\"79301ff269ef0129\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/cadencedIdleJob.js\":\"4b5390bcfb2323b4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/callbackSet.js\":\"06c0336cf178974d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/clientId.js\":\"880faf0c07f383f8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirror.js\":\"1146e72bfa1a6b28\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirrorCompletion.js\":\"30c65f6bfbd71caa\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/copy.js\":\"e39eae213a7774b9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dailyPage.js\":\"07653b92ba8ab9e4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensics.js\":\"47b7e23067d849d6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensicsHooks.js\":\"e18a44deefb458bc\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/deleteBlockThroughUi.js\":\"6bdcf3ea7d4a729a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dialogs.js\":\"1b876df9993dcd2e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dom.js\":\"8b449207ac907bed\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/downloadBlob.js\":\"742ae4b645b9c819\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/exportSqliteDb.js\":\"2317bd0694f24e60\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fileSystemAccess.js\":\"14113aa6f933421d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/flipSlide.js\":\"391df2e9736f2fe5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fnv1a.js\":\"ee5eaf8693a4da5a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/formatBytes.js\":\"d9fbb384b3b368cf\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fuzzyRank.js\":\"9bd74d8c93cf2705\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idbKeyedStore.js\":\"01138a88fc5d3d97\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idleCallbackPolyfill.js\":\"464142af9007382b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardAwareScroll.js\":\"330bc7ef10af40f8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardViewport.js\":\"1518ee2621d59a44\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/lastWorkspace.js\":\"4f7b91188e535c1f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutColumns.js\":\"3d09430be327b033\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionDom.js\":\"cfc1d9226a6ee599\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionId.js\":\"3927c689f287e6cc\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkClickGestures.js\":\"be5e2a5737703704\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkTargetAutocomplete.js\":\"111f9c52deacf5af\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbCorruption.js\":\"2ad78f2ee0b9cd01\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbRecovery.js\":\"75fc5f46e7bf0566\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/markdownParser.js\":\"80f8f83ad0567b4c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/memoize.js\":\"5e720b1e5ec5c61e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameFieldCommit.js\":\"b93fda0266626ed1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameList.js\":\"ce775a3e52ca8877\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/navigation.js\":\"e72979a8788cfbc9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/omnilinerNamespace.js\":\"94b2fb0a7b0fe666\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/opfsPageScan.js\":\"3dbf8aeffd940618\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelClearance.js\":\"e7875868b4c4547c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelHistory.js\":\"c207807a490a7f7d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLanes.js\":\"69b1c7f3b9209146\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLayoutProjection.js\":\"bf720a44d7b1ffd5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelScrollAnchor.js\":\"8cf464c1fd1bd46f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelUrlFlags.js\":\"8f008f2d0baed039\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/platform.js\":\"5dda648916890662\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/pluralize.js\":\"935a202d29625d7e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyCreation.js\":\"91a1a5754b94ebbf\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyNavigation.js\":\"72e13a2172b7f5a8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyValueContext.js\":\"3d36dfb25b1cc0ac\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/react.js\":\"48c34d39c342b945\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeDate.js\":\"c73d7a0bc74c92fd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeTime.js\":\"3e78ae7738bd41cf\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/renderScope.js\":\"b067a3dd37216ec0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/resolvedThenable.js\":\"6b00427fa80d77e2\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/routing.js\":\"4c7149f3d683a897\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/safeMode.js\":\"77e0372fd6e6820b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/scheduleIdle.js\":\"44b5e20929fe2a96\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/screenWakeLock.js\":\"f31fb5854c9106da\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/selection.js\":\"f1908b1e2ebe4d13\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/softKeyboardGrab.js\":\"ff63be0586ee9dfd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/startupTimeline.js\":\"8605b7b4bf3fa019\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/state.js\":\"a4401c6eec9802a6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/string.js\":\"7b922f0c7942d604\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/surfaceZoom.js\":\"93cf208b3c123e21\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/time.js\":\"130e755620cf507a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toast.js\":\"3d5d95a347150cf3\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toggleStore.js\":\"62c6031d38a55a59\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/untilStopped.js\":\"51990ee6189b6a8c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/userActivity.js\":\"43e0ddccd55300c5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewTransition.js\":\"2910a9d9a80cb76e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewport.js\":\"42fe9e91ca05399f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/webLock.js\":\"8bb5614b6af437e4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceRecovery.js\":\"49ae2aab39b743d7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceSnapshotStore.js\":\"307e3aa865a01015\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-compiler-runtime.js\":\"a54dbfbf8ea26d01\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-client.js\":\"552e381ca044f671\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server-edge.js\":\"6a85ef535a21bbc1\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server.js\":\"34541c4e6e118eb4\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static-edge.js\":\"c7e02713fde6360b\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static.js\":\"d55acbe26a862742\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-test-utils.js\":\"3616d0469ff7d259\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom.js\":\"44f1abbac852dbff\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-runtime.js\":\"1340b746f67df9d6\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react.js\":\"b5bf3a9245493770\",\"/knowledge-medium/pr-preview/pr-1854/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
