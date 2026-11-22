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
		buildId: "9bdda951e93a-38064b2f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/\":\"f40a2b9928d15b86\",\"/knowledge-medium/pr-preview/pr-1854/index.html\":\"f40a2b9928d15b86\",\"/knowledge-medium/pr-preview/pr-1854/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1854/assets/FacadeVFS-CgyFc0Or.js\":\"f7107b3c2f669b35\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSCoopSyncVFS-DpzJl27D.js\":\"4eebe9f25a48ab79\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSWriteAheadVFS-DlGdIEBC.js\":\"7286765a34b08730\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-Bskxs-KJ.js\":\"76879e9c640f248f\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-D6RHqS6G.js\":\"fa520a03ccd3efd9\",\"/knowledge-medium/pr-preview/pr-1854/assets/worker-C1WrjI8d.js\":\"194e79e7a5aed343\",\"/knowledge-medium/pr-preview/pr-1854/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1854/chunks/app-C6Jw2KqI.js\":\"054e10e91ba6a1a2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1854/index.js\":\"350459cd95a9775d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1854/assets/AccessHandlePoolVFS-BIZVIYHj.js\":\"17f189cb83277d1a\",\"/knowledge-medium/pr-preview/pr-1854/assets/IDBBatchAtomicVFS-DJ5yp1vN.js\":\"6b5f5e2d91dc8f44\",\"/knowledge-medium/pr-preview/pr-1854/assets/MemoryVFS-DXct_1M1.js\":\"feb5dd2246f4ee28\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-DD5iVoiM.js\":\"5dc2477c8b15c381\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-7pYGBX1v.js\":\"d1424086317a28af\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1854/chunks/AccessHandlePoolVFS-DwHx2Iq0.js\":\"30bfdbd459309430\",\"/knowledge-medium/pr-preview/pr-1854/chunks/FacadeVFS-Dc6L24kV.js\":\"ba87ae7862354ed1\",\"/knowledge-medium/pr-preview/pr-1854/chunks/IDBBatchAtomicVFS-DZE9Y-IC.js\":\"6ef36860a3e31896\",\"/knowledge-medium/pr-preview/pr-1854/chunks/MemoryVFS-CitkkgJX.js\":\"5cf523eafd712f66\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSCoopSyncVFS-DNpAkbak.js\":\"9b6dcc654cfaa506\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSWriteAheadVFS-D91YLsGd.js\":\"d13a6c6e121bf59b\",\"/knowledge-medium/pr-preview/pr-1854/chunks/Preview-BG2WhC9B.js\":\"786c468befbbf6a8\",\"/knowledge-medium/pr-preview/pr-1854/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/card-D2F_LLTU.js\":\"e2aa866d0285b863\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-BGiHbBoF.js\":\"ccdbe6cc62d284fb\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1854/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-async-B_gUl_26.js\":\"8344e870a30a45b2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-lGjJtpDF.js\":\"58bd26143f3f1728\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-B4yFkPXC.js\":\"22321b09be801827\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-BJeAD1Tv.js\":\"1572cfb05506f7ea\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-Bkp25-Zn.js\":\"de45b497b5adaac7\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CP78qMGx.js\":\"dfc9ef4b1d3f3956\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CZuKEMb7.js\":\"abbdd1691dc2800a\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CmOV0dC1.js\":\"8880d1debc3d5eac\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DXFYwPqr.js\":\"391f9491ed96f109\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server-legacy.browser.production-ke3OlGxN.js\":\"69019494d1c4ddd4\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.browser.production-DwbCgnKf.js\":\"87c4f8612f01252e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.edge.production-vOW0y42H.js\":\"b5cdf3155a6b4765\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-e4GLMBoJ.js\":\"56be0f5165af1c14\",\"/knowledge-medium/pr-preview/pr-1854/chunks/server.browser-CFUhwFNw.js\":\"61a39c1bc983997b\",\"/knowledge-medium/pr-preview/pr-1854/chunks/textarea-Dhn2WMz5.js\":\"e8277722e8844878\",\"/knowledge-medium/pr-preview/pr-1854/chunks/ui-IRlcyjf-.js\":\"03e70d66dc01a485\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-D1cMDcN9.js\":\"8eb29dd69d737fcf\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-async-CW024GuI.js\":\"7811e05034a45856\",\"/knowledge-medium/pr-preview/pr-1854/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1854/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/src/App.js\":\"dd33b6f31d7e33fd\",\"/knowledge-medium/pr-preview/pr-1854/src/appUpdate.js\":\"45dabeee0ae7b853\",\"/knowledge-medium/pr-preview/pr-1854/src/appVersion.js\":\"1bbe585c08fb4df5\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/initialLayout.js\":\"2c37382061ae7675\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/openWorkspaceData.js\":\"f9981295e3c28408\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/resolveWorkspace.js\":\"a698e339d9e48dd1\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/workspaceBootstrap.js\":\"ac0410cc69ca573b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockComponent.js\":\"462b1fd676bdbf5b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockCrumbs.js\":\"b17b4a34f07ce07c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockEditor.js\":\"470efacd3f233d2e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockLoadingPlaceholder.js\":\"93506fdc9c70f912\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockProperties.js\":\"6c3557c231da8f35\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockSearchPicker.js\":\"4a0613d0e4f66a6a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ConfirmBulkDeleteDialog.js\":\"4542936ad82c395a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DividerHandle.js\":\"24c4ebc79ddb5f9d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DraftEditor.js\":\"ffc5baf3be4244c9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/GutterPill.js\":\"eaa46918cc10a21f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Header.js\":\"23d2ebe55aac4ed4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/LazyBlockComponent.js\":\"ee74737ed2829564\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Login.js\":\"5156cbdc72dfdb81\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ZoomableSurface.js\":\"8d988bc2ea63de27\",\"/knowledge-medium/pr-preview/pr-1854/src/components/editModeKeepalive.js\":\"8323ca5a657e40e3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyDisplay/PropertyDisplayScope.js\":\"638f940b1ac7c100\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a78ad433398de614\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefPropertyEditor.js\":\"3e88a3935fe6ac84\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefTargetTypePicker.js\":\"c5ed8f33a9f6850a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/SelectPropertyEditor.js\":\"754dd9a71077ba27\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/TypesPropertyEditor.js\":\"c55c28ce90683322\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/defaults.js\":\"bb40f90f1742edb5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/kernelValuePresets.js\":\"a2b879e589b64e79\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/selectablePresets.js\":\"ccf45aa666cc7e66\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/typesPropertyUi.js\":\"0af7a422ed720f1d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/AddPropertyForm.js\":\"78e277b3f1f2cffe\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyPicker.js\":\"13933da3155710a1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyRow.js\":\"5c4939ee97f27e78\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/Rows.js\":\"1fbd3a613311a682\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/actions.js\":\"916641e546c48c0b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/declarationOnly.js\":\"9479a0223b25549d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/layout.js\":\"682c8b04808557aa\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/model.js\":\"56f463e7b4f8fd25\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapeUi.js\":\"4e1f212414d1d855\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapes.js\":\"5cd1666a2034b193\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b9e4ca526d4eb778\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/visibility.js\":\"b108895f2bc30759\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanelSections.js\":\"f1743514c8efcec9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockEmbed.js\":\"f108eb8d4a068080\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockLink.js\":\"9d9790f8e055c36a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockRef.js\":\"6a70d819232ac33e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/ReferenceLink.js\":\"396592011d3908a5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuard.js\":\"2afd68a7bf83152a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuardContext.js\":\"5a46a10757e3e969\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/linkInteraction.js\":\"8a6b78cf1af41855\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/referenceLayout.js\":\"17e6149ead2c3bd9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/useBlockRefAncestors.js\":\"c3fbc6b62e0538e2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockGutter.js\":\"96485310bddadf0a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockInfoDialog.js\":\"651dbbf269f1905b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockTypeBlockRenderer.js\":\"84d5724808acf799\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BulletHoverCard.js\":\"77555c6db86118ef\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorContentRenderer.js\":\"60a53af227137f79\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0f55aca842ffabfd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ColumnResizeHandles.js\":\"370c21b03ec1aaa3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"aee060bc547ac03f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/DefaultBlockRenderer.js\":\"2b73a98ad7292fb9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/LayoutRenderer.js\":\"a6633e816800daa6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MarkdownContentRenderer.js\":\"0e9b324fd312e26f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MissingDataRenderer.js\":\"62c2a34dd377fcb8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PanelRenderer.js\":\"dacfb4fd1aff98d9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PropertySchemaBlockRenderer.js\":\"bbd7446448c71499\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/TopLevelRenderer.js\":\"d7213640d4a8fa29\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockGutterMode.js\":\"c6044cd0fabec796\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockTitleText.js\":\"5cf3913cda90b6af\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/fieldCreationKeydown.js\":\"90daba878d7c4300\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/layoutRootContext.js\":\"929f78578eb8ce4c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/TypeChip.js\":\"e263bc0f6a6febb3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/chipStyle.js\":\"2cd95e52be11d5fe\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/anchored-floating.js\":\"3607e22123c185cf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/button.js\":\"85978927d06055bb\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/card.js\":\"26e1ac4384871d06\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/checkbox.js\":\"2d3af487f2a19a14\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/collapsible.js\":\"d211137fb67494f0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/command.js\":\"e204226b1ac6f2a4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/context-menu.js\":\"b702e0a64967c51a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dialog.js\":\"eed9e2e11948c6ec\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dropdown-menu.js\":\"aedc6a34c0f798e9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/floating-listbox.js\":\"edd108a21ae97ad4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/index.js\":\"426480e76383abe4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/input.js\":\"3a18ae0cff14d34b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/kbd.js\":\"75cba9610b8536fa\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/label.js\":\"422e62d094ad8c90\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/textarea.js\":\"776acaabca9f5f02\",\"/knowledge-medium/pr-preview/pr-1854/src/components/useEditModeYieldKeepalive.js\":\"abf3ae3888f34b5d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/BootFallback.js\":\"11b090db866db3f0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/FocusedRowLazyMount.js\":\"10600191e552e0a7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LazyViewportMount.js\":\"812fdb1b02b0c75f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LocalDbCorruptionFallback.js\":\"3bcd751562c90f07\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/error.js\":\"31140f03d4a61178\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/lazyMountRegistry.js\":\"6d625691f72254a6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/suspense.js\":\"27ec37bf220c65a6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/CreateWorkspaceDialog.js\":\"b386fc047ffab0ae\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/PendingInvitations.js\":\"d07d50fd99f17b54\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/SyncProgress.js\":\"ad653b2f241f1ec7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/UnlockProgress.js\":\"bba5d36746fdd121\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceKeyGate.js\":\"c1baf6348348316f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSettingsDialog.js\":\"6033b2c77fd8ef0c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSwitcher.js\":\"f30fee6114db00ea\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSyncGate.js\":\"536ce6fe9d00e9d3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlow.js\":\"79fee9ade2101b5e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlowHost.js\":\"ef5b2b8a3d37a2fe\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/EncryptionSection.js\":\"12ae718401c01016\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/attachmentPrompts.js\":\"c117a44ee0a2401c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0c9b083c1b15a5bc\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowDeps.js\":\"fec96ec5db5200a7\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowStore.js\":\"36a69c96c1f6c343\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/flowUi.js\":\"8c90837d9c97d83b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/useConversionRun.js\":\"0784bf70ff673fd2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/keyUi.js\":\"bb92e3f734ba7bcd\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnKeyLoss.js\":\"ba2ebb480d1ab6d5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnServerE2ee.js\":\"959d004cf4e71cfa\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/workspaceUnlocked.js\":\"8ddec5c1aa659ecb\",\"/knowledge-medium/pr-preview/pr-1854/src/context/backgroundSubtree.js\":\"07efe4d2e21f955c\",\"/knowledge-medium/pr-preview/pr-1854/src/context/block.js\":\"995a3ef920482802\",\"/knowledge-medium/pr-preview/pr-1854/src/context/layoutWsContext.js\":\"1b0f8929ca3240d1\",\"/knowledge-medium/pr-preview/pr-1854/src/context/propertyDisplay.js\":\"7e8c8fdafb49ed88\",\"/knowledge-medium/pr-preview/pr-1854/src/context/repo.js\":\"cf718b4f65f38307\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasClaim.js\":\"cd6f50e5e5244b0a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasSeatNamespace.js\":\"970eb654b1c066b8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockData.js\":\"35d2ce29a3f6f4f1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockType.js\":\"46e7c96a8d11ec46\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/changeScope.js\":\"42cbcc70d06e3a14\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/codecs.js\":\"5b4fa32d125c33bd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/derivedData.js\":\"5e805d70f4c5c91a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/errors.js\":\"d39a1bd2a39112ce\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/events.js\":\"e7b87725fd8f546c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/handle.js\":\"21b8a361c6cae9f4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/index.js\":\"0c32e9350d20591a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/mutator.js\":\"646c74569d72931b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/processor.js\":\"cdd97d59316d7863\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/propertySchema.js\":\"5509d0ee167d85e2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/query.js\":\"6a8fbc15fe2f29d9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/sameTxProcessor.js\":\"62cb129acd29a942\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/schema.js\":\"21b8a361c6cae9f4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/tx.js\":\"21b8a361c6cae9f4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/typedBlockQuery.js\":\"cb8ab2249f2ca4e1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/user.js\":\"76f1fd311004aa36\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresetCore.js\":\"7d0ba0328c291099\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresets.js\":\"2b8ad78891d21cd7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/attachmentCleanerIOVerb.js\":\"1218777318f94ac8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/block.js\":\"8221f6382b62fb98\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockCache.js\":\"b4f29741e15f126a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockId.js\":\"03d18db09e6df802\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockLiveness.js\":\"b5d7039ba7562d1e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockMerge.js\":\"a883263a5b1fd590\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockSchema.js\":\"113d391f2f77ffae\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypeLookup.js\":\"43397be674b134c0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypes.js\":\"e9a67f5b32f4c1aa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/clientContext.js\":\"74a0dda656571414\",\"/knowledge-medium/pr-preview/pr-1854/src/data/dbFileSiblings.js\":\"81997359bfc2ec9c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/definitionSeeds.js\":\"b3ef48d4db27f4d5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/derivedIds.js\":\"225bfca186acdbc7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/drawnSubtree.js\":\"5270900f0c35233d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facetBridge.js\":\"5115175891644712\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facets.js\":\"f46a3a0c8dac1fda\",\"/knowledge-medium/pr-preview/pr-1854/src/data/globalState.js\":\"388cdbd651625a7f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/aliasClaimRederiveProcessor.js\":\"879490f0e4ff345b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/ancestorBatch.js\":\"29dfd7faa8c8033f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/blockTypeTypeifyProcessor.js\":\"35011853ff8c888f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/clientSchema.js\":\"aab31b6402c940ef\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/commitPipeline.js\":\"8b2808af53c3df33\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/devAssertions.js\":\"fdd4dd33cee8b62c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/firstSync.js\":\"eeefb30650372c19\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/freshInitialLoad.js\":\"fcf4350ac1b7e89d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/graphBackfillClaim.js\":\"9687f21b1f175f3c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/handleStore.js\":\"afd45f9d9a565f1a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/idleMarkerJobs.js\":\"12c879bf87df7331\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initialDownload.js\":\"75279194f0533b5a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initializeClientDatabase.js\":\"1a047b4ca81228d8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/jsonCanonical.js\":\"37173ed6cbc90a2f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelInvalidation.js\":\"932f2e12342a670b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelProcessors.js\":\"d4a09c4d8d5fb297\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelQueries.js\":\"42a5e663b3c1683a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/mergeTypeMembershipProcessor.js\":\"21bde2a6ba8bbf56\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/normalizeReferencesProcessor.js\":\"a5def291ddd763b9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/poolInstrumentation.js\":\"fecaedd6b13708c4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/processorRunner.js\":\"3b5d46a2bd38c57a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyCellBackfill.js\":\"31318d0b74c80073\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildMint.js\":\"9becf0ecc93c0a2b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildrenProcessor.js\":\"e112ec76b59089e5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e825424d1bc945a6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionSynthesis.js\":\"4fb8a0889be7eacc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyKeyScan.js\":\"32e4c67391358be9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertySchemaResolution.js\":\"c11f08772e1cb73b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyValueEdits.js\":\"b9adb27648ec9583\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/raiseProtocol.js\":\"d81fd8102720ffb9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/readBatch.js\":\"16583234ef33f91b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/refProjection.js\":\"e4a6a10cda3e9d90\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetLookups.js\":\"b6ca2158179eeebc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetProcessor.js\":\"8caf1fd161d39628\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/replayMerge.js\":\"58e44de93b45b297\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/sqlBinds.js\":\"a4401f8f34c53ca3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e7e039aa7e6e26b1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/arrivalProcessors.js\":\"3e26102bd677b0eb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/invalidate.js\":\"c82919bfbb2a5459\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/materialize.js\":\"1f28157aabbe7385\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/observer.js\":\"9cdae85f6c7c59f7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/reconcile.js\":\"29e682c18c91ab54\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/timingMetrics.js\":\"ecf506164bd30bf6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/treeQueries.js\":\"e1221d0395f30883\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txEngine.js\":\"5e40f29da5b16e69\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txSnapshots.js\":\"478bf5254c4cc700\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/typedBlockQuery.js\":\"1d4e0d005597e345\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/undoManager.js\":\"87adbb5c5a0d2b97\",\"/knowledge-medium/pr-preview/pr-1854/src/data/invalidation.js\":\"47d129065ad77a09\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelDataExtension.js\":\"5500b96ea06210fb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelPage.js\":\"a3ce6c7c8fa10b6a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelValuePresetCores.js\":\"588b14f81e4fe61b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbCorruptionSignal.js\":\"e66a5b1452f65040\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbStorage.js\":\"7fe56a78edebe91d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbVfs.js\":\"51689896e9d8f8c4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localSchema.js\":\"6ead2a6bba794d31\",\"/knowledge-medium/pr-preview/pr-1854/src/data/maintenance.js\":\"ff91f2a4f39aab77\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mergeProperties.js\":\"8d40a263fb5788cb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/metricsConsoleHook.js\":\"684600842ee05ed5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/migrationsPage.js\":\"0b64a4046f45236d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mutators.js\":\"f262f47cf254c71d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKey.js\":\"e1facdc5a29b038b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKeyPlacement.js\":\"5d7a79cfbf7e34ec\",\"/knowledge-medium/pr-preview/pr-1854/src/data/outlineSurface.js\":\"178c654b1d16eaf5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingEditorContent.js\":\"b8ce224cde30ff55\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingUploadsSql.js\":\"10c064d8f513d394\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pluginStateExtensions.js\":\"71fcd1472cac7b83\",\"/knowledge-medium/pr-preview/pr-1854/src/data/powerSyncLogger.js\":\"03da838a4127d38b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/projectorRuntime.js\":\"633e92b9ed8a9ce5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/properties.js\":\"09b9aa21ff8d7769\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertiesPage.js\":\"76f7bc39b9690453\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyChildren.js\":\"f9afe33d4c1acc50\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionFanout.js\":\"ca369efce35955f2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionMetadata.js\":\"917bd180c3a53807\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionRegistry.js\":\"bd296f01e2c1a3d9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDisplayMode.js\":\"bec4ed5ca78b9f86\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyRowCreation.js\":\"9a6a3008ec5bc92e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySchemaCreation.js\":\"03d393d05e5c2e86\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySeeds.js\":\"2c23947c4f3d5d44\",\"/knowledge-medium/pr-preview/pr-1854/src/data/recentsPage.js\":\"0f5a2e401be1d91a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/referenceBlock.js\":\"bc1a459038551313\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rejectedUploads.js\":\"201331e3ff98f086\",\"/knowledge-medium/pr-preview/pr-1854/src/data/releasePowerSyncConnection.js\":\"e59fec9ed33ee9d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repo.js\":\"f2b0a6d6a3734661\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repoProvider.js\":\"860acd07ec4b15d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rowProperty.js\":\"4f1e58d31321f9b1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/searchFilter.js\":\"ec0fc345bcc11e32\",\"/knowledge-medium/pr-preview/pr-1854/src/data/seedIdentityLedger.js\":\"8cf5526a7ad39eb9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/stateBlocks.js\":\"dfcfd832e41e4b35\",\"/knowledge-medium/pr-preview/pr-1854/src/data/structuralEditPolicy.js\":\"c7c5abfb2a398614\",\"/knowledge-medium/pr-preview/pr-1854/src/data/subtreeDelete.js\":\"94785d69f47df1de\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncStreamLock.js\":\"0c5cb12aebfa6674\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableSqlRecognizer.js\":\"48d046f9a533dfc8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableWriteGuard.js\":\"da22e31d3c461aa1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/targets.js\":\"b32e6796bacc59f3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeColors.js\":\"644c5e80300a6927\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionMetadata.js\":\"32d2e9909e21b8fd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionRegistry.js\":\"17c4d16f7473af7f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeExtraction.js\":\"15c15e47f2a3b1d6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeInitialValues.js\":\"9def70d6c5d5627c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typePropertyGroups.js\":\"7b014e338c5b6d98\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeSeeds.js\":\"bad6d1c1704464f5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeTagger.js\":\"2defc39a12abe379\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typedRecords.js\":\"309efb29e930cf21\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typesPage.js\":\"ed7bba6441be2f3d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userPrefs.js\":\"ed4def2af28ad639\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userSchemasService.js\":\"f77eb1a0ceab6fb1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userTypesService.js\":\"43f0942f5e42be19\",\"/knowledge-medium/pr-preview/pr-1854/src/data/valuePresetRegistry.js\":\"963478b8720094b6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/visibleChildren.js\":\"f62b41cdd238499d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceConversion.js\":\"21b89bfb86110ab6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceFirstSync.js\":\"e8269a6e7b6cf138\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceIdNamespace.js\":\"0cda8437e205a084\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceSchema.js\":\"9b102ccdb3801087\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaces.js\":\"b923b79f9aec894e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadLog.js\":\"3a585fdabd6b1615\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/BlockPasteShellDecorator.js\":\"577ddbcb802fca97\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/atTrigger.js\":\"ebf1dab43c28ecfd\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/autocomplete.js\":\"f4fd4b65362c522f\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/codeMirrorExtensions.js\":\"fe021f071616e397\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/contentFlush.js\":\"eb70dff57e70b06f\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/defaultInteractions.js\":\"a77d7fb5b5d036b4\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/editSettleSignal.js\":\"026b87e0504625e3\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/insertImage.js\":\"6d3af94fa1090940\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceCompletionRange.js\":\"8981e1b6bb4fd05c\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceTargetTypes.js\":\"2782972faef009f0\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/syntaxContext.js\":\"b8ae2105aef3c5fe\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/triggerMatch.js\":\"c97d1583ec5b5293\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/AppRuntimeProvider.js\":\"cafd2b6a5a9fabaa\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/BlockFocusShellDecorator.js\":\"adc26220377aeb4f\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/ExtensionRenderBoundary.js\":\"445118f540860e28\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/PanelContentRecovery.js\":\"aa575110657925ce\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/apiCatalog.js\":\"3201c2a37f0cf28e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/approveExtensionHere.js\":\"379e015540f57e47\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/armedCutAppMount.js\":\"e5feef7659944337\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/batchableKeyedStore.js\":\"dc176c43aefcbc2d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockInteraction.js\":\"49542bd50a442954\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockSelectionAction.js\":\"fc2032337dd10170\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compileExtensionModule.js\":\"a292158832fddcf3\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compiledModuleCache.js\":\"6ba0affc6c28cb97\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/continuousGestures.js\":\"f084e4350ecac8aa\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/core.js\":\"6baab77008ff2349\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/defaultRenderers.js\":\"d6f0f671fa73396c\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/definitionFanoutAppMount.js\":\"90f50df5666a95eb\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dialogAppMount.js\":\"607d7d47e51ee300\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensionSeeds.js\":\"f8634f25b86fd800\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensions.js\":\"c53269dc6f6da2cf\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/exampleExtensions.js\":\"a6ace096224cb778\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionApprovalStatus.js\":\"e05e3efc733ce6b5\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrorToast.js\":\"febe7d671055e211\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrors.js\":\"1cbe305b3c5ff53d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLookup.js\":\"e5f0e82c0902aa9d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionToggles.js\":\"d99ccb25cbd3e05f\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionUtilitiesCss.js\":\"5600a995d9db9a79\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/kernelPageDeletionGuard.js\":\"a5ae56c6ba627fb9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/liveRuntime.js\":\"79b78ecc99653287\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/openExtensionsSettings.js\":\"f12e66192eb67862\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/overridesCache.js\":\"cceef7a5441a5e37\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/pluginIds.js\":\"7734f846b9383a8c\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/processorRejectionToast.js\":\"c51acb996cec80db\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeActions.js\":\"d65c85b36e085e11\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeContext.js\":\"b51242c33790bace\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticAppExtensions.js\":\"4d63dd8dc591f9a0\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticDataExtensions.js\":\"86b2c9ed0c79e6d2\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/toastAppMount.js\":\"3777bc512a5e1aba\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useOverrides.js\":\"9b591526c6577446\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useShortcutSurfaceActivations.js\":\"efb38ddaea4eec4f\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/discoverToggleTree.js\":\"073c2aaa05838430\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/facet.js\":\"72fa81f62cf320f8\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/resolveAppRuntime.js\":\"c7af5634ef69c8b9\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/runtimeEvents.js\":\"8a5819ff19d8033d\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/togglable.js\":\"c8a762037ec8ee8e\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/variantFacet.js\":\"6715b26860fb8921\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/verbFacet.js\":\"821086613cf7cb8f\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/block.js\":\"f35207ebcae8b44d\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/focusedChild.js\":\"7d26d461119d5ad7\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/propertySchemas.js\":\"128171b4ca95ab1d\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/typeRegistry.js\":\"634a1b04daefa8b6\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAncestorCrumbs.js\":\"8ab16e81084a3e11\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAutocompleteListbox.js\":\"20aec037aec2ab55\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedSearch.js\":\"56f40aea3f218baf\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedValue.js\":\"23d2b0799c2d7fa1\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsFocalRender.js\":\"6aa28895caee970d\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsReadOnly.js\":\"12e2abb57ecd5393\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMaterializeBacklog.js\":\"215aafb5ade7eaa8\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMinuteClock.js\":\"4a91b47f5a7bf7ff\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePanelLayoutProjection.js\":\"b764d7aa7eb45fdf\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePendingInvitations.js\":\"a0810caf32646472\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRendererRegistry.js\":\"58d8b49bbc07248f\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRetainedFieldRows.js\":\"63deafecaadaf4b4\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useWorkspaces.js\":\"8204360a91853da8\",\"/knowledge-medium/pr-preview/pr-1854/src/lib/utils.js\":\"ce7c66c60f682050\",\"/knowledge-medium/pr-preview/pr-1854/src/main.js\":\"170f211399db4f06\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/MarkdownImage.js\":\"0bdf3890a4ffbf51\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/blockSeparators.js\":\"62943cf452908768\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/context.js\":\"2ca5dc42ece1a889\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/defaultMarkdownExtension.js\":\"34b3bfcfdf58b5ae\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/extensions.js\":\"9b5250451440c47a\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/renderMarkdownHtml.js\":\"935ad60a1e5b2fe0\",\"/knowledge-medium/pr-preview/pr-1854/src/minimal-editor.js\":\"e872ae81bcad4a66\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/armedCut.js\":\"42659eb2a0555847\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/captureMediaVerb.js\":\"a9c8c2bb6c7ea372\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/clipboard.js\":\"755cff212b0dc57b\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/decision.js\":\"c29518d5ea176b72\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/operations.js\":\"4a2b4e72c4c22094\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/AccountHeaderItem.js\":\"3a1bdf628aed751c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/index.js\":\"0684eb908b17f545\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4beafd1b52bbeba7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askAgent.js\":\"d9ff1d680e1a6052\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askedStore.js\":\"fed7c68a1ab6d6f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"17fcb5cf00ab16f1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/chipState.js\":\"821f1afc217d91e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/dataExtension.js\":\"f79c08122eeb274f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/index.js\":\"71db5ceb85dbe530\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7cd7583f79c466c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/schema.js\":\"0a929513f340196e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ae83323da3958432\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/BridgePairingDialog.js\":\"773a8a8d8db15d63\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/addMedia.js\":\"07b12f3a1f53b60d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2d740dcd58cb807e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/block.js\":\"455b3c611b65d725\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/context.js\":\"3e052c16e11a9ac0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/displayIds.js\":\"6e7558deed42469f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/index.js\":\"23a4c15e63b8a745\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/outline.js\":\"aa0eff4b2493c6ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/properties.js\":\"55c188d168b0ba74\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/refs.js\":\"e8d1c026fcec82f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"80b69835784376f7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/search.js\":\"a0b50c01bf4c566a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/shared.js\":\"a1979fdd8d5e0617\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b11d676c9597eea5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/text.js\":\"b8d37b2dd6c3a17f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentWrites.js\":\"0a1ed5b17d16f49b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/authoringCatalog.js\":\"4bc31ad056fbbe81\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/blockRefTargets.js\":\"ea79ea52efd38d6c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridge.js\":\"f169e78be7942690\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridgeLoop.js\":\"b2ef0753019abb3f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/changeHistory.js\":\"cb83d4517e88193c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commands.js\":\"6267cb81b4a460e9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commentsCommands.js\":\"6b9516c62c4c3e39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataExtension.js\":\"d4ee433c05f98b9d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataModelGuide.js\":\"38b0a4d74b622349\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/describeRuntime.js\":\"2abc41b34d0bcf1b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/extensionLint.js\":\"bf093037450628ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/grainAudit.js\":\"0be017a814c996d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/healthCommand.js\":\"cfbf9447eb872941\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/index.js\":\"1ecc0ea7619fc06d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/presetIdentity.js\":\"b4816d387e96096c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"61f8152d999334a0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/readMedia.js\":\"2b6c876a2d4db93d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/schema.js\":\"32cbe6b84d731e27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/serialization.js\":\"500423cc286cd219\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/targets.js\":\"2a4c8c1f70e08774\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/tokens.js\":\"eb13021399f1ca38\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/watchEvents.js\":\"100cdb165e02f4b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/workspaceGuard.js\":\"840de517d271e5f0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/writeCommands.js\":\"2cacebeef3d44e0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/AliasCollisionToast.js\":\"b1e9be6b5f883087\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/DuplicateNameBanner.js\":\"721c8776403155a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/collisionMerge.js\":\"e6e957ad02583810\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/dataExtension.js\":\"1968cde35015822c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/index.js\":\"67d0ee0fe16e9562\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/mergeCollisionAction.js\":\"c491bb065cad0ef7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/pageStyling.js\":\"49c1e7b4cf9261be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/rejectionToast.js\":\"b2151d9aeb97b739\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/syncProcessor.js\":\"f34dae37f7d02603\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/actions.js\":\"3aa2ddfbbaaa9d3e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/addComment.js\":\"6917288784265a84\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchor.js\":\"b73660af216df35c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchorState.js\":\"18c624efc1639d5d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/commentLinks.js\":\"5c5689375abc41b0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/confirmThreadDeletion.js\":\"e6a3109e35a51681\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/container.js\":\"4a346591d72e3d75\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/dataExtension.js\":\"21b6584b0d638572\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/deleteComment.js\":\"a900ae7e1f89ffb5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/highlights.js\":\"2d98bc190e092426\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/index.js\":\"0ddbe7a4383ea5c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/linkedCommentsPill.js\":\"78d3a8f87d7623ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/margin.js\":\"38dba6c121aee107\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/marginSchema.js\":\"71c8ec0596a70507\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/newComment.js\":\"121d0432fa4e126f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ownThreadPicker.js\":\"bae01620128ba9f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/placement.js\":\"1739a9a1c7435112\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/queries.js\":\"f0adc7aceb3daed6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotePosition.js\":\"246474d9059fa478\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedIn.js\":\"da919af75650642f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedRange.js\":\"680a7bf1838225ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/rangeRefs.js\":\"bd7f1ef8c82e17df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readHighlights.js\":\"f0e6d4a93f3ac0a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelection.js\":\"0d51e5ce30d3b6f3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelectionUi.js\":\"94bd00bb9c58b977\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/reanchor.js\":\"094715ee0f065752\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/schema.js\":\"938b2b7782faa65d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scope.js\":\"7f6b62a9192ae926\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scopeThreads.js\":\"b55aa87110113e84\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/splitRetarget.js\":\"da91ecd6b2f48e11\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestionCard.js\":\"3bd76563181d4ade\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestions.js\":\"57f1a0a089d593ec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaries.js\":\"06a32c8eaddca464\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaryBatch.js\":\"06a67717643500e9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/surface.js\":\"d776da2d04c6c6a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threadNavigation.js\":\"9762a4acd499d1a4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threads.js\":\"133c18954bd67df4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ui.js\":\"e53aec557f72822a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/uiStore.js\":\"8c49cec7dc83e7e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/appIntents.js\":\"2c0f797356afc34f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/index.js\":\"a6091d54d0aa0a9d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/index.js\":\"491f646810615a48\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/status.js\":\"eb6ef3a57669b030\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7e55a8cbb8288494\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaBlockRenderer.js\":\"dc9b365a9c1a8684\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4238fec4f6926d4b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaUploadReconciler.js\":\"c066672c026ef2dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetDownLane.js\":\"691639f1ff63186b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetResolver.js\":\"47b705c10e16ffc1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetUpload.js\":\"243b57df5d5463a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/attachmentCleanerIO.js\":\"30a88cc678799046\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/supabaseAuditIO.js\":\"170938b222e9440d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/blobStore.js\":\"dc50ead67c85f97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/byteStore.js\":\"a56a1bec63c19b3a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanerIO.js\":\"29f835f04d951dd2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanupAttachments.js\":\"6ff559b756fd66af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/dataExtension.js\":\"435677e3522782dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/downLane.js\":\"4522e6cf4faa0964\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/index.js\":\"d3bc65b1afbfb8ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/insertImageContribution.js\":\"eb410cf6f6e563cb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneArming.js\":\"6c9ccfbe0307ffc0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneLock.js\":\"a9b5a7610d71f75a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaBlock.js\":\"8edb1c277f745d16\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaCapture.js\":\"cf9219c27fb82834\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaLanes.js\":\"394b086855d23867\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewers.js\":\"67b3aaaef1b4335a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewersFacet.js\":\"29139fa81a039dfc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/pasteCapture.js\":\"45122eb7ca3609a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/resolver.js\":\"75de936bf9f5ddb8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/retryUploadsAction.js\":\"985d251cae14cd9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/storagePaths.js\":\"f58d7544e63748c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadDrain.js\":\"0edf6eb98101befa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadLaneStatus.js\":\"de0846ac0e9c2a6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadReconcile.js\":\"86f510596046e276\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadRecovery.js\":\"a04493e2d99fda6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadStore.js\":\"1939dd3d773b075f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/useAssetObjectUrl.js\":\"fc55d28e47fd9ce7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"35bca6e2d7d5295c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f7786d82d6d0713a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/facet.js\":\"483c539650a2378a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/index.js\":\"99b91cc7b80007f1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/prop.js\":\"399415aec8e3dfd4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinkFilters.js\":\"7a9fb794b7a6126d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"722ca13e3a1cbae9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BlockEntry.js\":\"38ea030dd6a32cb7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/LinkedReferences.js\":\"46bafeda2495d889\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3d1ff2f240847b90\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dailyNoteDefaults.js\":\"1f508b2c9ea907b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dataExtension.js\":\"fa65957ad9485eef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/edgeExclusions.js\":\"cdab3697a7c43aad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/filterProperty.js\":\"76af0ed25aed4ae1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/index.js\":\"c59cb4e91d09bc61\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"44b3bcc5b7b9ad8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/applies.js\":\"101b975b47e1f46c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/countQuery.js\":\"604ce7b31ebb5d95\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f0f8404981319fea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/index.js\":\"7de5d82c616f0f61\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fdf12f87f0731506\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/presentationInvalidation.js\":\"17c64291c7f6e6a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyEditorOverride.js\":\"c5156fd31062f754\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyFilter.js\":\"45a04157ef729af9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/query.js\":\"e1a266e7849d819e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/resolveFilter.js\":\"39263cc227807ab2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sourceBatch.js\":\"6d65a832259023c1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sources.js\":\"b19b35944c3737c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useBacklinks.js\":\"23e8a95cc7443dec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fe1d8c199e3fd19c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayCelebration.js\":\"099a2b3c9817db55\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayOverlay.js\":\"a2a5af88dc4051bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/gate.js\":\"09fa6addf783b9d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/index.js\":\"d2ced35f8ccda47c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/wolfTheme.js\":\"f978f25a44273e0b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/BlockDragLayer.js\":\"5572f09a755adc4b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dragController.js\":\"ce2763a3a8b0901d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dropTarget.js\":\"d8ea0cf16c55ce98\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/index.js\":\"aabcd0275cf75f68\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/projection.js\":\"fa0d1e6698019e71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/BlockMetaCard.js\":\"5778001a2babf08d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/index.js\":\"fedc0037439da055\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/AddTagDialog.js\":\"1394199f534c9b23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0376feff4584e518\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/TagNameIssueHint.js\":\"0211205e1cd64798\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/addTagAction.js\":\"da1da99729886afc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/appendTag.js\":\"cc193926d7057234\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/config.js\":\"9d5eebee441ed19f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/dataExtension.js\":\"5996a6da6c308a68\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/index.js\":\"36880fca0b5ad70a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/propertyEditorOverride.js\":\"9c721aee6c04c3cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbList.js\":\"462d946cfa6fda06\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"17bd740744b93804\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/Breadcrumbs.js\":\"cc15ebb07365f996\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d86b403cdd38803e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"33ea0c4fd11a6af9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/index.js\":\"d7b9cc1de0963e14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2e6d3a7eaec59677\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/CharacterCountItem.js\":\"a1eff9095b36abf1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/ProfilePropertyEditor.js\":\"80746bd101ff0bd2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/actions.js\":\"7b21a7cf49785635\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/blockType.js\":\"48f933ae96cfeabd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/charCount.js\":\"54ce6a8074f70dd8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/dataExtension.js\":\"7eccdb3eca077626\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/index.js\":\"4f317b2c3fa080cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/profiles.js\":\"4caad8ebb7138cf7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/properties.js\":\"3f270c7903c985db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/textCounts.js\":\"4153868967a71e0c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/colemak-keybindings/index.js\":\"d49c2e69859d55f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/CommandPalette.js\":\"584f387471b2f75a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/HeaderItem.js\":\"14014b395bee6fdc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/context.js\":\"acd39e2c18b87bf3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/index.js\":\"581af01bb99b4bf2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/selection.js\":\"084c4b316d76f880\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/toggleStore.js\":\"7caeb9d0c2800071\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/useCommandPaletteActions.js\":\"3fbdbff463f12cf6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/ContributorBadges.js\":\"eb506fb75b80e70b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/author.js\":\"aa55dc8e4639988c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/codeMirrorExtensions.js\":\"512c4b90b94f5e36\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/dataExtension.js\":\"419c49b341b1c706\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/index.js\":\"e0c3b1e89bbfecbb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/mentionAutocomplete.js\":\"20751895668b8318\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/processor.js\":\"6e9cb681f72c5f6b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/profiles.js\":\"06a1b635d2b70142\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/queries.js\":\"eb00f439736787ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/schema.js\":\"9f34badb0abc9b99\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f84bc782af47a5ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9e4e5e9add4134bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/index.js\":\"4312fe5d7008517f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b42fcc41c33de578\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f32270a8f86c17f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/CalendarGrid.js\":\"cdd9bad85e108e22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DailyNotePicker.js\":\"0eb304a3dd9b773b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8ed32b5d6d0bc801\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateNavDecorator.js\":\"b6ed9a5ead05c231\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateScrubOverlay.js\":\"2c325aeb907d243a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/HeaderItem.js\":\"ffca90fafa5fc0d3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/ReschedulePicker.js\":\"71eab67bb6e19d58\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8419848f17d66346\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/actions.js\":\"30295b0d0b967c62\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/blockDateAdapter.js\":\"d1b893625e5a2380\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/calendar.js\":\"7ab63da3daaec309\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dailyNotes.js\":\"853ca223ea37fb01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dataExtension.js\":\"f88ebc48255a4369\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubActions.js\":\"c9a612cc9c2e6cf6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGesture.js\":\"86fa354e4bc7e6f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a359ae1cc9b9536e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubRecognizer.js\":\"60921fddc487267c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/deletionGuard.js\":\"0f680648db3480f3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dueQuery.js\":\"f1b2a522389fbdf3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/index.js\":\"8a6b95deaf1cdab5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/landing.js\":\"e1f3fd3034cdcf57\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/localSchema.js\":\"c07c729ba6b8219e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/referenceDateAdapter.js\":\"cb4351d360950efb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/rescheduleAction.js\":\"9b640be17a07412e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/schema.js\":\"af88c6fab94b5bcb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadBlockDates.js\":\"939d4c40dbb0b585\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadDatesAction.js\":\"9790840de9611602\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/today.js\":\"b73077cf19c3a285\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ba1f3b57e139811f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ca11f0db40845489\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/audit.js\":\"4f9e09d6f8f65f36\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditAction.js\":\"6f0bfefa9c21b49c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditRanges.js\":\"40bc07896984e9c7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/diagnosticsSource.js\":\"98149dcf2224c0f9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/divergenceScan.js\":\"db7e91aeccbca899\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/index.js\":\"c6663b26d23fb457\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/propertyChildrenChecks.js\":\"05be439bd6f7553d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/referencesMirror.js\":\"cc0ddcb9edfb0b64\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/rowJson.js\":\"5f8b58e8b3e00375\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/schedule.js\":\"5da29f12375ffdbe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/store.js\":\"a694487144755a40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/action.js\":\"7f8dffffe555280a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/index.js\":\"60cf6b0f2c0822aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/plugin.js\":\"21d578c4a8923eb2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"7d04dc66adbddc39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/actions.js\":\"17257f02debc5c9c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/changeMarker.js\":\"7767baf4237c1ca3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/diagnostics.js\":\"4f5213868b5822a1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/fileSystemAccess.js\":\"36ed2c36c36f8f36\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/filenames.js\":\"b8d7d5fcbb60e9f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/index.js\":\"407447d988c07719\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/mirror.js\":\"93c1e8fe1bcb42dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runLock.js\":\"cdfac473000aaccd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runtimeHealth.js\":\"96633b171cd09334\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/schedule.js\":\"38d8afd07a802321\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/store.js\":\"68da133e389eb1b0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/index.js\":\"df532f337984604a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/themes.js\":\"4ff29da65e801333\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/facet.js\":\"4790719933fd937c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/useDiagnostics.js\":\"5e7c77b40a549838\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/dismissals.js\":\"a4ef93fb6b12d76b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/index.js\":\"f8400b084c9218eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/status.js\":\"85b4fceb18a1fe5f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/store.js\":\"2fa0179855306223\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"703da869bd381d20\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsSettings.js\":\"030df441433babe0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/actions.js\":\"9a88857bf62ee011\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/config.js\":\"dadf2e9dbae21b8a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/dataExtension.js\":\"68ce4bf3932c3540\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/effect.js\":\"985dd25a20bd43dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/index.js\":\"270ad924520bbe01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/propertyEditorOverride.js\":\"adf236b3ad78c892\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/useToggleTree.js\":\"b17fd013f87bcaca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/ExtractTypeDialog.js\":\"9f02f00837f14965\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5596b1e7a54fdd25\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/PropertyShapePicker.js\":\"45c5f0fc0aa8e2bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/action.js\":\"9d66a07a3f7bf709\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/index.js\":\"5c37621cf15f7519\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/FindReplaceDialog.js\":\"234aeb635c84615e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/HeaderItem.js\":\"926af4449adcc492\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/dataExtension.js\":\"d9aefcfa5d48f7f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/index.js\":\"9bed952a39b50eb2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/search.js\":\"21282a81dfa6baf2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/toggleStore.js\":\"115f703c6293130e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/LocationPropertyEditor.js\":\"02955d3163a0a987\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/MapView.js\":\"5c24f070b2faabbe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/blockTypes.js\":\"1d3e07ae2e7fa1da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/codeMirrorExtensions.js\":\"2633848ad44db14d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/createOrFindPlace.js\":\"0089b6bfb31b4812\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/currentLocation.js\":\"67c42b03236e8287\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/dataExtension.js\":\"0eb45f58667a7ad1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/geoContentDecorator.js\":\"5227135f8d3f6dc1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/googlePlacesClient.js\":\"7419fbfab1e46b0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/index.js\":\"6bf420b4cdc1a499\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/locationsPage.js\":\"15fd052a5c12e7b7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/mapViewport.js\":\"1858af3db1346295\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/pickCurrentLocation.js\":\"4d67de3cb547f38b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeAutocomplete.js\":\"58dfc6415557e2a9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeNameCollision.js\":\"8f1fa478dc56f3ed\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/properties.js\":\"99fd0006914d8469\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/propertyEditorOverrides.js\":\"fe80921e76709b05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/query.js\":\"37672e3829c923e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/usePlaceSearch.js\":\"b7aea8fe54f9dc96\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"da2afcdfa1f2d9dd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4ab75aead926d20c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"358169d9e95a47f7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/config.js\":\"7a54381cbfccb0b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/dataExtension.js\":\"57afda957eedcae7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/facet.js\":\"80827a3bd83b7ff5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/grouping.js\":\"85819aec73b20efc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/index.js\":\"042f46ecb37806e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2971413179ff4d45\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/query.js\":\"de6d2dff392756fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/resolveConfig.js\":\"3152f78cbdec9684\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5e12509b68c0110c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6ad8316f77e36180\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlDocumentContent.js\":\"fbe1cf5b33f5be35\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlFrame.js\":\"6a9c4ab32c62e327\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/actions.js\":\"da9640c829ce0533\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/blockType.js\":\"9137bd195850448c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/confirmRunScripts.js\":\"11597ff6abaa2d8d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/dataExtension.js\":\"5c57c094f1aada52\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameAnnotations.js\":\"4cd3914f2c7bf90a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameDocument.js\":\"fd86b0338789e531\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameTheme.js\":\"a29fc6bd844e1637\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/index.js\":\"c575a29013c72fdb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/scriptConsent.js\":\"4bdca28f9feea82a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/sourceMap.js\":\"ed293206f10d882b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/useDocumentScripts.js\":\"0bbd8b354a446663\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/index.js\":\"4e9eb00523c01310\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/record.js\":\"76970d0a9df25d05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/recordStore.js\":\"917d070496d5edb6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/responsiveness.js\":\"21078a8e45024282\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/schedule.js\":\"051379828391ca71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/sessionContext.js\":\"217330c03cc2a78b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9721dc820f52459a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7b560677d0ac46da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/actions.js\":\"8dda614454c025b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/config.js\":\"0dc5a1117c5de108\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/dataExtension.js\":\"64ccc123873d86ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/effect.js\":\"194fefaf2772b373\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/index.js\":\"f93d5011c6225aee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/keyCapture.js\":\"bb059a14a32b83ad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/overrideStore.js\":\"7f704a5d686b469e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"aec3e89dc27a330b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/HeaderItem.js\":\"72102738aae4d19f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/LeftSidebar.js\":\"b795fe732aea3288\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/actions.js\":\"ed25701335b320e4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/facet.js\":\"a5bb58c2dd3e4d27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/index.js\":\"790efeac86a5aff4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/shortcuts.js\":\"fede86a5c2c7d91c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/toggleStore.js\":\"a272cbabc8c0d893\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/MergePicker.js\":\"de8c54f526abf9e7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/index.js\":\"17a0e69d9085ee5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/mergeAction.js\":\"92f9db890a5ac03e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/strategy.js\":\"994a15ff2066d4d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/Button.js\":\"c1e89e67d2b1ff0e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5ab9777ad7b58916\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8191ea9c0f83e50b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/facet.js\":\"f4a35a782513865a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/index.js\":\"d18e0154b2a1b7c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6a503a6ab3a53051\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4667647c80c7269d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ed5da4ba106ef42c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9f0907c246e83a83\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/index.js\":\"bd597f88c94ef19f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9c97a4c488aa0491\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dd4f1f6b602468ff\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/contextMenuItem.js\":\"1cd74f4103c4099f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/index.js\":\"d274d3c33a86bb78\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveAction.js\":\"9a6a0215f9fdf3bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveBlocks.js\":\"78657841cf7ae268\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/selectionAfterMove.js\":\"b3b329e5b9d50391\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/TutorialBanner.js\":\"6778c4305396b92a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/action.js\":\"f808dc32fc640c90\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/bannerDismissal.js\":\"77d2516bfcabd295\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/documents/cheatSheet.js\":\"9c790394486e3796\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/index.js\":\"6fbfd0df2f205400\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/keys.js\":\"f9620ecbdae21c2d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/landing.js\":\"651dc9f3b0acdf58\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/outline.js\":\"05b4e08d1ce19dab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/seed.js\":\"cf9239118b6579cb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0d00852a5004b647\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/analyze.js\":\"af41b4ccbc4ff887\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/diagnosticsSource.js\":\"2a33637331511bbc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/index.js\":\"2ea98a7fb144fdd1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/load.js\":\"e156dfbe36d6222a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/monitorRun.js\":\"af8bf7bd971bcd21\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/schedule.js\":\"d91d3b7bea85f149\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/series.js\":\"aea0f438870ffc47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/store.js\":\"9189268a0e2fffe3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/trendAction.js\":\"5e9cf851be8adc20\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/verdict.js\":\"416dc689230ee0ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/clickToEditAction.js\":\"c9232fafd222da6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/index.js\":\"6b213fc44d70b423\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/interactions.js\":\"4b3ec05ce7d95fde\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"6ed97b6c0d975251\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGate.js\":\"cfb6a70414b6f329\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGateDialog.js\":\"63faa2dcd0d52ee5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/action.js\":\"9b9adf92ac1134a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/index.js\":\"98f9a33cb625cdfa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/localRunMessage.js\":\"67ec89349f4284bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/plugin.js\":\"b22e74560e483bb0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/progressReport.js\":\"cf5050f80cf4a966\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/sweepProgress.js\":\"be7d46044dec92b0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/FieldRowRenderer.js\":\"c69be63ead6f0f43\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/ValueRowRenderer.js\":\"a84bd961f892b96c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/actions.js\":\"7e5e54f6263fcd15\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/autocomplete.js\":\"2ffd19a965d358bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/fieldRow.js\":\"99836a48feaf6bd8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/index.js\":\"18b53871ae4781fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/referenceWarning.js\":\"d885f1cc16b4e8d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueAutocomplete.js\":\"a38c67442c4e9163\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueSchema.js\":\"91d820445515150b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/HeaderItem.js\":\"76eaac2df05a1a71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/QuickFind.js\":\"ea57d213cd4eeeaa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/index.js\":\"1c597b76c9eaaf11\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/recents.js\":\"f465e3cc21ae3ce3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/resultItems.js\":\"86b3b30ed81fdb8e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/selection.js\":\"fa23dc983d9fb05e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/toggleStore.js\":\"d25306b2c56b281c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/HeaderItem.js\":\"8691aa0d7070ef35\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/RecentsPageBlockRenderer.js\":\"74b81f3c36125125\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/grouping.js\":\"0159aa67f0adf9bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/index.js\":\"4849d9971081e2a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/target.js\":\"24ac7b8e26f5ce0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/codeMirrorExtensions.js\":\"81b36ea59bb3f699\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/contentPrefill.js\":\"0d4edd842080405e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/dataExtension.js\":\"9b6cc67e127a655f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/index.js\":\"9f9364829c075821\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a5ec097660010091\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/invalidation.js\":\"c2ea03d0ba6ac7f7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/localSchema.js\":\"72bf1a317401360f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/index.js\":\"ccbf497bce394ad5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"753d0090b88cc8ad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/index.js\":\"3107ad1b350c9464\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/referenceNode.js\":\"b8da6f1d12a7085a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e261937093213f87\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9e35ba4935f93dc3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/index.js\":\"b1a23a08b8ead914\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"edd29e12bf0a8e59\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cdbd617fc4cdbe85\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/mergeRetargetProcessor.js\":\"cc1cfe2bee71b148\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/parseFence.js\":\"a53ae59982debf23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceParser.js\":\"8ba66b9b48ae8c6f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceProjection.js\":\"8770b7198c672248\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referencesProcessor.js\":\"46ab255792690f3e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/renameProcessor.js\":\"f4709a7ceccfa982\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/spanReplacement.js\":\"b92dcce7a4c2ff53\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/htmlToOutline.js\":\"feea81f11b6055ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/index.js\":\"c0b52b02a153094c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f07fa45ab9c6ff60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/pasteDecision.js\":\"dc2ebf65e5ead98b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/action.js\":\"f47a653b76d8712f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/blockIds.js\":\"8ab2f71a5bf16247\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/content.js\":\"b06cdff9787d5278\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/effect.js\":\"eb25866cc610eb3a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/ids.js\":\"dba6973679e49c2c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/import.js\":\"c96750c2772eb913\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/index.js\":\"a7aeefb975466946\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plan.js\":\"3cf9bda14b272dcd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plugin.js\":\"33b145cf899f0d6b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/promotion.js\":\"49ed57b2f9dcab3b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/properties.js\":\"5362835610273615\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/references.js\":\"d87e28909bea9766\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/report.js\":\"46ca853468d5a34a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/roamMemo.js\":\"167af02b04196c31\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/runtime.js\":\"33a95bd35ba7043f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/schemaReconciliation.js\":\"06dbc4eec1d64129\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/srsMarkers.js\":\"2487c5a3f1320823\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/todo.js\":\"d2ab63bcd4bbab92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/typeCandidates.js\":\"6b0b6a1531a54bc3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/types.js\":\"e22c3b3c36264793\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/index.js\":\"e7ace726a97c33ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/store.js\":\"fc651a071b9ba420\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/HeaderItem.js\":\"85b4e07a1c690bc4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3e3703a3ea030ee2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/index.js\":\"04fe2e52a9267ff4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/model.js\":\"4ab1176368e4c461\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/toggleStore.js\":\"d7e61026a9381da4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/useKeyInspector.js\":\"721fb8c60ff10596\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f9ab073ed80bea40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/ShellDecorator.js\":\"fc6d1be0ceb00fbe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/actions.js\":\"0069f6b9a1f006e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b3c61c9daa5a2c3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/index.js\":\"0f7d4246d4663ed1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/shell.js\":\"ad32cfe2a6969f82\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/surface.js\":\"fb60c349d78d17c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/walker.js\":\"7f364884648bdd24\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/RescheduleToast.js\":\"19d13e6afc3c4384\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/dataExtension.js\":\"cf9a8ae47ad31241\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/index.js\":\"3aec65bfe312eb1f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/indicator.js\":\"00d85b7124dab4f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/moveSrsState.js\":\"1822a2261b051fb9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c79af7d3352badbb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/scheduler.js\":\"f60011bc973c59fe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/schema.js\":\"f9fa7f7e7ca074f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"78e078b9fcd07d84\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsClipboard.js\":\"4e9adaaca837aca3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5590ddb45997c1d4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DailyNoteReviewHint.js\":\"82b94f7d437f6245\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DeckPicker.js\":\"a78111ead1b0156f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewControls.js\":\"45061ae76db648e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewDeckRenderer.js\":\"81110f27ab38886a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewSession.js\":\"784778cecbdf8702\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/actions.js\":\"5f59f936bca5c5a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/archive.js\":\"47a8064e17f40dad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dataExtension.js\":\"b84aefa8c105f2b7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/deck.js\":\"7625dcc847ced4f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dueQuery.js\":\"69977ed4415ad0c6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/gradeDecision.js\":\"a751d169748c6f38\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/index.js\":\"ab2dc20ddc5e3c02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/keyHints.js\":\"8384ad56e9cbdd61\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewCardLayout.js\":\"c41d1f4eb672b7e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewProgress.js\":\"c6a8d3a64fcc7764\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/schema.js\":\"895e5ff4301874eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/useDueCards.js\":\"2448cd654b4b7df4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/index.js\":\"5e6a133ae9e8ded9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/record.js\":\"9a4b7b3c336dda7b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/index.js\":\"d088331500d15b7e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/persistenceStatus.js\":\"c5304d4454275f09\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/requestAction.js\":\"4547bae30d4e516a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/TypeChipsDecorator.js\":\"645f4c17ebb89408\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/codeMirrorExtensions.js\":\"0f3a25ba26949e93\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/index.js\":\"0cc0a6fb66116489\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/typeAutocomplete.js\":\"63df425f6fce390c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9cd27f7588f3500c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/actions.js\":\"66851ab84329567f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/anchor.js\":\"85d798c67dff44bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/events.js\":\"3ed3786aaa812ef8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/gestureActions.js\":\"774a1e8bb3f76304\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/index.js\":\"3910ce7583b85a47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1b2fe1aadf795468\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/collect.js\":\"ef770e5487cb1f71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/index.js\":\"fbf0ce620972a1fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/record.js\":\"8eead97c8616f366\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/RejectionDialog.js\":\"d5727841d2e57d7b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9661d8847da3001a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/index.js\":\"a681e42359778fb3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/model.js\":\"619fa7c41a8c314d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/queueCounts.js\":\"b69d401ee9c234b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rejectedHelpers.js\":\"99c76898cc142b5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rematerializeAction.js\":\"9ec252d7dd9c01f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/useHysteresis.js\":\"4efec9fac75a1dfe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/ColumnHeaders.js\":\"d962656d19def091\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/QueryUi.js\":\"3bdc6ae1c19b01d4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/TableLayout.js\":\"da9106a0909d9d50\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/actions.js\":\"ae3e3e75796a192a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/cellEdits.js\":\"42bd59ac452f49d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/columns.js\":\"478d29463e02966a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/controller.js\":\"56ef2c8c56b537ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/convert.js\":\"70dfb69d6ed7d1f2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/dataExtension.js\":\"534580b06af54ac8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/index.js\":\"a8391575d7fed560\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/keys.js\":\"51f5ad40dae1748b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/model.js\":\"c6d46cbc3046f37c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/navigation.js\":\"b3c35aa5e3096adc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/backfill.js\":\"bdf652f32220c4c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/completion.js\":\"3670f4fec701fa79\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/format.js\":\"87b1f7daa3f183be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/parse.js\":\"d64ba35fe682dc0e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/queryValue.js\":\"717b33bb2284827b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/source.js\":\"8d9dd4a8bc02610e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/registry.js\":\"2be5640a5d21e2ae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowGutter.js\":\"50909bc7fb6d0d1d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowVerbs.js\":\"09a4b837e5b49460\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/schema.js\":\"7b781b3b0e021ab4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/sort.js\":\"11521c4baf3fec64\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/effect.js\":\"cd6cdf67e950dfef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/index.js\":\"e408c97d6949dbb7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/theme.js\":\"46ea1e382561976e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/actions.js\":\"c8d6e053c0e2cd18\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/dataExtension.js\":\"a5cce0d7f857d048\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/index.js\":\"22ebd49527cf34ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/schema.js\":\"8f619042c3152abe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/TouchSelectionLayer.js\":\"19414148fc3fafad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/actions.js\":\"b0db59762e460fd3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/defaultItems.js\":\"732b221b2f261014\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/facet.js\":\"23ff15db33e2b20b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/holdRecognizer.js\":\"17a0b164eca0e710\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/index.js\":\"0cd08e360fe4398e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/UpdateIndicator.js\":\"3fcffc7b011b09ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/index.js\":\"266c8260c965b5bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/loadTimes.js\":\"be6af196b01f7d04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoNotesRenderer.js\":\"d51fa8eaa7feea92\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoPlayerRenderer.js\":\"0bf3f98c4df28b40\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoTimeStamp.js\":\"d0263b21aff0d4c8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/actions.js\":\"3bbfd3d3738a899e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/index.js\":\"b0c4d4e6b5a8e3da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/markdown.js\":\"6ddaab2eaa4add72\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/notes.js\":\"e82827afc0121e3e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/registry.js\":\"b570900f967f9c84\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/remark-timestamps.js\":\"dce275037fbae41a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/view.js\":\"bdc48ac9f408f730\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/LinkHints.js\":\"1af1df279d3d8e29\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/index.js\":\"0c19f6bbe8215a80\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/model.js\":\"e17aadec7826ed3e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/settings.js\":\"d52f79752c2b984b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/actions.js\":\"86bdcd9b2020ba63\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/index.js\":\"5c30eadaa8599867\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/interactions.js\":\"583823cc93ab2212\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/workspace-header/index.js\":\"9f932f5e29756a71\",\"/knowledge-medium/pr-preview/pr-1854/src/registerServiceWorker.js\":\"d295f0237f6f8144\",\"/knowledge-medium/pr-preview/pr-1854/src/requestPersistentStorage.js\":\"ecd794b9996daaff\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authRequestDeadline.js\":\"fff0eb8fde397b55\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authStorage.js\":\"4cf5bed6e326c093\",\"/knowledge-medium/pr-preview/pr-1854/src/services/powersync.js\":\"940b32ab46db5dcd\",\"/knowledge-medium/pr-preview/pr-1854/src/services/supabase.js\":\"49b461b7abb5f4e7\",\"/knowledge-medium/pr-preview/pr-1854/src/services/uploadErrorClassifier.js\":\"a6180857289f843e\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/ActiveContexts.js\":\"3bb336f4b8d7a1d9\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/HotkeyReconciler.js\":\"10c2579348f1afff\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/WipeLocalDataDialog.js\":\"5ad008ed80aca492\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionDispatch.js\":\"fd6a534486d905fd\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionRefItems.js\":\"55b61b477e07dd06\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/applyKeybindingOverrides.js\":\"5ab8bf711bd8a315\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockActions.js\":\"4a747ef72bcb377a\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockMergeGesture.js\":\"25ad93a955529aef\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/canonicalizeChord.js\":\"e4e76d43ca32f030\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultContexts.js\":\"b26b05fd5ccb0a34\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultShortcuts.js\":\"2956e1421597a250\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/effectiveActions.js\":\"856a80f4b8b82f61\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureAction.js\":\"2f6caa4afdead85c\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureBinding.js\":\"9189d286343e516b\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/holdRegistry.js\":\"f6c5b558b0cb9f28\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingConflicts.js\":\"dabc991251dd58a4\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingOverrides.js\":\"a9c8c1c5bf638edd\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/pointerAction.js\":\"c53b96b7f937bf75\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/resolve.js\":\"19469501adcf72f5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/runAction.js\":\"67c070faac6c97e5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/sequenceMatcher.js\":\"1ff15971304c93cc\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/types.js\":\"fad85c914f0cbbad\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionContext.js\":\"bd0a5b965babdd6f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionDiscovery.js\":\"1c043896a5083ef5\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/utils.js\":\"cbc3fe42561bc974\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/bootStore.js\":\"5699fe32404a4f0c\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/previewDatabases.js\":\"437f9c85fbd79582\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/byteTransform.js\":\"27379e48bca6ed01\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/attachmentCleaner.js\":\"2953d308db06a151\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/attachmentParts.js\":\"5486ede6f2fbbf4f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleParts.js\":\"fcbd05a89fcd9080\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleRecord.js\":\"1e8bbfd1c65e311b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/manifest.js\":\"63da6f54e8d34df0\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/takeBundle.js\":\"8077df4cea27e015\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/verifyBundle.js\":\"8ed529390d7ba912\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/cleaningStage.js\":\"37239a5a35037c5b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionKey.js\":\"674a97eddb5370c1\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionServer.js\":\"f816fe1e346a633f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flip.js\":\"c4a147b0b87787c8\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flipAttempts.js\":\"3cecf1244caae6f4\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/pages.js\":\"c6c0e2c6ef046e2b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/preflight.js\":\"32f9615643e8a140\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/reseal.js\":\"f154a0a7e3e941b6\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runConversion.js\":\"2b4bb8434bcbf660\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runLock.js\":\"475f50d9bdd23fb4\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealing.js\":\"cf16b7628c7ab25f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealingStage.js\":\"b23609b58a664bf4\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/stage.js\":\"d22badaef8c014e9\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/verifyReseal.js\":\"1d23ec98386237b7\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aad.js\":\"3423eae91e6dcc16\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aead.js\":\"a94a290089416be4\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base32.js\":\"fc0eddf37605e538\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base64url.js\":\"87cdd1a2eb483440\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/binaryEnvelope.js\":\"66ff83752000f948\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/byteAead.js\":\"ff9efb0eaa5b8abd\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/canary.js\":\"5e0543d8faf8ccce\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentHash.js\":\"37bc05d3525844c5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentKey.js\":\"6973bbc027d0dbf5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/derivedIdNamespace.js\":\"15df1e204c8a474d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/envelope.js\":\"8534284567d35074\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/hex.js\":\"5d4f8407dee4e755\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/sha256Hex.js\":\"965e64ee402e4408\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/workspaceKey.js\":\"f7e9c900fab243ea\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/conversionState.js\":\"f6668f1d9aa5bc1b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a366bceb505de154\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/pastedKey.js\":\"c7abe26cc2bfa8d5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"74cd8bb303ff6219\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/upgradeWorkspacePin.js\":\"777b567d00690215\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/keyStore.js\":\"aa921069e923a942\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/mintWorkspaceKey.js\":\"a0d6c281ceaa73ea\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/modePin.js\":\"891267889fa21407\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/openWorkspaceKeys.js\":\"707cce77e7acf767\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolveWorkspaceEntry.js\":\"1bfd28b58156902a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolver.js\":\"631d1c8998a09f46\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/workspaceAccess.js\":\"6d07466c7818669a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/transform.js\":\"f2f7f7d66b9726db\",\"/knowledge-medium/pr-preview/pr-1854/src/themeBootDefaults.js\":\"ad64b622ad8cd259\",\"/knowledge-medium/pr-preview/pr-1854/src/types.js\":\"a1720f768f77fe93\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/ClientLocalSettings.js\":\"5577951d22b6b78f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/abortableSleep.js\":\"d935aa3d2b8ca87b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/array.js\":\"15069ce6e681c518\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/backlinkAutocomplete.js\":\"8bc71895d6d543f3\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockCrumbs.js\":\"50eb7e3e3e7b9eda\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockrefAutocomplete.js\":\"098a0545c622527f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/cadencedIdleJob.js\":\"a579a80f45cfd449\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/callbackSet.js\":\"0ed2d2047f359908\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/clientId.js\":\"444a3de6e9cbd958\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirror.js\":\"64409e4650acfe39\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirrorCompletion.js\":\"ceae0c00ac938ff3\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/copy.js\":\"694e996bee084076\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dailyPage.js\":\"9aefec992c401f25\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensics.js\":\"721b09db65abb039\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensicsHooks.js\":\"09babb63c96aedf0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/deleteBlockThroughUi.js\":\"f52dd039a1feafe2\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dialogs.js\":\"85d11fd3267c4746\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dom.js\":\"bec98efea5772726\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/downloadBlob.js\":\"6009d7307f4d6f38\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/exportSqliteDb.js\":\"d997ac6897c66342\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fileSystemAccess.js\":\"1486cfffdcaeb998\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/flipSlide.js\":\"33014085f8a61afe\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fnv1a.js\":\"95404188450f6e38\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/formatBytes.js\":\"d3ab8bd951a98c21\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fuzzyRank.js\":\"8c60d48519fbb745\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idbKeyedStore.js\":\"9bdad4837ecb276d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idleCallbackPolyfill.js\":\"ab3335c910c374c0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardAwareScroll.js\":\"5bb60ded2de6e725\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardViewport.js\":\"59482e265858043d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/lastWorkspace.js\":\"0441ef91ba82170b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutColumns.js\":\"ed7afa4583d2cb7d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionDom.js\":\"e5fac95eb36175cc\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionId.js\":\"c3cbeb7cded1ff88\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkClickGestures.js\":\"374cb05bd160ac9b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkTargetAutocomplete.js\":\"d7791580145835ec\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbCorruption.js\":\"077ebe352488fee7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbRecovery.js\":\"0c27a2b18346d741\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/markdownParser.js\":\"158e4b2648f0c154\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/memoize.js\":\"0544bb365bd874d9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameFieldCommit.js\":\"bfd5d80b3f028e83\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameList.js\":\"aed7b3d4d6e967ad\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/navigation.js\":\"ad620cab51e8ce81\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/omnilinerNamespace.js\":\"1dbc0d1aebbf75ce\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/opfsPageScan.js\":\"9d79c0b2eb05a3f1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelClearance.js\":\"ede4c10564423686\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelHistory.js\":\"f4c9b10fbcd42a53\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLanes.js\":\"31a40a9d290e5504\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLayoutProjection.js\":\"c87e5f6c6065563f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelScrollAnchor.js\":\"ea67d7d006ae37b1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelUrlFlags.js\":\"e1117eab471aedf4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/platform.js\":\"c177a5d877f3cf47\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/pluralize.js\":\"89c803a13144b765\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyCreation.js\":\"c185e423b45d13d4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyNavigation.js\":\"76da9fd2083fe92a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyValueContext.js\":\"bd2fe8cd252db4b7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/react.js\":\"fbf0aab7bd28e082\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeDate.js\":\"b8c1e9aab182a9f1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeTime.js\":\"406ba26b870ed621\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/renderScope.js\":\"defeea213fd5a78e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/resolvedThenable.js\":\"f68dd5f6416264da\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/routing.js\":\"2bd4c1c6b079ef08\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/safeMode.js\":\"bcd9ff9b9801e14d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/scheduleIdle.js\":\"152c58d5cb61cf95\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/screenWakeLock.js\":\"583fbf1df60bb15a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/selection.js\":\"5d42e90bb4c0383f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/softKeyboardGrab.js\":\"73ac108281c24e25\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/startupTimeline.js\":\"9f5994f7569321eb\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/state.js\":\"4f7e74e4db87ac14\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/string.js\":\"75fd8862b466bad6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/surfaceZoom.js\":\"78cb61abca59a6e1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/time.js\":\"49504eb90d868f59\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toast.js\":\"f57678a67a78b71f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toggleStore.js\":\"a89c880717634c35\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/untilStopped.js\":\"e91c1a6752de5aac\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/userActivity.js\":\"70211706b4d49da4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewTransition.js\":\"9fc1c8b57605359a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewport.js\":\"53334ea18a3a2326\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/webLock.js\":\"54b1caf9d18ad766\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceRecovery.js\":\"f7f9c94cf13637f9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceSnapshotStore.js\":\"b1a72f80c0687be4\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-compiler-runtime.js\":\"65f012a87fff6168\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-client.js\":\"e481635d41d47ea0\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server-edge.js\":\"8d37bbeadbd589b0\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server.js\":\"09b8b70860ff14ee\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static-edge.js\":\"36b88468a833d233\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static.js\":\"5a4793977b5984cd\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-test-utils.js\":\"5a29f198b69757b4\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom.js\":\"e480c77dc86f13c3\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-runtime.js\":\"6eca9857300710fa\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react.js\":\"d74a604a4159e5af\",\"/knowledge-medium/pr-preview/pr-1854/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
