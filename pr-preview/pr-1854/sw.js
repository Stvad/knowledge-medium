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
		buildId: "e42a7bb29d29-68c68381",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/\":\"1d35d9c275f3a2a7\",\"/knowledge-medium/pr-preview/pr-1854/index.html\":\"1d35d9c275f3a2a7\",\"/knowledge-medium/pr-preview/pr-1854/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1854/assets/FacadeVFS-CgyFc0Or.js\":\"f7107b3c2f669b35\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSCoopSyncVFS-DpzJl27D.js\":\"4eebe9f25a48ab79\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSWriteAheadVFS-DlGdIEBC.js\":\"7286765a34b08730\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-Bskxs-KJ.js\":\"76879e9c640f248f\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-D6RHqS6G.js\":\"fa520a03ccd3efd9\",\"/knowledge-medium/pr-preview/pr-1854/assets/worker-C1WrjI8d.js\":\"194e79e7a5aed343\",\"/knowledge-medium/pr-preview/pr-1854/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1854/chunks/app-CLCwFE9g.js\":\"1db52a587b6c9fb6\",\"/knowledge-medium/pr-preview/pr-1854/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1854/index.js\":\"4ec5cdd3b7d39d49\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1854/assets/AccessHandlePoolVFS-BIZVIYHj.js\":\"17f189cb83277d1a\",\"/knowledge-medium/pr-preview/pr-1854/assets/IDBBatchAtomicVFS-DJ5yp1vN.js\":\"6b5f5e2d91dc8f44\",\"/knowledge-medium/pr-preview/pr-1854/assets/MemoryVFS-DXct_1M1.js\":\"feb5dd2246f4ee28\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-DD5iVoiM.js\":\"5dc2477c8b15c381\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-7pYGBX1v.js\":\"d1424086317a28af\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1854/chunks/AccessHandlePoolVFS-39vVfO3E.js\":\"7bf4176f45dcc86b\",\"/knowledge-medium/pr-preview/pr-1854/chunks/FacadeVFS-BYoGYNJB.js\":\"98d9c3f2884703a1\",\"/knowledge-medium/pr-preview/pr-1854/chunks/IDBBatchAtomicVFS-FSilaOBZ.js\":\"cfec29ff808e4890\",\"/knowledge-medium/pr-preview/pr-1854/chunks/MemoryVFS-D3ge1vbe.js\":\"5bdf9c8f00fd6ad1\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSCoopSyncVFS-DtKZh92D.js\":\"4424c1075e918534\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSWriteAheadVFS-DFR1w-sE.js\":\"efcd9e24cb3fbfde\",\"/knowledge-medium/pr-preview/pr-1854/chunks/Preview-RTnL9u28.js\":\"76dda8be2bbf4e4a\",\"/knowledge-medium/pr-preview/pr-1854/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/card-C2E_pbSB.js\":\"b1d63d2e8a52774d\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-DcHTS4Xx.js\":\"77d3281767e4fc1c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-async-B_gUl_26.js\":\"8344e870a30a45b2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-lGjJtpDF.js\":\"58bd26143f3f1728\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-64L29PzK.js\":\"6ec984875eb7047a\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-B2h-PcDC.js\":\"a63ccdd08ae4ff22\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-BDesaLnO.js\":\"2b666005c5814650\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-Cm321T3w.js\":\"63dcb03b1f1af0bf\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CyZOheRk.js\":\"63cce5913cf97699\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DKphKw8O.js\":\"0b270b7d1e07c4c3\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DmxNTLCc.js\":\"3c3760acc670aa68\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server-legacy.browser.production-D-CV-nvs.js\":\"298f33f5fb952793\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.browser.production-DJ0lb3kz.js\":\"4e78f3a96dd3b52f\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.edge.production-D9v_xTrv.js\":\"85fe85c5d44aca2a\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-eG-wffVb.js\":\"6c6066611a08be26\",\"/knowledge-medium/pr-preview/pr-1854/chunks/server.browser-BO4e9gp1.js\":\"6763a6afea38f505\",\"/knowledge-medium/pr-preview/pr-1854/chunks/textarea-CS9PWXoF.js\":\"7206883fc62d51b9\",\"/knowledge-medium/pr-preview/pr-1854/chunks/ui-BDqiUtIA.js\":\"4967872b39d45221\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-D1cMDcN9.js\":\"8eb29dd69d737fcf\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-async-CW024GuI.js\":\"7811e05034a45856\",\"/knowledge-medium/pr-preview/pr-1854/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1854/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/src/App.js\":\"1cd4b3ea069c3691\",\"/knowledge-medium/pr-preview/pr-1854/src/appUpdate.js\":\"5e8f1ab0e1a48bcd\",\"/knowledge-medium/pr-preview/pr-1854/src/appVersion.js\":\"b3005b7973c5e346\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/initialLayout.js\":\"0d2d2eb110339c32\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/openWorkspaceData.js\":\"05379422a9caeaec\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/resolveWorkspace.js\":\"22cdaf78d29fb9a4\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/workspaceBootstrap.js\":\"940db0c2350b9e00\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockComponent.js\":\"740b958f1418751f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockCrumbs.js\":\"54c8a682ea3df115\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockEditor.js\":\"ee62d31271df2d0c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockLoadingPlaceholder.js\":\"9744a55d7c77892a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockProperties.js\":\"40004e95a93bdaac\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockSearchPicker.js\":\"6a0e2d427723c1bf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ConfirmBulkDeleteDialog.js\":\"d06fa47d3dadb6a3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DividerHandle.js\":\"e49238ac5ab559c6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DraftEditor.js\":\"d1a8424bb12e22d9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/GutterPill.js\":\"e960440c3ae9c5f3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Header.js\":\"5339e44fe043ae04\",\"/knowledge-medium/pr-preview/pr-1854/src/components/LazyBlockComponent.js\":\"0a37f174b6d653a1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Login.js\":\"0371ed0a898442f3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ZoomableSurface.js\":\"17112d14f5e1f5bf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/editModeKeepalive.js\":\"6c817cab0936fb76\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3bae37ed623f8e44\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"24d56a6f0d824a8a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefPropertyEditor.js\":\"8474c300888928d5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefTargetTypePicker.js\":\"0242aa2cbfafe08a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/SelectPropertyEditor.js\":\"a88426073bbb63dc\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/TypesPropertyEditor.js\":\"3ba36c22f77a5c0b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/defaults.js\":\"c293d9350968a606\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/kernelValuePresets.js\":\"5a40dc8064ee8465\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/selectablePresets.js\":\"cf2ee7dd7e666fe2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/typesPropertyUi.js\":\"5e99d37d97a60f43\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/AddPropertyForm.js\":\"36b14feaceeacd23\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyPicker.js\":\"8749dd043469406e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyRow.js\":\"1754014da1660273\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/Rows.js\":\"c9ce4305a2bf41a9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/actions.js\":\"95a65ec85a16317e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/declarationOnly.js\":\"f947b88322e4a8b8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/layout.js\":\"01cc7c120a0b52a3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/model.js\":\"52b18b20b2e8f75d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapeUi.js\":\"c060f05870e64250\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapes.js\":\"7e0cb96fbe08e806\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f5e94554fd9dfd10\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/visibility.js\":\"6a36c469316a4923\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanelSections.js\":\"752c9fdb35b75dd3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockEmbed.js\":\"65662070e17b87e7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockLink.js\":\"66ec37080ef300e7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockRef.js\":\"700cd3652fa69184\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/ReferenceLink.js\":\"0292bec87ccbca7c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuard.js\":\"44dd358977d4f3f3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuardContext.js\":\"be77e4b9cf0b9aaf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/linkInteraction.js\":\"1a597dc38f7b6f67\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/referenceLayout.js\":\"72ca022b0e04af17\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/useBlockRefAncestors.js\":\"a6906f467e939f4a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockGutter.js\":\"60c4a7a4a8d0d8e4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockInfoDialog.js\":\"867fc8f3ba3bff5f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockTypeBlockRenderer.js\":\"3a3ee85b6bae4b4a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BulletHoverCard.js\":\"0afb18fd7c7dd6ec\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorContentRenderer.js\":\"c75cbb682573a869\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7eaeee66bd94a0d9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ColumnResizeHandles.js\":\"2125b567d8d764a8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3e8d2af65c165e8b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/DefaultBlockRenderer.js\":\"ebc3ce68e5c6ce94\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/LayoutRenderer.js\":\"cae7cc58ba440376\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MarkdownContentRenderer.js\":\"df89d54f76b2682a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MissingDataRenderer.js\":\"eb9ca1212f5fd8d0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PanelRenderer.js\":\"b905b42f71a53ac1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6defc689fcb17a04\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/TopLevelRenderer.js\":\"9d658ec80418bf10\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockGutterMode.js\":\"ac1404bd4a49c772\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockTitleText.js\":\"66112cef2483da7f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/fieldCreationKeydown.js\":\"cc190ab0b9292b66\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/layoutRootContext.js\":\"1552ebcee8d0b08e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/TypeChip.js\":\"67a9fc4968e910af\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/chipStyle.js\":\"f36c7ba7d1ee51f8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/anchored-floating.js\":\"f5c5bca1297cefd2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/button.js\":\"58c089e9b11b020d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/card.js\":\"4cbb5e2a1f72914d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/checkbox.js\":\"45f713fa62c0e83a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/collapsible.js\":\"2ae28b972d601ceb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/command.js\":\"3e8cc02621e25c8a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/context-menu.js\":\"a6a6f7fb8b8069a9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dialog.js\":\"de70f79dc55f5802\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dropdown-menu.js\":\"ce672737ec92181d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/floating-listbox.js\":\"1a82de031aec9026\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/index.js\":\"3b3bde9955d2ae6d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/input.js\":\"76b01307090d16fa\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/kbd.js\":\"5ef0c8d9b761f490\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/label.js\":\"ed01531b399490e4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/textarea.js\":\"5447bf52d83c8d3a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/useEditModeYieldKeepalive.js\":\"df89d7e78aa58e60\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/BootFallback.js\":\"95192fc876980deb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/FocusedRowLazyMount.js\":\"996d2e1da916d984\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LazyViewportMount.js\":\"ecf2c9ec42c23929\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LocalDbCorruptionFallback.js\":\"d941cc407022c82d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/error.js\":\"4002c49f860ef8e5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/lazyMountRegistry.js\":\"a08c5168a617ffec\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/suspense.js\":\"5dcfbec5396bf97d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/CreateWorkspaceDialog.js\":\"26c8b8917470c32d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/PendingInvitations.js\":\"e7cc048afc4311ac\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/SyncProgress.js\":\"01b80513a99d1330\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/UnlockProgress.js\":\"0971a6155e838d6a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceKeyGate.js\":\"6bfe514321743a53\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSettingsDialog.js\":\"9c07b1180de24433\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSwitcher.js\":\"295dfc53378de10f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSyncGate.js\":\"7f40109a4d84fb3b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlow.js\":\"e761caf905422823\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlowHost.js\":\"730a8ad67f216b0e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/EncryptionSection.js\":\"f69cc851aa3c315d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/attachmentPrompts.js\":\"1df62889b6ead039\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/bundleFolderPrompts.js\":\"54b03ffa6729e0c4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowDeps.js\":\"941cc679fc06611c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowStore.js\":\"08ebf139426a30f1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/flowUi.js\":\"bc68edeaab977c07\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/useConversionRun.js\":\"6c546f33c07988e1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/keyUi.js\":\"df75ac601334339b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnKeyLoss.js\":\"ac24afb6ac747cb3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnServerE2ee.js\":\"9d2ef0e3f24871b3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/workspaceUnlocked.js\":\"d8240e4250fd880c\",\"/knowledge-medium/pr-preview/pr-1854/src/context/backgroundSubtree.js\":\"777fa085256f5584\",\"/knowledge-medium/pr-preview/pr-1854/src/context/block.js\":\"a262eca747aeb816\",\"/knowledge-medium/pr-preview/pr-1854/src/context/layoutWsContext.js\":\"eae0ee229000cddb\",\"/knowledge-medium/pr-preview/pr-1854/src/context/propertyDisplay.js\":\"2ebefb9062e4fd0a\",\"/knowledge-medium/pr-preview/pr-1854/src/context/repo.js\":\"5f77a7ebfaba9eb9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasClaim.js\":\"5b9d20619745bb59\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasSeatNamespace.js\":\"cff185d33ab961dd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockData.js\":\"c9b73b2b7bb50c9b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockType.js\":\"33c68a08f8752840\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/changeScope.js\":\"e1628f982022f8e7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/codecs.js\":\"689e31164f3af0de\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/derivedData.js\":\"4cbcba32fb798b90\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/errors.js\":\"abef0610111ace63\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/events.js\":\"52ac9d83c4bfd753\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/handle.js\":\"d6b3cd071be94de5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/index.js\":\"8ba188cd598c65cb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/mutator.js\":\"4777c4d1316b44db\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/processor.js\":\"b83b156737ded718\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/propertySchema.js\":\"cbb5fe44909ab42b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/query.js\":\"fd7053388ab2872a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/sameTxProcessor.js\":\"392c31e97b7b4418\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/schema.js\":\"d6b3cd071be94de5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/tx.js\":\"d6b3cd071be94de5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/typedBlockQuery.js\":\"cc86e659d5d77f41\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/user.js\":\"1f547ba71d97e500\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresetCore.js\":\"4614eb6d35418bf1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresets.js\":\"b1e2ea2aa9c78031\",\"/knowledge-medium/pr-preview/pr-1854/src/data/attachmentCleanerIOVerb.js\":\"aa680e4b0848067c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/block.js\":\"c4d7deaae9db3dd9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockCache.js\":\"a174070c83898dc0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockId.js\":\"fe85b89cde083dcc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockLiveness.js\":\"a27bc8cfbbe2a4c1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockMerge.js\":\"ff1c7bdb57fdb39b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockSchema.js\":\"451b7f604779ae71\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypeLookup.js\":\"09a1d66db7be3b5a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypes.js\":\"4f132d9f3a704d0b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/clientContext.js\":\"56028d1dd060a722\",\"/knowledge-medium/pr-preview/pr-1854/src/data/dbFileSiblings.js\":\"d3fb589a87eeab7c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/definitionSeeds.js\":\"b322b4df79684466\",\"/knowledge-medium/pr-preview/pr-1854/src/data/derivedIds.js\":\"8dcb17e3a22791f1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/drawnSubtree.js\":\"2218395b66a33ccf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facetBridge.js\":\"b786fcf037becf10\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facets.js\":\"00063bd86762fb48\",\"/knowledge-medium/pr-preview/pr-1854/src/data/globalState.js\":\"340d5aa1e5bc721c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/aliasClaimRederiveProcessor.js\":\"a9727e014a34b7d6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/ancestorBatch.js\":\"c5ab8d151a52667e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/blockTypeTypeifyProcessor.js\":\"cf014396348f0c54\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/clientSchema.js\":\"044b046f0c087145\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/commitPipeline.js\":\"2e80f3bd72a44dc5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/devAssertions.js\":\"19b0dcd3d9fee25c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/firstSync.js\":\"3401f05731e6db71\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/freshInitialLoad.js\":\"e5154bc96f7a5dfb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/graphBackfillClaim.js\":\"ce74917ffe254720\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/handleStore.js\":\"d1a68935af4871de\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/idleMarkerJobs.js\":\"a466849ab0a8ad2e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initialDownload.js\":\"225d8c51fd4abddb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initializeClientDatabase.js\":\"85dc8679f730a36e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/jsonCanonical.js\":\"428798c8df4ce23b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelInvalidation.js\":\"17b36422d302656e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelProcessors.js\":\"72e2cb82cee1ba53\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelQueries.js\":\"67620cd6a3855491\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/mergeTypeMembershipProcessor.js\":\"67ff6b6e64bd2c38\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/normalizeReferencesProcessor.js\":\"ec5bb5ca0299b392\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/poolInstrumentation.js\":\"f28d7f40ceffb86d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/processorRunner.js\":\"c03d793e2541343b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyCellBackfill.js\":\"80935c8a4c00e26f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildMint.js\":\"00036ac16c284bb9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildrenProcessor.js\":\"96ea76338756a6bf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b09398f8951fcd44\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionSynthesis.js\":\"2c0af852c846a33e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyKeyScan.js\":\"2d7fd44273ce71dd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertySchemaResolution.js\":\"ce7180032c4867b0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyValueEdits.js\":\"3aa0201253d864aa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/raiseProtocol.js\":\"8e8f1525f64e9671\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/readBatch.js\":\"d420029c2605b4d1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/refProjection.js\":\"ff392ef7fec18765\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetLookups.js\":\"d947389aa93a1294\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetProcessor.js\":\"64d9dc0dc81a6801\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/replayMerge.js\":\"d55a931d8c63d01b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/sqlBinds.js\":\"c53ec1b068e48f1b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9c9b4267a49f40ab\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/arrivalProcessors.js\":\"5713e8091167776e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/invalidate.js\":\"fde1d0f72df22a93\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/materialize.js\":\"c9bd40642512172b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/observer.js\":\"ca5aca5d22c0c647\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/reconcile.js\":\"36a4a94cb69610b1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/timingMetrics.js\":\"adb5d5a8cf554b58\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/treeQueries.js\":\"e0859f79cda13cab\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txEngine.js\":\"346a6adb9d51c117\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txSnapshots.js\":\"50104475faa1e6b3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/typedBlockQuery.js\":\"06c31496a8d9d3b2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/undoManager.js\":\"76c70203fc6cfff9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/invalidation.js\":\"13d36b77954d42af\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelDataExtension.js\":\"dd9d502a9e590e80\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelPage.js\":\"8482744e92f5c0ed\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelValuePresetCores.js\":\"de19375039480336\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbCorruptionSignal.js\":\"effef85a0b5d0882\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbStorage.js\":\"5a96036c6a5c8ce4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbVfs.js\":\"66a79ffe61803ba5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localSchema.js\":\"4dbb18312c15ba15\",\"/knowledge-medium/pr-preview/pr-1854/src/data/maintenance.js\":\"31bb9070e3f51f34\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mergeProperties.js\":\"9122bd40bfab5820\",\"/knowledge-medium/pr-preview/pr-1854/src/data/metricsConsoleHook.js\":\"93703d6b0bcebf6d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/migrationsPage.js\":\"02359fd44167755c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mutators.js\":\"bb2a638d758158a0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKey.js\":\"f6c72196880feeed\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKeyPlacement.js\":\"ce7ae64956f29803\",\"/knowledge-medium/pr-preview/pr-1854/src/data/outlineSurface.js\":\"ead6400f99e0e74e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingEditorContent.js\":\"6cee246556834ebd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingUploadsSql.js\":\"cdb05db4f325512e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pluginStateExtensions.js\":\"6791271b3529a798\",\"/knowledge-medium/pr-preview/pr-1854/src/data/powerSyncLogger.js\":\"d5713d7890809cc9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/projectorRuntime.js\":\"20e1a7feac4b8865\",\"/knowledge-medium/pr-preview/pr-1854/src/data/properties.js\":\"8de3d45e430eedb7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertiesPage.js\":\"0ff109ba9c2f1ab2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyChildren.js\":\"159266d96d619ec3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionFanout.js\":\"096e2c86ea2cbd12\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionMetadata.js\":\"456bf821f581f515\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionRegistry.js\":\"6e084755aaed4225\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDisplayMode.js\":\"848ed17e7cb22184\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyRowCreation.js\":\"80af455b30dfa7c9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySchemaCreation.js\":\"256b9ae0112c31d1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySeeds.js\":\"8059d9b78c54bbd9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/recentsPage.js\":\"27557e9274c385e7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/referenceBlock.js\":\"af36a585638968ce\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rejectedUploads.js\":\"9d2d2153e45d73c1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/releasePowerSyncConnection.js\":\"ab39e4c010f953ce\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repo.js\":\"0f65bc76bb9f4363\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repoProvider.js\":\"773db4adb0fafbac\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rowProperty.js\":\"e0ba178713d3ed6c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/searchFilter.js\":\"249b60e21db33ff0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/seedIdentityLedger.js\":\"b83aead009ceebe8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/stateBlocks.js\":\"579c59a23e8c7800\",\"/knowledge-medium/pr-preview/pr-1854/src/data/structuralEditPolicy.js\":\"3472dac921805cf3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/subtreeDelete.js\":\"5a8a52cb76a8acf5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncStreamLock.js\":\"5cd7a3ee5320c5c1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableSqlRecognizer.js\":\"34a25234bf82e716\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableWriteGuard.js\":\"7c7ea57bdf1c78b1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/targets.js\":\"58409a933f861399\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeColors.js\":\"b901b50cca23a646\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionMetadata.js\":\"98f2434663f9b2ab\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionRegistry.js\":\"dc180539f95737ac\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeExtraction.js\":\"09392bf0ce518f9a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeInitialValues.js\":\"19845e7e38649fe2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typePropertyGroups.js\":\"138bc1a0ba2e972d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeSeeds.js\":\"c010ebe02bd0c21a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeTagger.js\":\"354db0dd27c116d1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typedRecords.js\":\"c3a9d2575b2966b9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typesPage.js\":\"14959c7ed9d8377a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userPrefs.js\":\"7ba085df4aa4034c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userSchemasService.js\":\"c730e4437253b978\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userTypesService.js\":\"f6650a5bde339d71\",\"/knowledge-medium/pr-preview/pr-1854/src/data/valuePresetRegistry.js\":\"17070aa038520992\",\"/knowledge-medium/pr-preview/pr-1854/src/data/visibleChildren.js\":\"cd02f4fe3ca20220\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceConversion.js\":\"9d8e5f49eb6f1388\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceFirstSync.js\":\"820b02e8b2c02df2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceIdNamespace.js\":\"99af141927b29e19\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceSchema.js\":\"b76cfc3d0de32e1b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaces.js\":\"f26bbe6db7eb710b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadLog.js\":\"42c12f67cb3279b4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/BlockPasteShellDecorator.js\":\"f6c415b6a1c6f236\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/atTrigger.js\":\"78f959d577e96dc2\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/autocomplete.js\":\"2bbbf3abda3bca4a\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/codeMirrorExtensions.js\":\"ac478f97831ffb8c\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/contentFlush.js\":\"be7c063113020af1\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/defaultInteractions.js\":\"a5c58e381976ca4f\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/editSettleSignal.js\":\"d346665316a5ba19\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/insertImage.js\":\"8760976ebd7fb927\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceCompletionRange.js\":\"df74136007a4d4b0\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceTargetTypes.js\":\"a99ecdf274efcdf5\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/syntaxContext.js\":\"8f9fa22f04a79ec9\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/triggerMatch.js\":\"76b10c83eb433804\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/AppRuntimeProvider.js\":\"90b8d027eca422a7\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/BlockFocusShellDecorator.js\":\"f812e538e94d11f7\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/ExtensionRenderBoundary.js\":\"9c30635fee47a5d3\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/PanelContentRecovery.js\":\"6537f73de7979906\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/apiCatalog.js\":\"c4e56c3e12f5e7f0\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/approveExtensionHere.js\":\"0284c6782c6f7c50\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/armedCutAppMount.js\":\"8116fc1ed1b411ed\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/batchableKeyedStore.js\":\"5c991dd0aa70b6c9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockInteraction.js\":\"cd75e25121d5a8a3\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockSelectionAction.js\":\"ddacc0f6af336cec\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compileExtensionModule.js\":\"06d8047cc855c708\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compiledModuleCache.js\":\"2ee76c98e05f7e03\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/continuousGestures.js\":\"58c34a939866b67d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/core.js\":\"65063c759473f988\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/defaultRenderers.js\":\"ffd1b916b61d2afc\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/definitionFanoutAppMount.js\":\"010d007c186a7dca\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dialogAppMount.js\":\"090809e93427394b\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensionSeeds.js\":\"13f49978971ef892\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensions.js\":\"3e35ef43c4f995a3\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/exampleExtensions.js\":\"8264d4a1badf5b2f\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionApprovalStatus.js\":\"c0598d5b06670aed\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrorToast.js\":\"33830cf0539068ec\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrors.js\":\"bc036d87bcac3cc1\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLookup.js\":\"f84e226db1468f9d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionToggles.js\":\"70cc96e5f276f6d9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionUtilitiesCss.js\":\"2e08d63404efc755\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/kernelPageDeletionGuard.js\":\"fd89bc7f3b84432c\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/liveRuntime.js\":\"d2f180dfefc68ea8\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/openExtensionsSettings.js\":\"28b0d249423cf379\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/overridesCache.js\":\"f757f1c13c252073\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/pluginIds.js\":\"57e32efcfeeb4ae4\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/processorRejectionToast.js\":\"8097f9ab3adb0a98\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeActions.js\":\"c57e5d3d6ca98876\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeContext.js\":\"ab64f3ea0fd7f082\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticAppExtensions.js\":\"676233bfbdf2751a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticDataExtensions.js\":\"b8f067bb409720eb\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/toastAppMount.js\":\"b899ee11fdcd3ef7\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useOverrides.js\":\"ccc3880acf0a39f8\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useShortcutSurfaceActivations.js\":\"ba53ad8f236846b4\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/discoverToggleTree.js\":\"9d2ff0c1dc73bf4f\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/facet.js\":\"516ffab3b34a7c18\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/resolveAppRuntime.js\":\"70ec41a19ae42d16\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/runtimeEvents.js\":\"44a1ba49463e104d\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/togglable.js\":\"540ccafb9b072697\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/variantFacet.js\":\"a4ec72e58034c3ba\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/verbFacet.js\":\"6da6153f6fdc0b49\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/block.js\":\"ec49b3dbd6e645d0\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/focusedChild.js\":\"4e41fdf4265c57dc\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/propertySchemas.js\":\"bf8a8c437014e242\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/typeRegistry.js\":\"69192fa1432d41fe\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAncestorCrumbs.js\":\"18ca28022c1e86be\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAutocompleteListbox.js\":\"c39e9e89a7e8aaed\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedSearch.js\":\"ec069eea3c6a6ab8\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedValue.js\":\"b428677a7bc7d44e\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsFocalRender.js\":\"a3929cd26502d29e\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsReadOnly.js\":\"baef4b22773f9f45\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMaterializeBacklog.js\":\"dc04832f17da709f\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMinuteClock.js\":\"4f8244c4d0c5f72a\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePanelLayoutProjection.js\":\"96c4f157b49c6312\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePendingInvitations.js\":\"e05b94eeed9f0d3c\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRendererRegistry.js\":\"d2240fa3576dab76\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRetainedFieldRows.js\":\"59bf7c659c27a257\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useWorkspaces.js\":\"beb424186edef5d4\",\"/knowledge-medium/pr-preview/pr-1854/src/lib/utils.js\":\"ecc3f2bac0115837\",\"/knowledge-medium/pr-preview/pr-1854/src/main.js\":\"e756af331e901cd9\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/MarkdownImage.js\":\"dcef2caede160d93\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/blockSeparators.js\":\"42dd8789ec6a6a57\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/context.js\":\"f49c467dd92e2dd4\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/defaultMarkdownExtension.js\":\"3b3c0c0df018aa13\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/extensions.js\":\"f130bb79834d69ad\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/renderMarkdownHtml.js\":\"2e00dbf721f7b2a4\",\"/knowledge-medium/pr-preview/pr-1854/src/minimal-editor.js\":\"205ea3c6dbf305bb\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/armedCut.js\":\"41638a8afc8ca685\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/captureMediaVerb.js\":\"da0cb00bb85e31bb\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/clipboard.js\":\"87008a2bea9ac240\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/decision.js\":\"f474c76b3f10362c\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/operations.js\":\"5137552183b17782\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/AccountHeaderItem.js\":\"2668345b00066264\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/index.js\":\"be14bdc72855be45\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1a0c7e7f9cc024ec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askAgent.js\":\"c9e64dafc8ad650b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askedStore.js\":\"32c722c7f8debc94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cfa123195ca8198d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/chipState.js\":\"11a89902f0f36151\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3310e492affac4ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/index.js\":\"3dc73a539e182749\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f5fb2427e513da4f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/schema.js\":\"31753bc4fe9fcf6e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3ad022f39c6bc5f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/BridgePairingDialog.js\":\"667267cd6a8526a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/addMedia.js\":\"2f12bd976349202c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6f33b4f96ccd5f54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/block.js\":\"248c5c2d251fd16d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/context.js\":\"17417844898d1eab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b909b024c2364dc5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/index.js\":\"9f230e3dbe91e87c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/outline.js\":\"d60b470b23479f66\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/properties.js\":\"a5b107739b8ae28e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/refs.js\":\"13823437238f0a31\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b85b50090e4fe0e5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/search.js\":\"080f7dbed5528e94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/shared.js\":\"6143d0238c155360\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"95d12d7ddcf87211\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/text.js\":\"62f277b73e221f36\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentWrites.js\":\"63e46677e218dfaa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/authoringCatalog.js\":\"055bfeb24fb1c883\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/blockRefTargets.js\":\"50428a543ef865ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridge.js\":\"bbc3a6aa67f157d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridgeLoop.js\":\"1fc557f258cf7237\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/changeHistory.js\":\"0e94cc392a05a671\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commands.js\":\"32ae410f8dc2be77\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commentsCommands.js\":\"dc110629a0628ab5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataExtension.js\":\"252cc83504fad227\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataModelGuide.js\":\"39fc304ec8e22e16\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/describeRuntime.js\":\"0233bf5ee70d56b7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/extensionLint.js\":\"e9b0d416c1de54fa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/grainAudit.js\":\"442bd48d649f83d3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/healthCommand.js\":\"e3ad4bffd70de572\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/index.js\":\"fdeefaa47b83b8dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/presetIdentity.js\":\"066c1eea8f1e82e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"58b4e541ef400f14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/readMedia.js\":\"f6d1554b539764bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/schema.js\":\"403491b71e442a67\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/serialization.js\":\"3fb07874510812e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/targets.js\":\"d444563917bfd872\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/tokens.js\":\"84d5426fb09e862b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/watchEvents.js\":\"3efc09d298331c40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/workspaceGuard.js\":\"1a8e696028e84dd4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/writeCommands.js\":\"6e8d31bffeefd91e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/AliasCollisionToast.js\":\"483a478fb12e28c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/DuplicateNameBanner.js\":\"ebfa5f8d2b0628d3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/collisionMerge.js\":\"d86f4e3883561e99\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/dataExtension.js\":\"b66df1bec13c8751\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/index.js\":\"11a6d34f9e7d5ce6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/mergeCollisionAction.js\":\"8678e7f1e896fe95\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/pageStyling.js\":\"3e4484bca6c02e04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/rejectionToast.js\":\"1b16d37a17785b75\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/syncProcessor.js\":\"7334e3f941facef2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/actions.js\":\"6913b4b74ddf0ec7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/addComment.js\":\"3146d5e7bf97019e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchor.js\":\"0c09d2362a0a4ea4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchorState.js\":\"68052a7af7839b96\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/commentLinks.js\":\"50fd55c576d42189\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/confirmThreadDeletion.js\":\"ffe1ee8b078d7b5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/container.js\":\"4229e97e281507a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/dataExtension.js\":\"023522188c83b01e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/deleteComment.js\":\"9d47b571435840e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/highlights.js\":\"70332ca8274a904b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/index.js\":\"d7d68e00c54c5a42\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/linkedCommentsPill.js\":\"9861d87d93b4911b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/margin.js\":\"412e0270b8d0f3d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/marginSchema.js\":\"6b49717c2bdf28e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/newComment.js\":\"e8d680115d81396e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ownThreadPicker.js\":\"4b4deb65f70575b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/placement.js\":\"99ee5a7a9d1d5448\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/queries.js\":\"dbf9dd3f4e086fbe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotePosition.js\":\"b2e87b5935fac40e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedIn.js\":\"c8f3d8189348f59e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedRange.js\":\"e2e197b1ed255e25\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/rangeRefs.js\":\"bc588c1da5c90961\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readHighlights.js\":\"ba91bc141a3c2c54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelection.js\":\"43081b7acc69cef9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelectionUi.js\":\"ff9b49211628c6e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/reanchor.js\":\"d3f0934103ab1772\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/schema.js\":\"b4138b63409ba790\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scope.js\":\"5e4237174ec077d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scopeThreads.js\":\"6f02115877eea11d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/splitRetarget.js\":\"0daa137c52610642\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestionCard.js\":\"5f3dd6f8e929e7bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestions.js\":\"13c81b220aafde46\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaries.js\":\"dc2cbd770ae36589\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaryBatch.js\":\"867b251096c27ff1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/surface.js\":\"866ea77f5c0df626\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threadNavigation.js\":\"8efe134b4f0e2763\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threads.js\":\"bc1f6318f733a28d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ui.js\":\"b98d536cc4849a02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/uiStore.js\":\"ce82d017909a3017\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/appIntents.js\":\"2112e52ff87e5613\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/index.js\":\"10099ea32b3ff2a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/index.js\":\"7152b14c8b0f0097\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/status.js\":\"9667f877d1a7d3fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d6a4577c3bd500cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaBlockRenderer.js\":\"81d878d74fa5f1ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c51c712446f3fc29\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaUploadReconciler.js\":\"cf92c8d19bda4ff5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetDownLane.js\":\"796f153b24c4687e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetResolver.js\":\"da7f0e11a03f9703\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetUpload.js\":\"33c135ab00dd8aad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/attachmentCleanerIO.js\":\"b41d3308078e7636\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/supabaseAuditIO.js\":\"215e77643a85f239\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/blobStore.js\":\"1430a323fe72906f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/byteStore.js\":\"29c636877abf04e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanerIO.js\":\"dee065c5687ccfae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanupAttachments.js\":\"4c313243e621cd26\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/dataExtension.js\":\"9452446cc2fc01c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/downLane.js\":\"f6d1e9d68dfe7857\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/index.js\":\"a985b3e3e7e8d9c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/insertImageContribution.js\":\"5bd69fdc7a3b48de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneArming.js\":\"d5d958f18a95be0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneLock.js\":\"a93287c13d1b7e64\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaBlock.js\":\"857da7be748a0b60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaCapture.js\":\"c72e15cbb14dc99f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaLanes.js\":\"e22f39b1719d437e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewers.js\":\"8ade39533efa87b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewersFacet.js\":\"7495a8f6ef62ab18\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/pasteCapture.js\":\"091f2db07562de40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/resolver.js\":\"4d549e4814536f55\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/retryUploadsAction.js\":\"5f8b914fa124c4db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/storagePaths.js\":\"5da0d48773439790\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadDrain.js\":\"d472e94c6768a120\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadLaneStatus.js\":\"8970732d28d928cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadReconcile.js\":\"fa198a2548fb2edd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadRecovery.js\":\"9c20b508b810616a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadStore.js\":\"6b71d4bc4d19b307\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/useAssetObjectUrl.js\":\"ed32e0dd9a506fa1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"03cfc0a115bac6c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a4cd718a46afd7c4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/facet.js\":\"c1679e5f1bd038bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/index.js\":\"334a4236f9172270\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/prop.js\":\"90b146dd316834c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinkFilters.js\":\"6235e03cb803f30f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f7a3ba7d72b95ca1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BlockEntry.js\":\"f74893b3b118ee47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/LinkedReferences.js\":\"45cd477ba167be92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b3cba631c27614f0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dailyNoteDefaults.js\":\"75a452228b49dfc2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dataExtension.js\":\"bef9e753f40c5383\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/edgeExclusions.js\":\"5bef2ab9f2c9729f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/filterProperty.js\":\"596eafe60b20fdcf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/index.js\":\"fe2527adc403363e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ba86930539f908b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/applies.js\":\"55951daf4c1606bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/countQuery.js\":\"a8c9ba2efec0c8ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9f1b2b7a6849fc35\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/index.js\":\"d58c3f3aef92a4c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"86f81842eaa51724\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/presentationInvalidation.js\":\"b6dd514671b50930\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyEditorOverride.js\":\"f6f3b989ac55b291\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyFilter.js\":\"29d9ead7c89232bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/query.js\":\"f8e575bc5d9b44b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/resolveFilter.js\":\"bc5c7784c49a0a03\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sourceBatch.js\":\"f97f34f2f76ef8f0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sources.js\":\"e6dac735420182e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useBacklinks.js\":\"6cdcbee94e02bf5d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"42889c718436aa99\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayCelebration.js\":\"5a7a9a4a19f34798\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayOverlay.js\":\"03e876daefcee334\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/gate.js\":\"fa858a77581d8dfb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/index.js\":\"acc4d34c27e258a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/wolfTheme.js\":\"f42ca18de32fc0b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/BlockDragLayer.js\":\"dcbf5d2737ecd5e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dragController.js\":\"8d4d6d2305628568\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dropTarget.js\":\"a7358d9476941b85\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/index.js\":\"e3aee7d54ccc4310\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/projection.js\":\"651d4227025adb94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/BlockMetaCard.js\":\"aaa9c3453ac20127\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/index.js\":\"7ca7a625eabf4514\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/AddTagDialog.js\":\"edd506f0dfac3fea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"dff9003555d01724\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/TagNameIssueHint.js\":\"5858e04f5e4711b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/addTagAction.js\":\"ff232c23e38fbc5e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/appendTag.js\":\"762e7f0d0c2e135c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/config.js\":\"af3b782a4a7c151e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/dataExtension.js\":\"d43890d12535d170\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/index.js\":\"2cb8bbdc9b705382\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/propertyEditorOverride.js\":\"20d0d3865f038ef6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6a5f3c3745545e5e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d471825ba4695c9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7f6a43a9c8e99409\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a10fe546ccd513e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9601c0e1e1073e44\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/index.js\":\"642d82c81f8728a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"84ac3dd763806a5f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/CharacterCountItem.js\":\"85d25eb350a06c4e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6090d51cd63c6705\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/actions.js\":\"5e5242241194cf9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/blockType.js\":\"6e5bcae122383acb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/charCount.js\":\"55b6a10321e33362\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/dataExtension.js\":\"4c831d899bd32597\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/index.js\":\"36cce505d90781f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/profiles.js\":\"7ecdda8ca1b94dfd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/properties.js\":\"b96bbe242082c5bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/textCounts.js\":\"ce321a9933b27b1b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/colemak-keybindings/index.js\":\"9d7596821301878f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/CommandPalette.js\":\"e781963a18657c60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/HeaderItem.js\":\"eec7cd2b16ea5238\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/context.js\":\"0fa2e1b81af4ac50\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/index.js\":\"514e2d7502af6a8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/selection.js\":\"26f8a08b73794952\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/toggleStore.js\":\"be50b466e809ddaf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/useCommandPaletteActions.js\":\"2cee6ae7a315e927\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/ContributorBadges.js\":\"113179285b873b52\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/author.js\":\"e4bbdeb33585337c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/codeMirrorExtensions.js\":\"af305c2e12fe202d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/dataExtension.js\":\"fd0b66d3e8f5f9df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/index.js\":\"3cd873e5e3aa880b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/mentionAutocomplete.js\":\"36949b9d86299c44\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/processor.js\":\"13644dc2cb7883a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/profiles.js\":\"d016d192d79183b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/queries.js\":\"eea49899b6534d4b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/schema.js\":\"63b3b81e32056e6b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"38b670eac5f575ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0d2e8ccdba8725a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/index.js\":\"ceb844f7200d09b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"75f794adee8009fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5562385cdce03a4a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/CalendarGrid.js\":\"11a4f4d0dde70440\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DailyNotePicker.js\":\"e49d839013a589dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d6ceae8713958388\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateNavDecorator.js\":\"5227aaee0fb4f3cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateScrubOverlay.js\":\"96302fe6f324786f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/HeaderItem.js\":\"261a85bd4d7d4618\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/ReschedulePicker.js\":\"4898a681358f9a9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b3d56a1e1c44aeea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/actions.js\":\"fb07c0427e84e084\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/blockDateAdapter.js\":\"f74f7a17698cd66b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/calendar.js\":\"8bc83a98975236c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dailyNotes.js\":\"07b1a886741cf33d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dataExtension.js\":\"6f806287b1dcdd9c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubActions.js\":\"073ee7140f2e1436\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGesture.js\":\"e73d125d2784966e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a72166c548ec0656\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a8e1625562af840b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/deletionGuard.js\":\"910f4fd60b40746e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dueQuery.js\":\"d81ef602b5d2108c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/index.js\":\"01c4690d5f0b8169\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/landing.js\":\"0d70214f08570aa1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/localSchema.js\":\"c080a0b9e7b5b238\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/referenceDateAdapter.js\":\"4f5a36bd6fba52a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/rescheduleAction.js\":\"c774093fd684ab58\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/schema.js\":\"220f4468510d10a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadBlockDates.js\":\"ec4435fee32f4605\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadDatesAction.js\":\"16e8bf13ed374162\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/today.js\":\"f54fe2d70f59c771\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"56504c701940bca3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"64cbf748d5186a89\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/audit.js\":\"da6e3cc2fc0c7a57\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditAction.js\":\"64a10940990261aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditRanges.js\":\"94b8531164d563c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/diagnosticsSource.js\":\"bc5eaadf9d102c87\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/divergenceScan.js\":\"d13eecdd645eace5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/index.js\":\"0ec7934eb5f10b73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/propertyChildrenChecks.js\":\"97373a5d4ae1ac93\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/referencesMirror.js\":\"0336b1b844f9339b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/rowJson.js\":\"903666b01ded012d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/schedule.js\":\"dca19a3059eae2a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/store.js\":\"d1728cb46ebc8c94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/action.js\":\"cb5da1c766cde6ba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/index.js\":\"1c0f14d819b5d95c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/plugin.js\":\"1a781754b368da01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"adf4cf2736c99149\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/actions.js\":\"ae100b2ff2696ab9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/changeMarker.js\":\"c77c99402bc08ed2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/diagnostics.js\":\"7f6f090acf8b538f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/fileSystemAccess.js\":\"04a3ff794e8ba41b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/filenames.js\":\"1622d4098668f623\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/index.js\":\"73f93f5a672426fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/mirror.js\":\"3c9833f35bb97b0b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runLock.js\":\"4d1742ffcf9ae56b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runtimeHealth.js\":\"19dd7d4f8c5447a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/schedule.js\":\"d1ca5ede1ab89d70\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/store.js\":\"0984878fac27c46c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/index.js\":\"0882fd5f6cde169d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/themes.js\":\"1aa0839b8f84d8f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/facet.js\":\"a12e711893fff60c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/useDiagnostics.js\":\"bf205923a52eb3c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/dismissals.js\":\"8cabd3d919fb4a4a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/index.js\":\"166677be68768b4a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/status.js\":\"235b5df27b4f6d93\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/store.js\":\"6212db0cd6597ee3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d6ee8aa2361d7b62\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b9296836bae5ffbc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/actions.js\":\"7ee3ecf3b3bbc4b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/config.js\":\"ce25a6f520097ff8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/dataExtension.js\":\"33fd390ecfb84fa9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/effect.js\":\"901a667b95d48f6f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/index.js\":\"1fb8a861d635e087\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/propertyEditorOverride.js\":\"40547f55ee2b9ec9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/useToggleTree.js\":\"eba2932f43b1edf7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/ExtractTypeDialog.js\":\"f667c12dc77570ae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a1b78f9dcfc7c2ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/PropertyShapePicker.js\":\"0df7a7fcf5cbe9e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/action.js\":\"94012f86440ecb92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/index.js\":\"f7a5d865b57bfad3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/FindReplaceDialog.js\":\"595884127159576c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/HeaderItem.js\":\"ce291915dfeb1aaa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/dataExtension.js\":\"0a6cbab4922b4c1e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/index.js\":\"88318f93dfa172f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/search.js\":\"a38d672b880a975b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/toggleStore.js\":\"9ecbc9e0c1576280\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/LocationPropertyEditor.js\":\"8ae1cdd5cda49fd1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/MapView.js\":\"560c67f604e470ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/blockTypes.js\":\"a7adf48ce6457f74\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/codeMirrorExtensions.js\":\"50b03fe0c8269a76\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/createOrFindPlace.js\":\"b222732cd60f9dec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/currentLocation.js\":\"a837d6ec5b5530c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/dataExtension.js\":\"a1cd7d9f680bbe28\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/geoContentDecorator.js\":\"c38a90c7c10067a0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/googlePlacesClient.js\":\"60c08fff461a0285\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/index.js\":\"808719c9172eed1d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/locationsPage.js\":\"0e994a83b47ebc76\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/mapViewport.js\":\"68dcaf7ff91a91cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/pickCurrentLocation.js\":\"3a6b8f04ac297859\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeAutocomplete.js\":\"9a879dd978deb423\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeNameCollision.js\":\"fb68903622ba13b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/properties.js\":\"f69760f8eae5d2b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/propertyEditorOverrides.js\":\"fd374f2c0cd3697b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/query.js\":\"ab03c3d6dc87dde2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/usePlaceSearch.js\":\"43ab7af68ec04ff4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"01c1ee0f1d924dea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d50820c08005689b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"46f0cfcd7f7a08e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/config.js\":\"9c93f5acb562b909\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/dataExtension.js\":\"53332d2948f7d3dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/facet.js\":\"538f7793f3bca033\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/grouping.js\":\"e264b9622af82375\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/index.js\":\"bf12e8b02f6b7e70\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f98763922830ff9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/query.js\":\"8534c8e18ce2b030\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/resolveConfig.js\":\"9d9f991111a9178d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"78a9f9548e24e68c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b058129fdc8540bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlDocumentContent.js\":\"63c7398636b440dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlFrame.js\":\"ff84e319ce4cce47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/actions.js\":\"ca84158e4d82d09e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/blockType.js\":\"8bc252ba46cee664\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/confirmRunScripts.js\":\"9f3238a7828eaa7a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/dataExtension.js\":\"b6f9f4ea30dcb0d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameAnnotations.js\":\"e2e9bf6c9f76defa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameDocument.js\":\"521e8bf9b2501b13\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameTheme.js\":\"271f7e9efda8fdd8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/index.js\":\"897dd70702ba067e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/scriptConsent.js\":\"6483420a81e4cb04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/sourceMap.js\":\"b87dd7e2ff0044df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/useDocumentScripts.js\":\"8038255f93662364\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/index.js\":\"914ca10df2580fe3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/record.js\":\"e868f8f56a462d56\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/recordStore.js\":\"b23e40a34d8b80f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/responsiveness.js\":\"a79f53b45d729be1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/schedule.js\":\"24d027012b053347\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/sessionContext.js\":\"93c3645edd4d9fa2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ab49296d9887a50b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6fd3addc24a690e4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/actions.js\":\"d17a5686343a090a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/config.js\":\"593a8eb471b4d85c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/dataExtension.js\":\"5dfbee0298f79578\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/effect.js\":\"743959b188f7e8f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/index.js\":\"b11ec9c1db2a876f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/keyCapture.js\":\"6a28658b23bee2d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/overrideStore.js\":\"ef2532594aba1fb3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6baef2a968a3c2b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/HeaderItem.js\":\"f23c0c10d2a32e2a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/LeftSidebar.js\":\"3699893ba731c1c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/actions.js\":\"1be4fe09f001e677\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/facet.js\":\"93d585688cdc751c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/index.js\":\"b7a6d22f100bf81d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/shortcuts.js\":\"1de733e5ea07b6f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/toggleStore.js\":\"3f8a32d6f92989af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/MergePicker.js\":\"6cadd4f6e37c73a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/index.js\":\"0ae3d3388d3e6a35\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/mergeAction.js\":\"83116fdc00b86da5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/strategy.js\":\"89a490ad490d0251\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/Button.js\":\"428b335bc5f75b7a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c03d1713bf8b0b21\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5f56f1a917070b74\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/facet.js\":\"2fe71777c1c709cb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/index.js\":\"2eb74711836dcbbc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4edf758aae54c78f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8deb3fc4ab3bc20e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"db3b7c523b8e73a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/facet.js\":\"eb701b5471b14937\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/index.js\":\"1280720f857402a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b7f0a5342e22d549\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/blockSubtreeMembership.js\":\"71031c26c23cb0be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/contextMenuItem.js\":\"329f68df4f40290f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/index.js\":\"1e0369c1369296c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveAction.js\":\"d77eab26785591d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveBlocks.js\":\"af1971c28688b39e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/selectionAfterMove.js\":\"28cb1536ec2dd14e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/TutorialBanner.js\":\"732ba7199c628102\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/action.js\":\"9e4f00cc5e281246\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/bannerDismissal.js\":\"6c35530d0f8b58a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/documents/cheatSheet.js\":\"31bd91fcbd57f8d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/index.js\":\"9bfdfe45212a63dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/keys.js\":\"558877ffeafcac9c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/landing.js\":\"df21035491a92f5a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/outline.js\":\"a65ba9bde2378260\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/seed.js\":\"badcedb4b94fda9f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8c7f9c5d4ef4885c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/analyze.js\":\"19d53fc14ed79982\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/diagnosticsSource.js\":\"eb3edf8714810671\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/index.js\":\"ddc6fc2ebb920e9e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/load.js\":\"569e273396d50f4b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/monitorRun.js\":\"c109ae5b7460f891\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/schedule.js\":\"cf4847d9e1e262e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/series.js\":\"e2522d0ad6be30f1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/store.js\":\"5efff7d499e8efbd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/trendAction.js\":\"bb9740ca8ffebd92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/verdict.js\":\"098210ab8a4c38e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/clickToEditAction.js\":\"fae4fb217c9f3790\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/index.js\":\"1b2cc316fd5f0f22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/interactions.js\":\"f852527f167bb632\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f90e12c7d34cd85c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGate.js\":\"fc1b6e18df646b8d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGateDialog.js\":\"34f736d2d9a16c47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/action.js\":\"23edef657fb806d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/index.js\":\"2bbf56b8391a23c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/localRunMessage.js\":\"8c2c128e5c2aa22c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/plugin.js\":\"b61c088f4248e612\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/progressReport.js\":\"0795bac603f4aafd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/sweepProgress.js\":\"3fa630a5e27ef960\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/FieldRowRenderer.js\":\"4f9b8c92ab9f88fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/ValueRowRenderer.js\":\"1300771d36f7c6ba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/actions.js\":\"b5ba74939ec7fe80\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/autocomplete.js\":\"5dec8bf44fef975b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/fieldRow.js\":\"9033b30f815485b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/index.js\":\"ae4f77c6fbfaeb4d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/referenceWarning.js\":\"40608851d69b40b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueAutocomplete.js\":\"58ccdd8bde1a0ecb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueSchema.js\":\"b070f8faf11992de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/HeaderItem.js\":\"62fc59ce4b86e582\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/QuickFind.js\":\"9f8372ce72d85ca0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/index.js\":\"f155030e1e3db25f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/recents.js\":\"51bc5e3ecd0d9a09\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/resultItems.js\":\"04c949fb31406bc9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/selection.js\":\"67fa3e42b2678b27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/toggleStore.js\":\"9edd5d94e9538f61\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/HeaderItem.js\":\"38c3bf618af30b07\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e61c9c85856323f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/grouping.js\":\"8e4317dfdfc48d34\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/index.js\":\"004b6e2dfb3bbc94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/target.js\":\"e92c0c303e54155a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/codeMirrorExtensions.js\":\"491c7d1d48de0884\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/contentPrefill.js\":\"cb4066161f2a22c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/dataExtension.js\":\"6ec1ab4aecb35b3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/index.js\":\"42b10163854dc723\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9b6779424f58ea3b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/invalidation.js\":\"6908ebdc0781de60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/localSchema.js\":\"2d7d260dba127852\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/index.js\":\"7fd110e66f118ec7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"00e88f1d5ef31762\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/index.js\":\"b917fa782a02d62f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/referenceNode.js\":\"15d1681ed8551114\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4fe094e80c76c720\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7035fa432eff6fa2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/index.js\":\"4da61ccd7c572375\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5c8863218a5e12c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ce0119021061f7e9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/mergeRetargetProcessor.js\":\"34beef7692760ac7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/parseFence.js\":\"3b7c02abe963886b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceParser.js\":\"04c25dd97b702435\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceProjection.js\":\"b7361ac4dae792f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referencesProcessor.js\":\"6ff5bbd0f695d752\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/renameProcessor.js\":\"6861251baddad96a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/spanReplacement.js\":\"2ceb98ff7c35c21e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/htmlToOutline.js\":\"42f43d683d32a7a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/index.js\":\"a52468faa733b71e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f34cf3f696ce671e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/pasteDecision.js\":\"59f7d71066231cfa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/action.js\":\"e233a087cd0e611a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/blockIds.js\":\"086abfa8be76e686\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/content.js\":\"b0440d71929bc980\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/effect.js\":\"28597382f1c78193\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/ids.js\":\"f9e7fffef78a4349\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/import.js\":\"beeb7255b189a13b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/index.js\":\"0ef5708626cec4f3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plan.js\":\"f4018964033daad8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plugin.js\":\"7b60aabfb33b389c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/promotion.js\":\"7b486e6afbbfb3db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/properties.js\":\"ec48bcac7b4bf39a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/references.js\":\"2c444fe481ced056\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/report.js\":\"fd9cfab7e38ae957\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/roamMemo.js\":\"7e80ec0b13bd597a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/runtime.js\":\"8248a5efe6046897\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/schemaReconciliation.js\":\"8f4517c5c4637d3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/srsMarkers.js\":\"eddad87813fd1bb3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/todo.js\":\"a9ffb9de3f99f54e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/typeCandidates.js\":\"78726a8f0df1e6c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/types.js\":\"a70e2c89ff116c13\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/index.js\":\"c1880959ded50021\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/store.js\":\"e59aa2c1e22b3acf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/HeaderItem.js\":\"67f46d31e3766d92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6f66dec10a1fc79e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/index.js\":\"828f76d196e26901\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/model.js\":\"d60908ff87b2e78c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/toggleStore.js\":\"1f5fe9b5566853a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/useKeyInspector.js\":\"c41d680884fd17d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8a60c468ca19df59\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/ShellDecorator.js\":\"0ac25d3e53069063\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/actions.js\":\"e2106f957bffe2be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3357858573b26bf4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/index.js\":\"e141f26fe43b62f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/shell.js\":\"de9c223d9ff28e38\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/surface.js\":\"49a78d6fc7dda67f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/walker.js\":\"78df1485fe10d3a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/RescheduleToast.js\":\"389713040bb19be8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/dataExtension.js\":\"ce07572c99dc1b62\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/index.js\":\"878f998e9e0277e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/indicator.js\":\"696f1daa868f9299\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/moveSrsState.js\":\"79918aa0d408c0aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4c921a7ca56363d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/scheduler.js\":\"6827ab7cf91ed3a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/schema.js\":\"4b9b68027ee170e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6c1808788c118cae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsClipboard.js\":\"bc5aa4a0051164e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f02c8a867b9496e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1beba08e3abf94a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DeckPicker.js\":\"03025ab7eada93d8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewControls.js\":\"fc522c10b9a41616\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewDeckRenderer.js\":\"597f8f53db0b6541\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewSession.js\":\"d770ceaa680e3dfe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/actions.js\":\"4b6e47ca29a71623\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/archive.js\":\"79288225231c1c0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dataExtension.js\":\"414be916d688fde1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/deck.js\":\"bc5e4cb23c560eac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dueQuery.js\":\"5f262cdb1fde744e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/gradeDecision.js\":\"6318bd8be5dffea1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/index.js\":\"d430f6eda37715f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/keyHints.js\":\"21eb0e195ba2e252\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewCardLayout.js\":\"17b8dfdbe11de62d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewProgress.js\":\"97028327e8f0e80f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/schema.js\":\"13680a4780f3f749\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/useDueCards.js\":\"44366496f746d7da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/index.js\":\"7129a89569282333\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/record.js\":\"a492aaa072d9c990\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/index.js\":\"759267e10f252251\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/persistenceStatus.js\":\"80157a6cee47fffe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/requestAction.js\":\"ae157ce83dd76c3a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/TypeChipsDecorator.js\":\"d459d7dc012a4f75\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/codeMirrorExtensions.js\":\"9e5da1c9b6007f27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/index.js\":\"40fc2a3a8937e502\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/typeAutocomplete.js\":\"dd80faecc5b676f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"aa7706c4baa843f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/actions.js\":\"829f105226f41fb4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/anchor.js\":\"155bb10e8a7a18a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/events.js\":\"fe26f70f793d9c5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/gestureActions.js\":\"d29384f5493bce00\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/index.js\":\"ab946e2b58701fa9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a5a7eabf3a3a84fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/collect.js\":\"1b55fb7d28a74f90\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/index.js\":\"563b1023181a52ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/record.js\":\"cdd44357853a7d21\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/RejectionDialog.js\":\"0702c2e9159d62e5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a8c33fcc33607175\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/index.js\":\"7730a97b141b2246\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/model.js\":\"84c9e5445cb4ea88\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/queueCounts.js\":\"1806aa12437add1f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rejectedHelpers.js\":\"27fb142bb90f6cff\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rematerializeAction.js\":\"3ed0f45eff7fe6a3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/useHysteresis.js\":\"a8f55e2cd795441e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/ColumnHeaders.js\":\"7a2de2caa861ff6f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/QueryUi.js\":\"d3cd8137845efae3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/TableLayout.js\":\"fbae2d4e3e59bbc9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/actions.js\":\"4795ad29f15ed338\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/cellEdits.js\":\"bc5147c3cfcf14da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/columns.js\":\"fde2294be4b1d6ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/controller.js\":\"33be52809ed27421\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/convert.js\":\"b470463f67efbad7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/dataExtension.js\":\"640b7c0b70c2952f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/index.js\":\"4dda0f13c035f433\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/keys.js\":\"54ae34df7e1b6cbd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/model.js\":\"e4d04094c4165bc8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/navigation.js\":\"84dd77de55ab994d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/backfill.js\":\"ba7210f329fbb613\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/completion.js\":\"d20b3af9a7b8bcca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/format.js\":\"848472075b3992e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/parse.js\":\"1975a88edc05fdaf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/queryValue.js\":\"c997138562da00d4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/source.js\":\"76b8b59b0dfe5884\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/registry.js\":\"fbd51551c1963615\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowGutter.js\":\"9729eba7459d6e62\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowVerbs.js\":\"da3fc2c9a557c344\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/schema.js\":\"67756046f00b5c3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/sort.js\":\"a3fa25b0b469b592\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/effect.js\":\"f5b07da2d76504bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/index.js\":\"c8450bcdac594a7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/theme.js\":\"18a27f35f7813d27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/actions.js\":\"dc180fd3cc53d1cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/dataExtension.js\":\"a5747663d22b8749\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/index.js\":\"7f36b20077b4199a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/schema.js\":\"1ae8e2c46a9d796e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9d191186644be398\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/actions.js\":\"5669ca7d13154f67\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/defaultItems.js\":\"3a3072625c9949ec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/facet.js\":\"28ca4360f289911d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/holdRecognizer.js\":\"fc88aad8d6744e2a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/index.js\":\"07d21f0ba940cbdf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/UpdateIndicator.js\":\"0313bf81d82cebf4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/index.js\":\"5ccfa1161d6cc775\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/loadTimes.js\":\"a9863028f239636d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoNotesRenderer.js\":\"46393e5b5b8fc140\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoPlayerRenderer.js\":\"b0174554bdf5a53d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoTimeStamp.js\":\"b2dfc2b432f330fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/actions.js\":\"679866f3920381ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/index.js\":\"d7e2133e874e6908\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/markdown.js\":\"f9bf0e16b427d6c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/notes.js\":\"33e148b71322fb7e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/registry.js\":\"378509ea3d7e75d1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/remark-timestamps.js\":\"02550b17f4a49f5a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/view.js\":\"70b28f70116cc3a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/LinkHints.js\":\"4b79fad383399fd5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/index.js\":\"b97613a8c6b64584\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/model.js\":\"dd2bf4d93f15b1f3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/settings.js\":\"2da78923ab56d364\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/actions.js\":\"931c409d28384954\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/index.js\":\"fb9f8cf669ebdf54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/interactions.js\":\"c95bf312394b734e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/workspace-header/index.js\":\"13e327c6175e6645\",\"/knowledge-medium/pr-preview/pr-1854/src/registerServiceWorker.js\":\"aa0bf5de526bf378\",\"/knowledge-medium/pr-preview/pr-1854/src/requestPersistentStorage.js\":\"ac31b40db92e08c5\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authRequestDeadline.js\":\"d748529422205c03\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authStorage.js\":\"775374d9799253f9\",\"/knowledge-medium/pr-preview/pr-1854/src/services/powersync.js\":\"59f764647ddcd1a4\",\"/knowledge-medium/pr-preview/pr-1854/src/services/supabase.js\":\"bfb6d0d448aab864\",\"/knowledge-medium/pr-preview/pr-1854/src/services/uploadErrorClassifier.js\":\"64673bc11e9a37c1\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/ActiveContexts.js\":\"af490880211e2201\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/HotkeyReconciler.js\":\"e08a1491cd837a73\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/WipeLocalDataDialog.js\":\"7fe76bd9f2bc7d65\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionDispatch.js\":\"bb76956f70d782eb\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionRefItems.js\":\"0b9befa67268a25e\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/applyKeybindingOverrides.js\":\"33343877729062b5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockActions.js\":\"182eb41e97a042d3\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockMergeGesture.js\":\"292d5b16a4e8b1b8\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/canonicalizeChord.js\":\"3f2f288e1266d5e1\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultContexts.js\":\"e0c41c96e3bc9685\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultShortcuts.js\":\"087d6589b01aa2c2\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/effectiveActions.js\":\"26fd292eb3141bd5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureAction.js\":\"9e99859d5a53e121\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureBinding.js\":\"b61833b81be557af\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/holdRegistry.js\":\"d3b842b43a4b6319\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingConflicts.js\":\"71b34fbecd167ffe\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingOverrides.js\":\"f482a3dd910440a8\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/pointerAction.js\":\"2ac3b2aa52544807\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/resolve.js\":\"39c96f5c5a003016\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/runAction.js\":\"4e56cfed4c920a0f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/sequenceMatcher.js\":\"50ab13cd230ea7b6\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/types.js\":\"b755ef0bb036e19f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionContext.js\":\"fb114105cc06eb43\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionDiscovery.js\":\"b8ad73d34550385a\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/utils.js\":\"a03d7043b3781ce8\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/bootStore.js\":\"7e0f92b0297a30ed\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/previewDatabases.js\":\"6d56f0719671db88\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/byteTransform.js\":\"54bbedd63ca9a20d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/attachmentCleaner.js\":\"987b2321b4ad2b7e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/attachmentParts.js\":\"693308af2c83263d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleParts.js\":\"2eee43553e6f322b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleRecord.js\":\"dad2e90f0967ef0f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/manifest.js\":\"633545ba3abdd597\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/takeBundle.js\":\"e68ed88ef9dd99af\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/verifyBundle.js\":\"33abef51415eddeb\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/cleaningStage.js\":\"018d9cb4ba3c23b7\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionKey.js\":\"5f3080962271b096\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionServer.js\":\"14d1c3d0dd7a29fe\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flip.js\":\"addf97ea917821fb\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flipAttempts.js\":\"c67cf84ea6de8b0b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/pages.js\":\"b9d8b8fd94051f97\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/preflight.js\":\"b2c3f98d9afb8ebf\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/reseal.js\":\"2739ce123daefe0b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runConversion.js\":\"8238432997a4647d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runLock.js\":\"8c9483f32dafd822\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealing.js\":\"074e1fd8b478af42\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealingStage.js\":\"46c6067698b89d2a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/stage.js\":\"80fb47411b5c42a2\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/verifyReseal.js\":\"597c5ba203dd7728\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aad.js\":\"a5f212e3946a6345\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aead.js\":\"dce24d7bc938634e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base32.js\":\"f207511b2d697aec\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base64url.js\":\"7062668f2a723baf\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/binaryEnvelope.js\":\"25939b544efb7761\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/byteAead.js\":\"7ad27acb48ba0ae1\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/canary.js\":\"9317b8ca73d1383f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentHash.js\":\"485cc499d00c722d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentKey.js\":\"db837b1c9cbc1031\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/derivedIdNamespace.js\":\"06e098ecc7e07e80\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/envelope.js\":\"319dbf8a2bb60d34\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/hex.js\":\"3fb40fc7b346f12b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/sha256Hex.js\":\"69ddb61fef214c5a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/workspaceKey.js\":\"f8f9963351c531a7\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/conversionState.js\":\"f9aaf5683d0b20e6\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3e6fa61e39b17b40\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/pastedKey.js\":\"e79797684cf2fab8\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fe7599d13d8f5222\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/upgradeWorkspacePin.js\":\"eda776b92f91c99c\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/keyStore.js\":\"88b743fbc7420f60\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/mintWorkspaceKey.js\":\"c4aafb4ed5075db5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/modePin.js\":\"bb290559f13d56bb\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/openWorkspaceKeys.js\":\"8cc0be2dfaa4f1a6\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolveWorkspaceEntry.js\":\"c046652416ad531a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolver.js\":\"e93b6433f718fb85\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/workspaceAccess.js\":\"34c7adab0aaae519\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/transform.js\":\"4b3836dcc33e0210\",\"/knowledge-medium/pr-preview/pr-1854/src/themeBootDefaults.js\":\"6a7b67c6565ee626\",\"/knowledge-medium/pr-preview/pr-1854/src/types.js\":\"d35a83f05a2559c9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/ClientLocalSettings.js\":\"de446bc216033f04\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/abortableSleep.js\":\"98a95d9086d6ddfc\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/array.js\":\"b83d5b5848f496b4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/backlinkAutocomplete.js\":\"678552c4d3adcd69\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockCrumbs.js\":\"022d938d0d70e02e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockrefAutocomplete.js\":\"c23427c73ac8a1ac\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/cadencedIdleJob.js\":\"d221f8974da21ed0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/callbackSet.js\":\"1386e676b7257744\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/clientId.js\":\"a16d49baed2bf585\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirror.js\":\"23ec9c02bf3a75a5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirrorCompletion.js\":\"2fc80c4c3015f50c\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/copy.js\":\"d9b4144974ec2fcb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dailyPage.js\":\"c6b6c26992a63d0b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensics.js\":\"2225f146b67ef2d1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensicsHooks.js\":\"faf12ef31bf6eded\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/deleteBlockThroughUi.js\":\"5f01ee42ea43ee4f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dialogs.js\":\"05ced89784268177\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dom.js\":\"f99fd00fa73cec06\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/downloadBlob.js\":\"b243eb3d6eb3dc95\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/exportSqliteDb.js\":\"0fc18fdf086e024e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fileSystemAccess.js\":\"1de79dd2d3cbe5ee\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/flipSlide.js\":\"d3081e25c74f3fbd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fnv1a.js\":\"5e97145580fc9d6e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/formatBytes.js\":\"d1b17ec25aca882e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fuzzyRank.js\":\"8396b178f669f330\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idbKeyedStore.js\":\"ec9bca2aa0836e35\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idleCallbackPolyfill.js\":\"f4c16ccb641a823e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardAwareScroll.js\":\"4616a8947c343561\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardViewport.js\":\"3f9d9799638417f2\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/lastWorkspace.js\":\"0ffab1d55c403780\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutColumns.js\":\"ce9ce431eec0336f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionDom.js\":\"5d32a65ea68e8883\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionId.js\":\"39d313b91d4bc86f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkClickGestures.js\":\"6e1b04040ef584ae\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkTargetAutocomplete.js\":\"cad56314499441d8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbCorruption.js\":\"67e8e6085d90f61f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbRecovery.js\":\"8215ee5a7c25621b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/markdownParser.js\":\"a535120cdfa6a3fd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/memoize.js\":\"2aea72031728293d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameFieldCommit.js\":\"a2357d0a301e8612\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameList.js\":\"7bd719cd666830ed\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/navigation.js\":\"cf3f1862f25b9558\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/omnilinerNamespace.js\":\"8afd43bb6cebfb56\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/opfsPageScan.js\":\"65e199a440648aeb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelClearance.js\":\"c90ae567b8d0a568\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelHistory.js\":\"11b3564cdabe12cb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLanes.js\":\"dc42ee854b29d9e6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLayoutProjection.js\":\"29c036465558e28e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelScrollAnchor.js\":\"def485b2558efcd2\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelUrlFlags.js\":\"e359e37f1c8afc4b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/platform.js\":\"1f0a211c1069ebdb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/pluralize.js\":\"cc283f198fd9f046\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyCreation.js\":\"51800fa1ca6ed97e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyNavigation.js\":\"9f438e01a3baa516\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyValueContext.js\":\"40cc8b90d14a9246\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/react.js\":\"b5b7287dd0d327ca\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeDate.js\":\"cb0137bb07a1b515\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeTime.js\":\"60cd52f0b775fba5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/renderScope.js\":\"096c30b93a9441f6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/resolvedThenable.js\":\"7e4271471383591f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/routing.js\":\"d8bec41afc6f7557\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/safeMode.js\":\"66124339a55a8957\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/scheduleIdle.js\":\"5ae4a56e02d413f0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/screenWakeLock.js\":\"9e4c43844f0ebd65\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/selection.js\":\"585e933c8371c57f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/softKeyboardGrab.js\":\"309c67cac62bef9d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/startupTimeline.js\":\"a932ce73bf2ce6d6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/state.js\":\"855d818998d8f041\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/string.js\":\"97430e58a8a06395\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/surfaceZoom.js\":\"cb68b1d11635c38e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/time.js\":\"680bab44a5e2c379\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toast.js\":\"8f1f5f83fc332eae\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toggleStore.js\":\"160420644ea03a57\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/untilStopped.js\":\"e1cf8c9c799e8b15\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/userActivity.js\":\"29548997de1a2c51\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewTransition.js\":\"7676c584fb825ff5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewport.js\":\"52b1411b6cc87edf\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/webLock.js\":\"709cbc3b434e95b7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceRecovery.js\":\"591b1740a573954a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceSnapshotStore.js\":\"9c4625c90ec0ee9b\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-compiler-runtime.js\":\"bb027d2a6fd13c2c\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-client.js\":\"d52dcd37ae953da1\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server-edge.js\":\"2b69561196ebd27f\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server.js\":\"3248b983fc3f6ab1\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static-edge.js\":\"6d413be461536082\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static.js\":\"03f6505ed8e6fce7\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-test-utils.js\":\"e25c6ace9b3e6560\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom.js\":\"5c4e35a93575e8f8\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-runtime.js\":\"ca71d2bd1fd897ad\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react.js\":\"1f835d5a4668058c\",\"/knowledge-medium/pr-preview/pr-1854/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
