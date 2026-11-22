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
		buildId: "4bad258df4a3-bcbd67c1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/\":\"27b3b13482bf4fc1\",\"/knowledge-medium/pr-preview/pr-1854/index.html\":\"27b3b13482bf4fc1\",\"/knowledge-medium/pr-preview/pr-1854/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1854/assets/FacadeVFS-CgyFc0Or.js\":\"f7107b3c2f669b35\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSCoopSyncVFS-DpzJl27D.js\":\"4eebe9f25a48ab79\",\"/knowledge-medium/pr-preview/pr-1854/assets/OPFSWriteAheadVFS-DlGdIEBC.js\":\"7286765a34b08730\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-Bskxs-KJ.js\":\"76879e9c640f248f\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/assets/wa-sqlite-async-D6RHqS6G.js\":\"fa520a03ccd3efd9\",\"/knowledge-medium/pr-preview/pr-1854/assets/worker-C1WrjI8d.js\":\"194e79e7a5aed343\",\"/knowledge-medium/pr-preview/pr-1854/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1854/chunks/app-BKUsP5s1.js\":\"cb01797b0c576bc3\",\"/knowledge-medium/pr-preview/pr-1854/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1854/index.js\":\"cb37e45eb19cb118\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1854/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1854/assets/AccessHandlePoolVFS-BIZVIYHj.js\":\"17f189cb83277d1a\",\"/knowledge-medium/pr-preview/pr-1854/assets/IDBBatchAtomicVFS-DJ5yp1vN.js\":\"6b5f5e2d91dc8f44\",\"/knowledge-medium/pr-preview/pr-1854/assets/MemoryVFS-DXct_1M1.js\":\"feb5dd2246f4ee28\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-DD5iVoiM.js\":\"5dc2477c8b15c381\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-7pYGBX1v.js\":\"d1424086317a28af\",\"/knowledge-medium/pr-preview/pr-1854/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1854/chunks/AccessHandlePoolVFS-BnG_B-oX.js\":\"75c826d9b9cf6eca\",\"/knowledge-medium/pr-preview/pr-1854/chunks/FacadeVFS-ee33nHSx.js\":\"f2a54809b58c9a30\",\"/knowledge-medium/pr-preview/pr-1854/chunks/IDBBatchAtomicVFS-CqY32hOt.js\":\"5b2f3bfc070b6537\",\"/knowledge-medium/pr-preview/pr-1854/chunks/MemoryVFS-CLdVVNTf.js\":\"5d771aa73e977d1d\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSCoopSyncVFS-DNLqhD5f.js\":\"67c7979881a05b1b\",\"/knowledge-medium/pr-preview/pr-1854/chunks/OPFSWriteAheadVFS-CMSzLql5.js\":\"8bbd1640aba8be08\",\"/knowledge-medium/pr-preview/pr-1854/chunks/Preview-BnAMmCRj.js\":\"2b127ec05b56dd5b\",\"/knowledge-medium/pr-preview/pr-1854/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/card-DVzTjiPy.js\":\"ed953df173d5a69e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1854/chunks/dist-Dbe6F0LK.js\":\"77b7761ae568f198\",\"/knowledge-medium/pr-preview/pr-1854/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-async-B_gUl_26.js\":\"8344e870a30a45b2\",\"/knowledge-medium/pr-preview/pr-1854/chunks/mc-wa-sqlite-lGjJtpDF.js\":\"58bd26143f3f1728\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-BOH0CYtJ.js\":\"07e81fc16350f99c\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-Cpjso8jc.js\":\"a73ca6c334513430\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-CxzdBPQN.js\":\"593349d3f60e5043\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DVEfqxk2.js\":\"38d26bff8d15a403\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-DXcmvA8w.js\":\"f7bf3f0c80404a62\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-JF_Nc5DQ.js\":\"6694cb46f1ce6a78\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-_iUx682e.js\":\"af34fa9474cd1023\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server-legacy.browser.production-NOob7gn-.js\":\"339e1b7526a1c750\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.browser.production-edcGtRd6.js\":\"83ba1665a5b9fc7e\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-dom-server.edge.production-BCbxwGc5.js\":\"436dccf029d851d6\",\"/knowledge-medium/pr-preview/pr-1854/chunks/react-hcbZPKJS.js\":\"62cfb7adcbafe341\",\"/knowledge-medium/pr-preview/pr-1854/chunks/server.browser-DeC2gVQM.js\":\"90c6ccba942a1728\",\"/knowledge-medium/pr-preview/pr-1854/chunks/textarea-DsDRcE7D.js\":\"983c62c40e53a0c0\",\"/knowledge-medium/pr-preview/pr-1854/chunks/ui-B_S_uINz.js\":\"b39a0b49d7134aa8\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-D1cMDcN9.js\":\"8eb29dd69d737fcf\",\"/knowledge-medium/pr-preview/pr-1854/chunks/wa-sqlite-async-CW024GuI.js\":\"7811e05034a45856\",\"/knowledge-medium/pr-preview/pr-1854/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1854/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1854/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1854/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1854/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1854/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1854/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1854/src/App.js\":\"f0aefb70578dc003\",\"/knowledge-medium/pr-preview/pr-1854/src/appUpdate.js\":\"fd1fca6aab9be0e8\",\"/knowledge-medium/pr-preview/pr-1854/src/appVersion.js\":\"8c7dbc8150c0bc3d\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/initialLayout.js\":\"ebea530afa97611a\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/openWorkspaceData.js\":\"2e5c180a1d7fbafb\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/resolveWorkspace.js\":\"ef348defe10a9688\",\"/knowledge-medium/pr-preview/pr-1854/src/bootstrap/workspaceBootstrap.js\":\"872023a4553c7b00\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockComponent.js\":\"375d5f5a627c43cf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockCrumbs.js\":\"29c7fb247f2a6097\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockEditor.js\":\"6919cf4c33541a35\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockLoadingPlaceholder.js\":\"1f4e9ec4ac8b2210\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockProperties.js\":\"4895eba5a3139ee0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/BlockSearchPicker.js\":\"073ecb2783d1f862\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ConfirmBulkDeleteDialog.js\":\"d354adaecd4426ee\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DividerHandle.js\":\"c0796ba33c0746f6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/DraftEditor.js\":\"6fdc7e7cbad75137\",\"/knowledge-medium/pr-preview/pr-1854/src/components/GutterPill.js\":\"1e20a0cc0db9fd32\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Header.js\":\"1dfeb59ad900df4b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/LazyBlockComponent.js\":\"a77688bdf2ece358\",\"/knowledge-medium/pr-preview/pr-1854/src/components/Login.js\":\"ce4bf406703bed93\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ZoomableSurface.js\":\"8d746d00d3173dc6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/editModeKeepalive.js\":\"3c29e193d1b2f159\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyDisplay/PropertyDisplayScope.js\":\"054b9c1f17ab085a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4fd151b2686823cf\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefPropertyEditor.js\":\"9538c6b305b194a2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/RefTargetTypePicker.js\":\"df83db29a805e168\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/SelectPropertyEditor.js\":\"eb06ca78acbf8e8a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/TypesPropertyEditor.js\":\"02fa0b4d11d04b4f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/defaults.js\":\"5f45700b3c607bfa\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/kernelValuePresets.js\":\"1bf7390e580efe78\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/selectablePresets.js\":\"50db2f2f61f2148c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyEditors/typesPropertyUi.js\":\"793ca89fa7868837\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/AddPropertyForm.js\":\"7c85c2768a6790f5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyPicker.js\":\"1ee8bd9239d7ec8f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/PropertyRow.js\":\"7ef0b38bece061ed\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/Rows.js\":\"6409db67a03f501e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/actions.js\":\"c8a82ef05a09251b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/declarationOnly.js\":\"3b63df55ceb31a4d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/layout.js\":\"b57842cee507459f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/model.js\":\"91faec2d9378aa33\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapeUi.js\":\"49ef1acd5a70ef48\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/shapes.js\":\"34db6bcbd695e968\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b3d6c7d176b0e438\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanel/visibility.js\":\"cdb315163226ff58\",\"/knowledge-medium/pr-preview/pr-1854/src/components/propertyPanelSections.js\":\"2d569dd030755416\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockEmbed.js\":\"09fcf6d8cf615081\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockLink.js\":\"26d04ad5972760d1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/BlockRef.js\":\"e397ee3374ab5d50\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/ReferenceLink.js\":\"ea3c45d8aa6157ac\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuard.js\":\"35a5ed7745877d67\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/cycleGuardContext.js\":\"c190537a9fb5a4ec\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/linkInteraction.js\":\"5b87d39333e46573\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/referenceLayout.js\":\"47ffe118da78d771\",\"/knowledge-medium/pr-preview/pr-1854/src/components/references/useBlockRefAncestors.js\":\"562aa4fb817d4582\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockGutter.js\":\"fe923d5f0b33a69c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockInfoDialog.js\":\"dd693e6f1b0d571a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BlockTypeBlockRenderer.js\":\"b52ba853ade90bc9\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/BulletHoverCard.js\":\"ba31a89a5cdb98c2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorContentRenderer.js\":\"d4317e223f51eee4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5b5ecc88ad4da51b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ColumnResizeHandles.js\":\"e2dc37d5027f3198\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a533f09333c52553\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/DefaultBlockRenderer.js\":\"cefb001d8321e22b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/LayoutRenderer.js\":\"4db8ad6103d5bbff\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MarkdownContentRenderer.js\":\"15ee341d9077bf9c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/MissingDataRenderer.js\":\"a294601cc0170687\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PanelRenderer.js\":\"ebb70a53e0ec9e85\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/PropertySchemaBlockRenderer.js\":\"71ebbe7dff41f683\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/TopLevelRenderer.js\":\"beb85110200661a0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockGutterMode.js\":\"14d59bc4cd6140db\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/blockTitleText.js\":\"e87eb2255f9a1526\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/fieldCreationKeydown.js\":\"3ec885c3edf6284e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/renderer/layoutRootContext.js\":\"c87b9b99788b1215\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/TypeChip.js\":\"894c92052b86957a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/typeChip/chipStyle.js\":\"fdffb754bbbb2c37\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/anchored-floating.js\":\"2fbb5006b50a9099\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/button.js\":\"838ac488d53f31a4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/card.js\":\"fdfa68405a9e2323\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/checkbox.js\":\"38ea68ff2281ba4d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/collapsible.js\":\"a0167308d6326501\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/command.js\":\"a763bf3d50570374\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/context-menu.js\":\"11348128cf125a25\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dialog.js\":\"c31d79990fe8abda\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/dropdown-menu.js\":\"b3f1dc70167cd4df\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/floating-listbox.js\":\"808b22eaba822830\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/index.js\":\"040117a3f66007b4\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/input.js\":\"45af3a1bb8b77393\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/kbd.js\":\"b4090d73ad49526c\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/label.js\":\"69a471b4a92a5ace\",\"/knowledge-medium/pr-preview/pr-1854/src/components/ui/textarea.js\":\"0fddf2a308d8215a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/useEditModeYieldKeepalive.js\":\"6ee8b07ce9cad283\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/BootFallback.js\":\"a2aece5e8ebd8852\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/FocusedRowLazyMount.js\":\"0b57c23460d90e56\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LazyViewportMount.js\":\"4ede72254fdc70b1\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/LocalDbCorruptionFallback.js\":\"8ec37b9370e7e3f0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/error.js\":\"cea0996a43071c27\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/lazyMountRegistry.js\":\"b06dff12d742f897\",\"/knowledge-medium/pr-preview/pr-1854/src/components/util/suspense.js\":\"7af8f66cd5870fd3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/CreateWorkspaceDialog.js\":\"635dddfeac957f35\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/PendingInvitations.js\":\"66b94dccfc99bb04\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/SyncProgress.js\":\"412c2037d0f81be6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/UnlockProgress.js\":\"7605434382da88e2\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceKeyGate.js\":\"78ea66701d317df8\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSettingsDialog.js\":\"6cbbc2d9865929a0\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSwitcher.js\":\"e56104649599e922\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/WorkspaceSyncGate.js\":\"92e2ad44ac350716\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlow.js\":\"cd90c2bd80e6842d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/ConversionFlowHost.js\":\"5d96a10cce38a21a\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/EncryptionSection.js\":\"971d53f451ab567d\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/attachmentPrompts.js\":\"2653a3b940a67ed6\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c63329f3f3d5775f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowDeps.js\":\"038c20b81c277b71\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/conversionFlowStore.js\":\"21a30d271fe0bfa5\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/flowUi.js\":\"9e83d12a00a0c94b\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/conversion/useConversionRun.js\":\"d247f1b52ce9a19e\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/keyUi.js\":\"da9dfe547c8f67c3\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnKeyLoss.js\":\"ce2ca623f2d1ed34\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/useCloseOnServerE2ee.js\":\"b4bbe9c962696e0f\",\"/knowledge-medium/pr-preview/pr-1854/src/components/workspace/workspaceUnlocked.js\":\"52650cabcc77fa0e\",\"/knowledge-medium/pr-preview/pr-1854/src/context/backgroundSubtree.js\":\"a36999775b463e2e\",\"/knowledge-medium/pr-preview/pr-1854/src/context/block.js\":\"7312fa4bf9b3863b\",\"/knowledge-medium/pr-preview/pr-1854/src/context/layoutWsContext.js\":\"eda78b1378ac1d1e\",\"/knowledge-medium/pr-preview/pr-1854/src/context/propertyDisplay.js\":\"3de3d81f83299bc7\",\"/knowledge-medium/pr-preview/pr-1854/src/context/repo.js\":\"db6b47419d6c0c07\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasClaim.js\":\"af111ae3cc1478a8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/aliasSeatNamespace.js\":\"0b31cde35c783acf\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockData.js\":\"e76732b6e6f65901\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/blockType.js\":\"62b56bd733505a4f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/changeScope.js\":\"88a15d48c3bc5da5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/codecs.js\":\"9dc9efe7e7fab238\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/derivedData.js\":\"80ac4253daaeb02c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/errors.js\":\"9cc4492cae87da31\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/events.js\":\"ad7c4cef70855eec\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/handle.js\":\"60384d789b7ddd69\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/index.js\":\"0f2a620b2e6d21d3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/mutator.js\":\"5f233c733618b8c5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/processor.js\":\"d075a6c7cc685661\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/propertySchema.js\":\"330ad78890e736d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/query.js\":\"dfedd601b19fc253\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/sameTxProcessor.js\":\"ba091f2cca39fbe0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/schema.js\":\"60384d789b7ddd69\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/tx.js\":\"60384d789b7ddd69\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/typedBlockQuery.js\":\"cba4c68b011385d0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/user.js\":\"ed0ac53fac723164\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresetCore.js\":\"71faefea2397f592\",\"/knowledge-medium/pr-preview/pr-1854/src/data/api/valuePresets.js\":\"00c1837f0405757c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/attachmentCleanerIOVerb.js\":\"cc205d58379fc87d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/block.js\":\"3dfab4c535aa483b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockCache.js\":\"ea3282609c5c5692\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockId.js\":\"982b48517415f87e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockLiveness.js\":\"98398990ae9dedc7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockMerge.js\":\"55e52887c8cfda10\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockSchema.js\":\"105fc618ea66c21a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypeLookup.js\":\"0546d2edcd6d11fc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/blockTypes.js\":\"e45b09f07e628765\",\"/knowledge-medium/pr-preview/pr-1854/src/data/clientContext.js\":\"7e40448e6363cb57\",\"/knowledge-medium/pr-preview/pr-1854/src/data/dbFileSiblings.js\":\"81dc42eea926f029\",\"/knowledge-medium/pr-preview/pr-1854/src/data/definitionSeeds.js\":\"c5a526509e04c5da\",\"/knowledge-medium/pr-preview/pr-1854/src/data/derivedIds.js\":\"7820eca206088e57\",\"/knowledge-medium/pr-preview/pr-1854/src/data/drawnSubtree.js\":\"8ef73de700c78820\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facetBridge.js\":\"d28729d56f7c469b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/facets.js\":\"d4890dfea1005cc2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/globalState.js\":\"9bc817af17bcc7f7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/aliasClaimRederiveProcessor.js\":\"dc4dee8de7eaca62\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/ancestorBatch.js\":\"6c905acb50113eb0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/blockTypeTypeifyProcessor.js\":\"31c54aad07efee70\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/clientSchema.js\":\"b41085fee4e82fc3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/commitPipeline.js\":\"ad4d17f9715b76e4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/devAssertions.js\":\"62a1feab7e3cb5c3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/firstSync.js\":\"f6aec00396e99c2e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/freshInitialLoad.js\":\"53a885d4c0937c6c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/graphBackfillClaim.js\":\"df6e6de35bff5c3a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/handleStore.js\":\"85cf0be86cf906f5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/idleMarkerJobs.js\":\"36a47c747532814f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initialDownload.js\":\"0c9740a6b11312e4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/initializeClientDatabase.js\":\"7ee48883b79fefc9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/jsonCanonical.js\":\"7b0ee6b82fee8026\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelInvalidation.js\":\"d7bbed69bbb15aeb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelProcessors.js\":\"0ff3ff8b55e20798\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/kernelQueries.js\":\"0107e556b397df46\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/mergeTypeMembershipProcessor.js\":\"b324d1b557e1cb5d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/normalizeReferencesProcessor.js\":\"89d1f9980b0401db\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/poolInstrumentation.js\":\"fba873785d06822c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/processorRunner.js\":\"963f41e48860fa9b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyCellBackfill.js\":\"0bbd8f2308f16a13\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildMint.js\":\"e2238ed33442997d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyChildrenProcessor.js\":\"d3ef365d4d391600\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6e9851442c5c5e5a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyDefinitionSynthesis.js\":\"213fa5a628f95893\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyKeyScan.js\":\"034afd1bbe0627f6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertySchemaResolution.js\":\"74178dc1d006fe9a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/propertyValueEdits.js\":\"35cf7278d3d3e2f4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/raiseProtocol.js\":\"7a04911a29383098\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/readBatch.js\":\"2e3d0678fd67cc25\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/refProjection.js\":\"be45f4a9610f4c22\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetLookups.js\":\"de64755a5554b148\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/referenceTargetProcessor.js\":\"7b2a303ce054b534\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/replayMerge.js\":\"b5e5967799ea5703\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/sqlBinds.js\":\"a7cf588371e08f71\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"390aef39a8710379\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/arrivalProcessors.js\":\"d18835df47b009b7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/invalidate.js\":\"a4339d26b1c40e47\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/materialize.js\":\"c42697833d2fce3e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/observer.js\":\"ac991b701b7a2338\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/syncObserver/reconcile.js\":\"0d9ed263e33666e7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/timingMetrics.js\":\"73ccb53657df8574\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/treeQueries.js\":\"4cbccc136264339e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txEngine.js\":\"3fd8eaf89b6669e5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/txSnapshots.js\":\"c7d2d7bed2c1fe9e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/typedBlockQuery.js\":\"1b864c4d7f74f4a3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/internals/undoManager.js\":\"c03889500766746e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/invalidation.js\":\"6e0ec45d211b06d8\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelDataExtension.js\":\"0d5e01446a1c0c3b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelPage.js\":\"f39248e9279e0265\",\"/knowledge-medium/pr-preview/pr-1854/src/data/kernelValuePresetCores.js\":\"c1a6192d20377826\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbCorruptionSignal.js\":\"676f6d2ebc865878\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbStorage.js\":\"c0614c991743ebfb\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localDbVfs.js\":\"d87451ab3ecb0cf4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/localSchema.js\":\"9e85ce689472c7ae\",\"/knowledge-medium/pr-preview/pr-1854/src/data/maintenance.js\":\"bc7cc8536dfffca4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mergeProperties.js\":\"49b971220f8b3384\",\"/knowledge-medium/pr-preview/pr-1854/src/data/metricsConsoleHook.js\":\"f631f0085d39ff8d\",\"/knowledge-medium/pr-preview/pr-1854/src/data/migrationsPage.js\":\"6f743038d49b2f37\",\"/knowledge-medium/pr-preview/pr-1854/src/data/mutators.js\":\"cb79740b23ea4879\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKey.js\":\"b64b0a7fd43a26a1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/orderKeyPlacement.js\":\"8be89792929dc02b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/outlineSurface.js\":\"727195eabb6262ce\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingEditorContent.js\":\"7c817a2e3253bb66\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pendingUploadsSql.js\":\"5dcf5742a30d28a4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/pluginStateExtensions.js\":\"0bc7847037034145\",\"/knowledge-medium/pr-preview/pr-1854/src/data/powerSyncLogger.js\":\"0db071916bb269e2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/projectorRuntime.js\":\"50990c4a74bfa244\",\"/knowledge-medium/pr-preview/pr-1854/src/data/properties.js\":\"52cd8590cc2f9b26\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertiesPage.js\":\"e2e3ac75e176376e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyChildren.js\":\"54dea64bd15ea950\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionFanout.js\":\"2d1d30180ee02666\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionMetadata.js\":\"ff13d20a51d297c5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDefinitionRegistry.js\":\"ff1d6ec8d004b19c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyDisplayMode.js\":\"cc9934bce24c101a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertyRowCreation.js\":\"8b07d052360b8fea\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySchemaCreation.js\":\"f981735b811d6029\",\"/knowledge-medium/pr-preview/pr-1854/src/data/propertySeeds.js\":\"7dbe8058773800d7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/recentsPage.js\":\"b4290aff006cccd0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/referenceBlock.js\":\"7e769393b0d2ea0b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rejectedUploads.js\":\"cfa66d2aa8a9252a\",\"/knowledge-medium/pr-preview/pr-1854/src/data/releasePowerSyncConnection.js\":\"3fec8ecdcb890b5f\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repo.js\":\"ffdfe9396ec6a0c7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/repoProvider.js\":\"60a6a25c82a52ec1\",\"/knowledge-medium/pr-preview/pr-1854/src/data/rowProperty.js\":\"325e64a2c34899e0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/searchFilter.js\":\"53455e1fd9fe41b5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/seedIdentityLedger.js\":\"4fe703e29d2407f0\",\"/knowledge-medium/pr-preview/pr-1854/src/data/stateBlocks.js\":\"344c546bb1d5cdf2\",\"/knowledge-medium/pr-preview/pr-1854/src/data/structuralEditPolicy.js\":\"41fb42723cb4726c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/subtreeDelete.js\":\"19d6882b9b92e33b\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncStreamLock.js\":\"e37f70a85fc2959e\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableSqlRecognizer.js\":\"c0f85fdbab2404a5\",\"/knowledge-medium/pr-preview/pr-1854/src/data/syncedTableWriteGuard.js\":\"42925c3aa2262660\",\"/knowledge-medium/pr-preview/pr-1854/src/data/targets.js\":\"af78397bbde40703\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeColors.js\":\"db064734343995bd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionMetadata.js\":\"47b910e2f4ccf9c9\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeDefinitionRegistry.js\":\"7d9fbdc6e9829fbc\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeExtraction.js\":\"b275e62df9f1abe4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeInitialValues.js\":\"860042fce80d5891\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typePropertyGroups.js\":\"6a9921d565694dd7\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeSeeds.js\":\"a6201e87a0eab6c6\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typeTagger.js\":\"799c979a4c976540\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typedRecords.js\":\"725f27e2bd2c8e3c\",\"/knowledge-medium/pr-preview/pr-1854/src/data/typesPage.js\":\"1270e4a66621b185\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userPrefs.js\":\"235d50ca302e8124\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userSchemasService.js\":\"0bfbb650d2ee0530\",\"/knowledge-medium/pr-preview/pr-1854/src/data/userTypesService.js\":\"8463ed0fb83f78a3\",\"/knowledge-medium/pr-preview/pr-1854/src/data/valuePresetRegistry.js\":\"82c916f234b016ca\",\"/knowledge-medium/pr-preview/pr-1854/src/data/visibleChildren.js\":\"f3172760fcacd1fa\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceConversion.js\":\"a6f02db8d6512767\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceFirstSync.js\":\"691bdb00b5ccf650\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceIdNamespace.js\":\"5d1caa516a5a8060\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaceSchema.js\":\"ab00ee24916af012\",\"/knowledge-medium/pr-preview/pr-1854/src/data/workspaces.js\":\"5b56fdc23521e6fd\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadLog.js\":\"2524ae1b15046be4\",\"/knowledge-medium/pr-preview/pr-1854/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/BlockPasteShellDecorator.js\":\"ed5a6d7c6f62b3e1\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/atTrigger.js\":\"4bf5bf4f8b694c2b\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/autocomplete.js\":\"360c766ee0333f56\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/codeMirrorExtensions.js\":\"05d2174b5ab25cd5\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/contentFlush.js\":\"99135e3d9f7c6338\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/defaultInteractions.js\":\"ee5882e2345ba330\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/editSettleSignal.js\":\"b880bfc392711fa7\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/insertImage.js\":\"da3164c09c83715a\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceCompletionRange.js\":\"3ab6879b8684b673\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/referenceTargetTypes.js\":\"f633ffae00c434e2\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/syntaxContext.js\":\"af53330dfc4d7ff1\",\"/knowledge-medium/pr-preview/pr-1854/src/editor/triggerMatch.js\":\"f839620afd1f7428\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/AppRuntimeProvider.js\":\"a24c3b0dea4d9f44\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/BlockFocusShellDecorator.js\":\"26dfbceaab26b751\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/ExtensionRenderBoundary.js\":\"5b548d4a851f91a9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/PanelContentRecovery.js\":\"9e32259dc70a513b\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/apiCatalog.js\":\"60c1ef0376bd95ea\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/approveExtensionHere.js\":\"b3c5578551b5206a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/armedCutAppMount.js\":\"b73fa625a0a45d8d\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/batchableKeyedStore.js\":\"aab44ac924cf803b\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockInteraction.js\":\"254bab9a1608099e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/blockSelectionAction.js\":\"6fa65a035c27d3ca\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compileExtensionModule.js\":\"6670c77273b62d70\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/compiledModuleCache.js\":\"3d2ab279c277236e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/continuousGestures.js\":\"652f52ab3a302f0e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/core.js\":\"19e080958e18c4d6\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/defaultRenderers.js\":\"6db41952171f6842\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/definitionFanoutAppMount.js\":\"499176df08168d91\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dialogAppMount.js\":\"3801f6932294ce17\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensionSeeds.js\":\"b6f99ea757059b8a\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/dynamicExtensions.js\":\"83c81a955f0fe4fc\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/exampleExtensions.js\":\"5f1406f8b1b8d34b\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionApprovalStatus.js\":\"f06d987331e5cab9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrorToast.js\":\"b5b7aedee54b64c6\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLoadErrors.js\":\"f8370e502b55c5b0\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionLookup.js\":\"d6a3ef73094a3cd2\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionToggles.js\":\"d2f5a6edeb6bc468\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/extensionUtilitiesCss.js\":\"31fe42bb3022815e\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/kernelPageDeletionGuard.js\":\"abbfacc15352ece8\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/liveRuntime.js\":\"721a1c006a11eb4f\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/openExtensionsSettings.js\":\"543a680df4738f02\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/overridesCache.js\":\"9231dec98e1197d6\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/pluginIds.js\":\"afc2bc443692528f\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/processorRejectionToast.js\":\"b5262f609609c1d9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeActions.js\":\"44062469229156af\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/runtimeContext.js\":\"c73b3a82ca891754\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticAppExtensions.js\":\"fda32cab3bdb7714\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/staticDataExtensions.js\":\"da310346170356c9\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/toastAppMount.js\":\"27cf206b3db295e1\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useOverrides.js\":\"cceae12b13f9ac94\",\"/knowledge-medium/pr-preview/pr-1854/src/extensions/useShortcutSurfaceActivations.js\":\"f4b2653dfd90e4bc\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/discoverToggleTree.js\":\"2599bad5d4737f06\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/facet.js\":\"757e7ae90b806b6c\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/resolveAppRuntime.js\":\"7a8dc19d9ccf56c7\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/runtimeEvents.js\":\"670702b3dd3491cb\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/togglable.js\":\"3047d39feaea16bb\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/variantFacet.js\":\"11e56a1d73562801\",\"/knowledge-medium/pr-preview/pr-1854/src/facets/verbFacet.js\":\"cfed78d230fa74ff\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/block.js\":\"ec0df7122f1c08c7\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/focusedChild.js\":\"e3237e69c712183a\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/propertySchemas.js\":\"077b26894e0f48f4\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/typeRegistry.js\":\"f9ec8b5a0ed834d2\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAncestorCrumbs.js\":\"b08bc724b90db773\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useAutocompleteListbox.js\":\"826a3418c947f090\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedSearch.js\":\"66de641a6f5f8cee\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useDebouncedValue.js\":\"2659d5809901f099\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsFocalRender.js\":\"e47f52c7840dad35\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useIsReadOnly.js\":\"8b6c0a30e75b5d89\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMaterializeBacklog.js\":\"df9cc3403b451eb8\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useMinuteClock.js\":\"de042bfcc683ca85\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePanelLayoutProjection.js\":\"6534f9c1544deb71\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/usePendingInvitations.js\":\"02c5d22cebda09c7\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRendererRegistry.js\":\"b820f2cb82cbb9d9\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useRetainedFieldRows.js\":\"0e5d5a8e66d24f13\",\"/knowledge-medium/pr-preview/pr-1854/src/hooks/useWorkspaces.js\":\"d15d9eb42623787b\",\"/knowledge-medium/pr-preview/pr-1854/src/lib/utils.js\":\"401bd20a718e6a12\",\"/knowledge-medium/pr-preview/pr-1854/src/main.js\":\"04366316643ed41d\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/MarkdownImage.js\":\"e557dc96d7ec4cf6\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/blockSeparators.js\":\"d38c6415ce6e65b3\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/context.js\":\"0aa34df22ee458f2\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/defaultMarkdownExtension.js\":\"01999d16e313b1da\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/extensions.js\":\"a34f72e77c34c7d0\",\"/knowledge-medium/pr-preview/pr-1854/src/markdown/renderMarkdownHtml.js\":\"486aa035d174c24f\",\"/knowledge-medium/pr-preview/pr-1854/src/minimal-editor.js\":\"fa3575d3933e6dc6\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/armedCut.js\":\"ca685e59c2a78a22\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/captureMediaVerb.js\":\"1456953c4568d736\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/clipboard.js\":\"3df831cbf75bfc5a\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/decision.js\":\"df203977e001c048\",\"/knowledge-medium/pr-preview/pr-1854/src/paste/operations.js\":\"f571aa18ce4b3eb8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/AccountHeaderItem.js\":\"05cb3a8c22d9479a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/account-header/index.js\":\"13d6db34f909edd2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"26a824454f1b5059\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askAgent.js\":\"512f7c6ac36e90b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/askedStore.js\":\"693804d3efd97ec2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"735d9f62df2c6723\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/chipState.js\":\"09bc9d6980d3d3b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d3197f02038f0628\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/index.js\":\"cd6da6488ff1aaa1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3872f520d64ef711\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-dispatch-companion/schema.js\":\"d0a1000ee8fb7ceb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ea854dadbeb39bf9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5fbf851165f622a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/addMedia.js\":\"a11b9c9e863605c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/backlinks.js\":\"67f3930357fdc0bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/block.js\":\"50037f0c0866d1dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/context.js\":\"815a483d89b3aaf8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/displayIds.js\":\"75152adb1d80d5f3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/index.js\":\"534d089ded99bb8a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/outline.js\":\"a402fa62fa799ee6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/properties.js\":\"fc51e02a0aa19851\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/refs.js\":\"fa12973a5c5595c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"698590de008012a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/search.js\":\"110e4af837a5044e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/shared.js\":\"625fbd953ecc95d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"efe63aa0636ed03a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentViews/text.js\":\"875a1d6a53581f46\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/agentWrites.js\":\"bf016c8fbb80f442\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/authoringCatalog.js\":\"869632db39d25671\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/blockRefTargets.js\":\"f756bd25a94141ef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridge.js\":\"3948c743977180e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/bridgeLoop.js\":\"819d95424e40e6b7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/changeHistory.js\":\"c1747d3f7db75acb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commands.js\":\"114327259c99c33c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/commentsCommands.js\":\"179a999d710f2191\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataExtension.js\":\"68080d7a50fd4bf2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/dataModelGuide.js\":\"5059f7697c7db865\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/describeRuntime.js\":\"b01ad81cdeab4fd9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/extensionLint.js\":\"198b766096a823d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/grainAudit.js\":\"e44ad5910bd1c12f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/healthCommand.js\":\"13babd5a1ae89591\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/index.js\":\"1adbcf140cd9a4e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/presetIdentity.js\":\"be4512c8c4f9374c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a3955f955bb307be\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/readMedia.js\":\"6468310484860818\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/schema.js\":\"2f2e74388140a6ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/serialization.js\":\"be8094fb008c402d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/targets.js\":\"bee6305ff35f672f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/tokens.js\":\"81c45122a877f51a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/watchEvents.js\":\"17992dfee4a0e839\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/workspaceGuard.js\":\"1f866e188d30b5b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/agent-runtime/writeCommands.js\":\"c8df76fd4d174608\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/AliasCollisionToast.js\":\"09aa1c8d4f9478f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/DuplicateNameBanner.js\":\"140a7610d7ad01b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/collisionMerge.js\":\"a041ec8775720816\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/dataExtension.js\":\"88d857ccdb96ee39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/index.js\":\"fae09e18b7f68f71\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/mergeCollisionAction.js\":\"2d7b080d329e65b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/pageStyling.js\":\"105b8b8a5a712cbf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/rejectionToast.js\":\"3156336b11ef3bab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/alias/syncProcessor.js\":\"7f7477a5110a3ae1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/actions.js\":\"43ecad8c39ad30e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/addComment.js\":\"73ddb6a66b928498\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchor.js\":\"fc244680244986c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/anchorState.js\":\"456f54e85c5f46e2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/commentLinks.js\":\"d743041f95071d73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/confirmThreadDeletion.js\":\"d1f75a597d7a0aa6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/container.js\":\"86419cf2b32a099e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/dataExtension.js\":\"ec00f9a9ab2de479\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/deleteComment.js\":\"00d9d103dc13639c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/highlights.js\":\"a3135371018ac1a7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/index.js\":\"078f4705afd03875\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/linkedCommentsPill.js\":\"68213b0c9718f053\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/margin.js\":\"ac8b53dacd800602\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/marginSchema.js\":\"ccb9a1f613d4eaef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/newComment.js\":\"075f4ab72fbf1bef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ownThreadPicker.js\":\"c66a759163c32f22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/placement.js\":\"c8139577a56eb6ce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/queries.js\":\"6d475fb6961c0934\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotePosition.js\":\"76109814af0b61ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedIn.js\":\"68840546e14b5d78\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/quotedRange.js\":\"7af77ceb57fa1a1a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/rangeRefs.js\":\"7622f5c1e4451143\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readHighlights.js\":\"845be9f77cf95bcb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelection.js\":\"b14148ad4439ad02\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/readSelectionUi.js\":\"6ff3d65f66251d22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/reanchor.js\":\"ba5d5ef4f867ea69\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/schema.js\":\"3648efef2603ab3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scope.js\":\"3c08a270f05cffb1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/scopeThreads.js\":\"2e235970f3dbcf75\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/splitRetarget.js\":\"8f1ce1a9ee1620e6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestionCard.js\":\"88a0ff7fbcd1db4c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/suggestions.js\":\"7ad7f66fc34feb0c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaries.js\":\"d47b368d93147257\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/summaryBatch.js\":\"e03fc9e0f0ba4e94\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/surface.js\":\"60ff14b6f05eaca4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threadNavigation.js\":\"4b894bb69cee7ac0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/threads.js\":\"24acce5c846b64fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/ui.js\":\"f4b866a1e6e9a4b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/annotations/uiStore.js\":\"50774bcfab77383b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/appIntents.js\":\"e6c926d8eb30283f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-intents/index.js\":\"9dae262111978fe5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/index.js\":\"8d63e9305b010f37\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/app-update-prompt/status.js\":\"4fd2012b10c900b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3dd22ba2668a9803\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaBlockRenderer.js\":\"020e03d2c0f4fad7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaDownLaneReplicator.js\":\"120e39314093e787\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/MediaUploadReconciler.js\":\"d7236758ce104443\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetDownLane.js\":\"23e8e9e437dcbe96\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetResolver.js\":\"33ac2b6e35e13b50\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/assetUpload.js\":\"6e4a86e46b25526b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/attachmentCleanerIO.js\":\"6ca6a97dd8517d88\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/supabaseAuditIO.js\":\"dddc94e6b11c7b47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/blobStore.js\":\"9f46e38f712bfdc4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/byteStore.js\":\"9e1d5c3d01db237f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanerIO.js\":\"e05d44c7c8422dd0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/cleanupAttachments.js\":\"f4b4baf111a02d6d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/dataExtension.js\":\"43e6b0ffb6a48928\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/downLane.js\":\"fbfae8483a57d119\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/index.js\":\"ee37854ba9debe0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/insertImageContribution.js\":\"6a61d7d5428562c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneArming.js\":\"9782e137d34c1240\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/laneLock.js\":\"fb5b5219867ee007\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaBlock.js\":\"83bf9b51a5d4ea0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaCapture.js\":\"fa839623539d3d2f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaLanes.js\":\"4b7519bda33be193\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewers.js\":\"bfdca29f97d11496\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/mediaViewersFacet.js\":\"c55b3ac1593eaf5a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/pasteCapture.js\":\"9844486bb59f99f8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/resolver.js\":\"b227381d1a679c5b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/retryUploadsAction.js\":\"3f297b9586de479f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/storagePaths.js\":\"1ff37716d1b020c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadDrain.js\":\"783bb3e3ddbe41df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadLaneStatus.js\":\"fb58c4dd871b9ac5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadReconcile.js\":\"6880af8fa8a01ae2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadRecovery.js\":\"e3b5e83714e328c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/uploadStore.js\":\"3bc5e5d0d43f93db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/attachments/useAssetObjectUrl.js\":\"e5d8a8424fa2f5db\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"afbf417f9079a254\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/BacklinksViewSection.js\":\"eff1ef068522d9d9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/facet.js\":\"1977cbb796198503\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/index.js\":\"a01f7d8f11aba140\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks-view/prop.js\":\"1b10ab7829a580b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinkFilters.js\":\"46624365fef7d395\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"38763456759f4c53\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/BlockEntry.js\":\"b871d35f1e5d7e6e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/LinkedReferences.js\":\"8d7264714c04164d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"194afa098b8f0fe8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dailyNoteDefaults.js\":\"632428ab5097a207\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/dataExtension.js\":\"c346433c2ea9d2eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/edgeExclusions.js\":\"15e616d74043a723\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/filterProperty.js\":\"ede39c99ca981a8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/index.js\":\"9619c78d8909f524\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3cad580ed1694ae2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/applies.js\":\"b1f832d15cc4360b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/countQuery.js\":\"461ac4a178601cb0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2730db4ff67d3e80\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/index.js\":\"4865c179697767d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c3109c0db5b59bb0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/presentationInvalidation.js\":\"fb25fa75275e5da7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyEditorOverride.js\":\"18d78f73534df66d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/propertyFilter.js\":\"1f010726c4f936a8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/query.js\":\"77b00475e2ec6231\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/resolveFilter.js\":\"fdc926789ccc7894\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sourceBatch.js\":\"5321bd1ba29a2a1e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/sources.js\":\"210ccfc9b9424238\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useBacklinks.js\":\"c63db2eaa7a2f263\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"28ddc8a61ca75e5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayCelebration.js\":\"b8d7fc249e9d1edc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/BirthdayOverlay.js\":\"10367d4fcce852ec\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/gate.js\":\"5b0c1142690b8664\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/index.js\":\"c16d196f01a78dfe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/birthday/wolfTheme.js\":\"0695b161640e97a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/BlockDragLayer.js\":\"ab62e4f32957bf44\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dragController.js\":\"e890142165007f8a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/dropTarget.js\":\"890b966f74eb2830\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/index.js\":\"6da055831d849515\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-drag/projection.js\":\"93659243a1fa6e01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/BlockMetaCard.js\":\"2007a2530c58c4b7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-info/index.js\":\"fb46ea5d50f1688e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/AddTagDialog.js\":\"29dc958886a27784\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"dcd868e851713067\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/TagNameIssueHint.js\":\"1514a189ba995b1b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/addTagAction.js\":\"2f0b5f8d41dd32aa\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/appendTag.js\":\"3e46a88b8c3f1634\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/config.js\":\"c39c7dcf6da9fe2f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/dataExtension.js\":\"0884fc1375818e5d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/index.js\":\"053fdc881560537f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/block-tagging/propertyEditorOverride.js\":\"5f3d3054448b8eaf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6172feff0d433c15\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"33fd4480c9a9b12b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6332c835ce9d003f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1685ce3075baf7b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"359ea58427d10159\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/index.js\":\"c64946524fd47cb1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"19aecea823d97a54\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/CharacterCountItem.js\":\"da8b130125931579\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7852e0678afadc1c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/actions.js\":\"323ec4d15dc9c376\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/blockType.js\":\"da31ffcc9b72aad3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/charCount.js\":\"e94a4391b3294b12\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/dataExtension.js\":\"df27e8266d15e38a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/index.js\":\"7c4f1512c69396a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/profiles.js\":\"cfcb0f56d69e29a7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/properties.js\":\"b5ba3a271d05ccd3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/character-counter/textCounts.js\":\"1723088f06a56770\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/colemak-keybindings/index.js\":\"fcabe3abef912f0f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/CommandPalette.js\":\"84af7d12095b4247\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/HeaderItem.js\":\"b64cd7177bbeb4de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/context.js\":\"3458ed23f4399c9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/index.js\":\"d6442df35fc41cc0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/selection.js\":\"6e36a58315dd2a5f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/toggleStore.js\":\"ca48872626ff5221\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/command-palette/useCommandPaletteActions.js\":\"c42231269c0c684c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/ContributorBadges.js\":\"a7307e58ec6960d8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/author.js\":\"3e7ec34cee5593de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/codeMirrorExtensions.js\":\"39f6d0f8e3d370bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/dataExtension.js\":\"0fb1403f78e697af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/index.js\":\"84ede119719aa399\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/mentionAutocomplete.js\":\"c22b9339a4e0d876\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/processor.js\":\"a1190d073ac70442\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/profiles.js\":\"ce3be77fd94e8bb8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/queries.js\":\"38154e74ce62f7a6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/contributors/schema.js\":\"25230d8eac366980\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7814cc783cbeaefd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5d5770423a475893\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/index.js\":\"10b7f22a20cf4a14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"429cdf40e5c53aa7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6294928bed8d7eeb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/CalendarGrid.js\":\"5e3f12106bc3864e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DailyNotePicker.js\":\"cd61f36c3c3b7130\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fc5b579a760e7b3d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateNavDecorator.js\":\"fd97786b16c3d124\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/DateScrubOverlay.js\":\"999df8abba54f0a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/HeaderItem.js\":\"75c853ecb8fd193f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/ReschedulePicker.js\":\"27bccf3a6d44e346\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/SpreadDatesDialog.js\":\"48c7df486533135d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/actions.js\":\"89f58c58516777ba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/blockDateAdapter.js\":\"3b4315a12d9b9e6f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/calendar.js\":\"d965e6f5ab035323\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dailyNotes.js\":\"b02e5950680a5b78\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dataExtension.js\":\"907a15922fecac96\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubActions.js\":\"885aa23e9cfd88cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGesture.js\":\"e53d3a1a7468d04b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubGestureActions.js\":\"38e25374420d29bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dateScrubRecognizer.js\":\"23a68c462a10c55a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/deletionGuard.js\":\"411119921deff207\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/dueQuery.js\":\"5e54c5f37a83ac8a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/index.js\":\"a9baf4c00eae625e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/landing.js\":\"79caf95ac8d21498\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/localSchema.js\":\"b88f34c250cab3df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/referenceDateAdapter.js\":\"9820c7f648202164\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/rescheduleAction.js\":\"c6058db14ff765e4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/schema.js\":\"108f0d3a737c65ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadBlockDates.js\":\"2c9f5af4f986a330\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/spreadDatesAction.js\":\"30013942984a90eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/today.js\":\"6778aba363b4a9b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2a652386cfd57963\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"02946fc6ab7a0cd1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/audit.js\":\"93c03c94e4637d82\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditAction.js\":\"f7c7a79546a3699d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/auditRanges.js\":\"d53ac7e45b422903\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/diagnosticsSource.js\":\"c72fa09863d01cbe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/divergenceScan.js\":\"71d8dd35c253d97c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/index.js\":\"59118b9e4a5890b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f18d5be550809e23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/referencesMirror.js\":\"fb7e73c22dbd40bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/rowJson.js\":\"b8845882a6a9a33f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/schedule.js\":\"ef738d3d8d0c7993\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/data-integrity/store.js\":\"160c2017f3d8f84b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/action.js\":\"0491950999ac05b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/index.js\":\"4b18dbbd46d60142\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-maintenance/plugin.js\":\"b8cf1312973d6eb1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"07aa91b586a11ad6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/actions.js\":\"878339fbf7b2c420\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/changeMarker.js\":\"3dc2f2c6492de7bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/diagnostics.js\":\"8ab8bca8703a33eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/fileSystemAccess.js\":\"00edbfc5aff95c7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/filenames.js\":\"e1c174f554d66a32\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/index.js\":\"f8f3a854cb980cd9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/mirror.js\":\"b8330387b5e7a202\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runLock.js\":\"d28dbbf33f0823bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/runtimeHealth.js\":\"9285d58fab265407\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/schedule.js\":\"5d86346b0dbaaf0d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/db-mirror/store.js\":\"a8e0634d38cd8b5f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/index.js\":\"74de89cc26c97ff5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/default-themes/themes.js\":\"facf70fee1fb25ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/facet.js\":\"7c7e05d067a0defd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/diagnostics/useDiagnostics.js\":\"540338845defda06\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/dismissals.js\":\"52570626c2b90242\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/index.js\":\"123b732504d563cf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/status.js\":\"1ec2d741c5201ea3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extension-prompts/store.js\":\"9b911dbdc0eb8b0b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d598e35a46716245\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/ExtensionsSettings.js\":\"868232e40fcbdc49\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/actions.js\":\"e33ff9a8135298c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/config.js\":\"502797e7fb1fcb42\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/dataExtension.js\":\"5c8a4e08525076c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/effect.js\":\"9a3759b9a2b89fbc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/index.js\":\"7cd10907e7cd4aa6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/propertyEditorOverride.js\":\"23dbea0cc6275bd3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extensions-settings/useToggleTree.js\":\"189ffdd68649f74e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/ExtractTypeDialog.js\":\"edffddae24ed2644\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ff2c488be67501ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/PropertyShapePicker.js\":\"ce3b142923fc1274\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/action.js\":\"1fc3ac7c29b4ba55\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/extract-type/index.js\":\"f0855204e441ff3c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/FindReplaceDialog.js\":\"a2be31dc403d40e9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/HeaderItem.js\":\"5d715234662397f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/dataExtension.js\":\"2f6cae3bc0215e23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/index.js\":\"b95f611b54ce0855\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/search.js\":\"e6eb5260378cbbda\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/toggleStore.js\":\"cbfd874d3b430363\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/LocationPropertyEditor.js\":\"0a6a9d743c94cf47\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/MapView.js\":\"16e2c1491f2b1061\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/blockTypes.js\":\"7908dde738fd3c85\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/codeMirrorExtensions.js\":\"fa5be85c783022a5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/createOrFindPlace.js\":\"327c217cb83b3807\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/currentLocation.js\":\"f27fbc26ac966989\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/dataExtension.js\":\"fc22b77cb361fc60\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/geoContentDecorator.js\":\"0c22b1393f9ad62b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/googlePlacesClient.js\":\"7125cd5607bea8d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/index.js\":\"92bf4c5f0b8e3aa9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/locationsPage.js\":\"b2c00f504a5f9f56\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/mapViewport.js\":\"5297b310cc2cfc84\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/pickCurrentLocation.js\":\"8d9407d48be96394\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeAutocomplete.js\":\"9cc81cf7df90f3fc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/placeNameCollision.js\":\"7854e4ac3539e56f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/properties.js\":\"8be59624831bf62f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/propertyEditorOverrides.js\":\"8e37451b95ee17e1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/query.js\":\"d64516be4b6e49b6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/geo/usePlaceSearch.js\":\"cc6a10548cbbbe8e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"daa67d93d5d56070\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"46ec47fb8e76ef89\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c772f0c573eaa6bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/config.js\":\"ba0791817c65985c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/dataExtension.js\":\"177b0b32378f7050\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/facet.js\":\"7f4f11fa4c40c4cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/grouping.js\":\"bd78634a893a3e01\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/index.js\":\"075d22eed3ac90d2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5606b6cc781a98cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/query.js\":\"fb02703b61452dda\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/resolveConfig.js\":\"5daf94c7f0145c0e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f1f76094922f5405\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"847608c4f0bfcf61\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlDocumentContent.js\":\"c3c4870364d173af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/HtmlFrame.js\":\"5b0ef07a8703386c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/actions.js\":\"ae21e615b09b71de\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/blockType.js\":\"21ff02fab190e073\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/confirmRunScripts.js\":\"1791da2cf6d6dcd1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/dataExtension.js\":\"cc503725b40b4bfe\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameAnnotations.js\":\"3362dc8df4e78bb6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameDocument.js\":\"983f6028c455b08b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/frameTheme.js\":\"d2df1ca7f1ceb325\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/index.js\":\"82f465ccf21a0652\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/scriptConsent.js\":\"22c39eb06b5614cd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/sourceMap.js\":\"c8223d4fa268ab0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/html-document/useDocumentScripts.js\":\"90a71e58a1f7bcd3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/index.js\":\"71313215eea7570e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/record.js\":\"a498021cc4cf9954\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/recordStore.js\":\"3512530372262995\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/responsiveness.js\":\"eaf6d41e6648d819\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/schedule.js\":\"3a8607c3e597ae05\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/interaction-metrics/sessionContext.js\":\"c1f33ea278fb63d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2597b4d739817c0a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5e999ff8a5df666b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/actions.js\":\"60f5768c0b1cacf3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/config.js\":\"71010342f840c8d4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/dataExtension.js\":\"47efca4872360ee7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/effect.js\":\"8908d2bfc6da64f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/index.js\":\"de29dee61a44b15f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/keyCapture.js\":\"6901aa9e62260011\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/overrideStore.js\":\"e6c2c1d9ac956d39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6629d927b3fe5992\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/HeaderItem.js\":\"ccc5d67282d0efbc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/LeftSidebar.js\":\"170773757af0181c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/actions.js\":\"7c2c8b6b31c4acfd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/facet.js\":\"f1c3de3a9109b5bc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/index.js\":\"a7f971771f98df12\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/shortcuts.js\":\"83a5aed34505784d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/left-sidebar/toggleStore.js\":\"01f1096ad882e7ea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/MergePicker.js\":\"ce2f1a96b1f7ea72\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/index.js\":\"2eacba8cb5fadd22\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/mergeAction.js\":\"eb1910338eae43df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/merge-blocks/strategy.js\":\"567e66b7c292b0ff\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/Button.js\":\"b473d9e84f39d7f6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5e26de9d7861441d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/defaultItems.js\":\"660b3a3798b4549c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/facet.js\":\"20b0b4344f2370af\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-bottom-nav/index.js\":\"ebd6ac0f24bdf99f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6bef8a40b96b29bf\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d795a218f8b651ae\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9ff840e6994bca3a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/facet.js\":\"89b350fcb2d5e390\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/mobile-keyboard-toolbar/index.js\":\"82103ef05a2f9745\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d1f32807a3c67497\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9d26000575943268\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/contextMenuItem.js\":\"3155d4d5839e80dc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/index.js\":\"1aab81a39d92db32\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveAction.js\":\"b8a9b67ba37f8ec7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/moveBlocks.js\":\"e7065ea0791e47d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/move-blocks/selectionAfterMove.js\":\"c3f9916bea5d48b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/TutorialBanner.js\":\"de38b0cf336a6957\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/action.js\":\"d738407d8a9f6416\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/bannerDismissal.js\":\"9ab662b0b183463f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/documents/cheatSheet.js\":\"56e56767e3b8a99b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/index.js\":\"f2468f4813aebede\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/keys.js\":\"94d076b60ab4205f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/landing.js\":\"f405db1898be27d8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/outline.js\":\"12b7b3be76486e1f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/onboarding/seed.js\":\"8688ef01b9b37487\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/PerfTrendDialog.js\":\"50fa715fb9ad578f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/analyze.js\":\"2179b6d8bae410e3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/diagnosticsSource.js\":\"c55c392c0ccb8962\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/index.js\":\"8c3e9f14df3273a3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/load.js\":\"83d65747c84313d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/monitorRun.js\":\"33cd2f569267ff03\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/schedule.js\":\"d9dda5e280ad244f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/series.js\":\"ba7500323edc901e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/store.js\":\"be4bee092b89bc34\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/trendAction.js\":\"5fea1dfbc60dd92a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/perf-monitor/verdict.js\":\"8ee27ca52e40ad14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/clickToEditAction.js\":\"89ac565a654ee4cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/index.js\":\"96f79224caf2d7e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/plain-outliner/interactions.js\":\"0e5f3c25fa8d8504\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"68305ea75c2fbe19\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGate.js\":\"fb50d62b66bb6056\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/MigrationGateDialog.js\":\"532a3884da6ba36c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/action.js\":\"836b67939a6e7474\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/index.js\":\"ff069169b638537c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/localRunMessage.js\":\"54ca6cebf723b5c4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/plugin.js\":\"d8db292149837fe2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/progressReport.js\":\"c421fb12477e7e65\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/properties-migration/sweepProgress.js\":\"c91296e9bddc68f1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/FieldRowRenderer.js\":\"cd84c70f28144569\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/ValueRowRenderer.js\":\"b9b08e9f95dfbdd1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/actions.js\":\"a96b3f488bd63ec1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/autocomplete.js\":\"ac0372ed8a8b3960\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/fieldRow.js\":\"c9115782caca2828\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/index.js\":\"fb2461232354485d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/referenceWarning.js\":\"1383059da48aa724\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueAutocomplete.js\":\"c572e003ac37e6ed\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/property-rows/valueSchema.js\":\"4da1e59d68bce7ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/HeaderItem.js\":\"f2d20c814e710d9e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/QuickFind.js\":\"b984f9dce85599ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/index.js\":\"47251ba435fa6bce\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/recents.js\":\"b6e8eb587b2980a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/resultItems.js\":\"7ff1850e5833903d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/selection.js\":\"10bf863d973724c5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/quick-find/toggleStore.js\":\"48144ba0caddf5e9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/HeaderItem.js\":\"abe9e97f61c92531\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/RecentsPageBlockRenderer.js\":\"51b63f2110e4009b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/grouping.js\":\"cbf145bb2ad53cef\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/index.js\":\"19f5298f0cffa983\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/recents/target.js\":\"e1f4f26e54ea449f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/codeMirrorExtensions.js\":\"b8d861bbdefb6c30\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/contentPrefill.js\":\"a80c2a34bd8c3089\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/dataExtension.js\":\"8460bd499e4ce249\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/index.js\":\"075b71a0dff7e568\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0a2beede1491b213\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/invalidation.js\":\"224d0cb1076616bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/localSchema.js\":\"8edc3b3c8044d571\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/index.js\":\"3d47bf6b616d328a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6c32e90bee2a419c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/index.js\":\"786120492aad395f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/referenceNode.js\":\"d0616afe1b61e2f1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d84cdfbeaeb9a31f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"aaca48a06c03fef5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/index.js\":\"474f85b55d631062\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"578d6191f3249cc8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"96d5c865845d3d5c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/mergeRetargetProcessor.js\":\"e6251f1e597fb2eb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/parseFence.js\":\"34d49ebf5a7257b9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceParser.js\":\"366d311b8d7d7939\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referenceProjection.js\":\"ef2b7b25e310f252\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/referencesProcessor.js\":\"0c6346f4eb30c228\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/renameProcessor.js\":\"4b701b98bb0cbd04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/references/spanReplacement.js\":\"fc199651355b2ae1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/htmlToOutline.js\":\"97ed24c1196f0712\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/index.js\":\"2b38aa0cc5686a7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ae6c77609ff8bd18\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/rich-paste/pasteDecision.js\":\"ebb7eea607f24133\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/action.js\":\"2d5cff284233a1bd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/blockIds.js\":\"dfdb305f242efcea\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/content.js\":\"99a7722299125dcb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/effect.js\":\"6240266c99dbb669\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/ids.js\":\"0a3e7f1e26bbb2f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/import.js\":\"8496998f87d54d77\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/index.js\":\"eb273433ce4c4c50\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plan.js\":\"3bbf5a1b80b4966d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/plugin.js\":\"e15be4fa4b2a82ad\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/promotion.js\":\"fa4128311e26f14d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/properties.js\":\"33d537670e9224d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/references.js\":\"8331fbfb991f831b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/report.js\":\"3306b3027fddd0da\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/roamMemo.js\":\"ab8949fae3576134\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/runtime.js\":\"4c563e7e1b44ecba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/schemaReconciliation.js\":\"6f9151cfc5fd27cc\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/srsMarkers.js\":\"4cd1469f001e885d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/todo.js\":\"bcdcc3c4c88d2ec4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/typeCandidates.js\":\"7c1d36695bf23e36\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/roam-import/types.js\":\"96554c6e366e6c3b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/index.js\":\"5c91bc9907ce34e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/search-health/store.js\":\"083f113a73b7bb23\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/HeaderItem.js\":\"94b2d66b5b7634a2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"36a92bf412afc897\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/index.js\":\"269ebeebf65cec15\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/model.js\":\"355dccf09755b44e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/toggleStore.js\":\"8be0492e2e0c08c2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/shortcut-help/useKeyInspector.js\":\"cb1ef24070da5311\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"67c8a2dfeec7c6f4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/ShellDecorator.js\":\"1ceb4c0fd5232800\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/actions.js\":\"bb63160e7db32034\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2e201c061e8cafd5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/index.js\":\"6d9fdb3b8b395411\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/shell.js\":\"4d02767e536d9b6e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/surface.js\":\"b32b7877a4621cc4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/spatial-navigation/walker.js\":\"10dcd5cd3f56e222\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a5c48eb1dd375255\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/dataExtension.js\":\"f3e1535fe2ce5015\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/index.js\":\"173520c0a74a5f3b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/indicator.js\":\"bf91aa387c878f3f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/moveSrsState.js\":\"196d018f13e04b72\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5ffa1debf8166f45\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/scheduler.js\":\"202b594ae8559dd7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/schema.js\":\"d09ce3dca79deb9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"fbd1814851d0b34d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/srsClipboard.js\":\"225aba9778397b34\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"db64fa397e3ca1b4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d1d993a7945704b8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/DeckPicker.js\":\"6a1bfdb95115c2bb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewControls.js\":\"d1363088ca7318b2\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewDeckRenderer.js\":\"836acd404c936c9a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/ReviewSession.js\":\"b382f64a53d15678\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/actions.js\":\"d62c274a5a5ed4ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/archive.js\":\"87450cf492396434\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dataExtension.js\":\"0b355baf0ee507c9\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/deck.js\":\"f71aef0bbb9adbe7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/dueQuery.js\":\"a4bb833f15116f29\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/gradeDecision.js\":\"c9a514bfe0002021\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/index.js\":\"194bbe5007392c39\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/keyHints.js\":\"e48b010f3de7a1b3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewCardLayout.js\":\"e8516db2119bbb2e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/reviewProgress.js\":\"a7bf05f05c96e329\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/schema.js\":\"c57ec2d091fb7988\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/srs-review/useDueCards.js\":\"ca043b09b3c32385\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/index.js\":\"82a23c80b166b96b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/startup-metrics/record.js\":\"26b5e4eaff5e8cb8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/index.js\":\"abe98a8012130e7c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/persistenceStatus.js\":\"72fc16b3ba5feead\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/storage-persistence/requestAction.js\":\"e90e7054e1ce129d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/TypeChipsDecorator.js\":\"9ed5dffc602b51a3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/codeMirrorExtensions.js\":\"ff592a15ed5f271d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/index.js\":\"dbee77ee6960cf2f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/supertags/typeAutocomplete.js\":\"79be46d1b22f21d6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8b1cdf28a0d169e0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/actions.js\":\"69df50f857e0cfd3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/anchor.js\":\"7c9aeb8552ff19c3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/events.js\":\"28e1ea813dcaa88b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/gestureActions.js\":\"fac14d3abf8592ee\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/index.js\":\"827db99556c06919\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6e9517c05a12673f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/collect.js\":\"3880e0daf57b9c73\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/index.js\":\"765be662d2ff19d0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/sync-metrics/record.js\":\"be4f2a9fc2e0ad06\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/RejectionDialog.js\":\"59a6bc7dd40a25df\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c5778b747939f5c0\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/index.js\":\"b10e2bc2bd6602ab\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/model.js\":\"670ff89d41c269e5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/queueCounts.js\":\"b7b12519b11d2b12\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rejectedHelpers.js\":\"1f56fd68b607f87f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/rematerializeAction.js\":\"5c9746cfe6bdbeb7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/system-status/useHysteresis.js\":\"cbe40b971c9c851c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/ColumnHeaders.js\":\"03f273101d0db9ca\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/QueryUi.js\":\"b70cac9523bbaf98\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/TableLayout.js\":\"b5fa76a38d58b0fd\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/actions.js\":\"bc5f77323d73e1d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/cellEdits.js\":\"6ccd320d99ba6970\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/columns.js\":\"e94a02b59e973ec6\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/controller.js\":\"d0c3fa9593fb19ac\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/convert.js\":\"4724d321ce1a5350\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/dataExtension.js\":\"0c6e2293fafb974f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/index.js\":\"013dd16a2f9db012\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/keys.js\":\"a2edd3595b655ceb\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/model.js\":\"443d6b7cd2d89305\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/navigation.js\":\"3d93ad62e1e07408\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/backfill.js\":\"18d3eda95877e041\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/completion.js\":\"9be0daad97b5aa27\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/format.js\":\"87f83cfebab625b5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/parse.js\":\"5b45d209f0c1fff5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/queryValue.js\":\"0f502dac92fcd946\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/query/source.js\":\"d0d245a51aba3b50\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/registry.js\":\"312cfcde1aa058f5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowGutter.js\":\"1411755cba2a6b31\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/rowVerbs.js\":\"cf7c2ea7b8768e29\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/schema.js\":\"1858ca092e79dc8f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/tables/sort.js\":\"4445fa8bf656803b\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/effect.js\":\"cb9b6b225fab069f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/index.js\":\"13a3d777d7db5e12\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/theme-toggle/theme.js\":\"c4b64148cc8d55e8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/actions.js\":\"a360c0a4c76b8249\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/dataExtension.js\":\"365303787a77bc32\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/index.js\":\"56f6cc7b79afb122\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/todo/schema.js\":\"8c313db070ea5c56\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ce778fa764bc20d7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/actions.js\":\"e842ebbd5131e0a3\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/defaultItems.js\":\"b067ce4c1da79dba\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/facet.js\":\"9e2d81cc4b394bf4\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/holdRecognizer.js\":\"3715eaf1dc7895d8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/touch-selection/index.js\":\"3d52e5f746197f3e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/UpdateIndicator.js\":\"227bf3c6f87b6c14\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/index.js\":\"3b2fa8c822e49c04\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/update-indicator/loadTimes.js\":\"aa9dd3e5040fc80a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoNotesRenderer.js\":\"6ce7e39ccc1bdd3e\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoPlayerRenderer.js\":\"8cb9cc9bdcb1c378\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/VideoTimeStamp.js\":\"3c8baf28369aa45a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/actions.js\":\"896e4f23d640142c\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/index.js\":\"05463d2e8b2c5946\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/markdown.js\":\"f4f37e78d50d9f34\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/notes.js\":\"339ee40d17ddb73f\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/registry.js\":\"532f4cac0ddc46a7\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/remark-timestamps.js\":\"a4eb40bf66107f76\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/video-player/view.js\":\"5a3eb2d1c9d655b1\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/LinkHints.js\":\"5e76fa4dc10aecf8\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/index.js\":\"270fbf65f1d47209\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/model.js\":\"2113f33330de272a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-link-hints/settings.js\":\"fa14c64c7b7d8a8a\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/actions.js\":\"6b1334ac21e87c74\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/index.js\":\"8e3ebc5978f890d5\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/vim-normal-mode/interactions.js\":\"62ba54b4db9fb52d\",\"/knowledge-medium/pr-preview/pr-1854/src/plugins/workspace-header/index.js\":\"84d2c21deb517d56\",\"/knowledge-medium/pr-preview/pr-1854/src/registerServiceWorker.js\":\"c1b260376caee856\",\"/knowledge-medium/pr-preview/pr-1854/src/requestPersistentStorage.js\":\"2afef3ff79c843af\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authRequestDeadline.js\":\"b26146ad619485fa\",\"/knowledge-medium/pr-preview/pr-1854/src/services/authStorage.js\":\"0a75b9205d3c8b53\",\"/knowledge-medium/pr-preview/pr-1854/src/services/powersync.js\":\"83bb1ad65c9ad8a5\",\"/knowledge-medium/pr-preview/pr-1854/src/services/supabase.js\":\"88707dc271d74143\",\"/knowledge-medium/pr-preview/pr-1854/src/services/uploadErrorClassifier.js\":\"bdbbd9483b69b7ad\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/ActiveContexts.js\":\"62445211fdcc529b\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/HotkeyReconciler.js\":\"823e1847810c5627\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/WipeLocalDataDialog.js\":\"711dbeb21266db75\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionDispatch.js\":\"ece5c609706c7637\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/actionRefItems.js\":\"24044dd643ec4307\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/applyKeybindingOverrides.js\":\"e7b71a8696b7a6ad\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockActions.js\":\"965cfa6f93e409b1\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/blockMergeGesture.js\":\"9c370aa1391abefc\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/canonicalizeChord.js\":\"b8db58bc67e11ec3\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultContexts.js\":\"3dfcf4f660b1e3be\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/defaultShortcuts.js\":\"9dfa84f9e03fadb4\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/effectiveActions.js\":\"b861412be1bfc96b\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureAction.js\":\"9aea24555669d585\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/gestureBinding.js\":\"99f937bcec2f4dad\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/holdRegistry.js\":\"931f1d7b4537e47a\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingConflicts.js\":\"dec6ed4b5dc3d85f\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/keybindingOverrides.js\":\"7d320c0a9ae149fc\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/pointerAction.js\":\"228ba370e2fdb913\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/resolve.js\":\"478220c9258db814\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/runAction.js\":\"7462513309ef5bfa\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/sequenceMatcher.js\":\"c0731a6b7507757e\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/types.js\":\"5eacd7a95814da84\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionContext.js\":\"150b0faf4fb59c57\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/useActionDiscovery.js\":\"83413cfe7fa1e52e\",\"/knowledge-medium/pr-preview/pr-1854/src/shortcuts/utils.js\":\"50bc5251fb629e6e\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/bootStore.js\":\"ff6e84a4e5907a66\",\"/knowledge-medium/pr-preview/pr-1854/src/sw/previewDatabases.js\":\"f8a0081ff422b1dd\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/byteTransform.js\":\"895feab43b8f94fc\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/attachmentCleaner.js\":\"f42844cd55a4c86e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/attachmentParts.js\":\"93f0a45a5487231f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleParts.js\":\"deee1d107d99984b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/bundleRecord.js\":\"25aeb36090e82b05\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/manifest.js\":\"fac27f6aa1baf7bb\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/takeBundle.js\":\"2970213e54577b66\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/bundle/verifyBundle.js\":\"f68d21bed2e56cbc\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/cleaningStage.js\":\"adc3a3a1ec64c894\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionKey.js\":\"7ceecb2469274c6a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/conversionServer.js\":\"cbf2064bc225c986\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flip.js\":\"a8769f27e518b7e8\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/flipAttempts.js\":\"cb922bebfb1b1f5f\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/pages.js\":\"242e3ea66e823e9c\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/preflight.js\":\"0a18b05c0ebae526\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/reseal.js\":\"74172ce5e912112b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runConversion.js\":\"0e33a4705940f442\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/runLock.js\":\"be92e90f885f6503\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealing.js\":\"48de135048a32fdf\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/sealingStage.js\":\"d41eb9f6f054129a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/stage.js\":\"792802521835f88b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/conversion/verifyReseal.js\":\"10b1f673c8882edc\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aad.js\":\"5dd66870de7daca7\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/aead.js\":\"a0439d439196f9c9\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base32.js\":\"1850cd624b05516d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/base64url.js\":\"1a42ee561dfccefc\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/binaryEnvelope.js\":\"a9c32b2f6728f661\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/byteAead.js\":\"8cdca64261eae35e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/canary.js\":\"307db47532939597\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentHash.js\":\"b344a01eb185994d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/contentKey.js\":\"dd4d4dc2affa715c\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/derivedIdNamespace.js\":\"63b4d2d46c5a568e\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/envelope.js\":\"696e0994825bbf10\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/hex.js\":\"8da5dc8614223f33\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/sha256Hex.js\":\"02f3274367d6176a\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/crypto/workspaceKey.js\":\"955906bfc2d80d09\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/conversionState.js\":\"2a7128461ce71b58\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b91fa855470246d9\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/pastedKey.js\":\"d018efc4f1cce312\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a15b7754e937897d\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4729c9f7aac46bf5\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/keyStore.js\":\"91a4b5100e64d5a6\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/mintWorkspaceKey.js\":\"46be4d8e4663ad89\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/modePin.js\":\"fcca2eb3b5b0b017\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/openWorkspaceKeys.js\":\"07486566aff1844b\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolveWorkspaceEntry.js\":\"d9f1a84547be49c7\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/resolver.js\":\"91ac67e3c2139151\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/keys/workspaceAccess.js\":\"19a7ecb27d455f36\",\"/knowledge-medium/pr-preview/pr-1854/src/sync/transform.js\":\"77fcccd86bee6ccd\",\"/knowledge-medium/pr-preview/pr-1854/src/themeBootDefaults.js\":\"1b5e1defda548ea6\",\"/knowledge-medium/pr-preview/pr-1854/src/types.js\":\"1a309e27c043f537\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/ClientLocalSettings.js\":\"d680a1e4d423c332\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/abortableSleep.js\":\"4e80f728c641932d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/array.js\":\"a30d37aad2128f96\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/backlinkAutocomplete.js\":\"d71ea236877f8ef6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockCrumbs.js\":\"5c6b42a31bad324e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/blockrefAutocomplete.js\":\"b724b5cfc9db5c97\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/cadencedIdleJob.js\":\"a2039503eb715050\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/callbackSet.js\":\"59c415d37f1cfee5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/clientId.js\":\"9364cce82773d714\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirror.js\":\"53c1b4f8bec9a9e8\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/codemirrorCompletion.js\":\"a058fb8a009c25a0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/copy.js\":\"3e97d3c557e8bb36\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dailyPage.js\":\"330ac1aae1f53bf9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensics.js\":\"3e7dfecc0b036027\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dbForensicsHooks.js\":\"63b516c79c6548ee\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/deleteBlockThroughUi.js\":\"55b148f4c8e2b20d\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dialogs.js\":\"9f7dc7d89a8a308e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/dom.js\":\"00dcbb4bedaec340\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/downloadBlob.js\":\"c3bf8b1b35c87470\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/exportSqliteDb.js\":\"e388ac52695b80a6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fileSystemAccess.js\":\"c0a4230a62efe026\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/flipSlide.js\":\"8e9abbcaac320087\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fnv1a.js\":\"d39dc9d4930535c4\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/formatBytes.js\":\"ea1ab83672fd7961\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/fuzzyRank.js\":\"a52147c68bf22b09\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idbKeyedStore.js\":\"f282df31f1082024\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/idleCallbackPolyfill.js\":\"2178355f3e6b2193\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardAwareScroll.js\":\"f5a87bd374c633f2\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/keyboardViewport.js\":\"39147c7afa5b6e02\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/lastWorkspace.js\":\"6f862f811a551418\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutColumns.js\":\"b9f4fd81a46d49a2\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionDom.js\":\"0090f7d87f02d7de\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/layoutSessionId.js\":\"88c485be592c455b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkClickGestures.js\":\"b01ca6e4e22de607\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/linkTargetAutocomplete.js\":\"01623e4241e3165a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbCorruption.js\":\"be6bbfc5b2b48e97\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/localDbRecovery.js\":\"d711fda1ab0bc256\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/markdownParser.js\":\"baa88c367b1dabd0\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/memoize.js\":\"2a21fb23c952a90e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameFieldCommit.js\":\"80b2aa925bbbb87e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/nameList.js\":\"e5e9249ab7cf53ba\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/navigation.js\":\"966db286ac8b9cac\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/omnilinerNamespace.js\":\"33c31ba52224d05b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/opfsPageScan.js\":\"d679ef4fefc86e68\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelClearance.js\":\"9cd02d0c49ba57fe\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelHistory.js\":\"8b62f7153fb41d2f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLanes.js\":\"b158ba6f4c98dff9\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelLayoutProjection.js\":\"f4121c0616010fd7\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelScrollAnchor.js\":\"d9a0e2774c31d8c6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/panelUrlFlags.js\":\"daac940eb0990f32\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/platform.js\":\"9ee79e12d258d517\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/pluralize.js\":\"8fb3b8aed7914257\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyCreation.js\":\"a2868debb4a052bd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyNavigation.js\":\"05a8880174e56d7a\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/propertyValueContext.js\":\"0870d6d62119f248\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/react.js\":\"2c0d6fdc771c6fef\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeDate.js\":\"e1643e75c0ce6e0e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/relativeTime.js\":\"48b13d3a0ea8383b\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/renderScope.js\":\"d1495c37fc0ffe5e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/resolvedThenable.js\":\"a97a799442a50ffd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/routing.js\":\"c24be4e77fa5c7ae\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/safeMode.js\":\"5d759ca2392d5110\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/scheduleIdle.js\":\"0b7c4ddf25584f47\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/screenWakeLock.js\":\"abc9128908832225\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/selection.js\":\"8c4f4206fb75aba5\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/softKeyboardGrab.js\":\"df69f86b136ee1bd\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/startupTimeline.js\":\"cbef34478a6a887f\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/state.js\":\"bd1fab88b7fc6b4e\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/string.js\":\"30f0299d71e69c48\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/surfaceZoom.js\":\"b0ca10bde9026d27\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/time.js\":\"44a9b32a9b8e0928\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toast.js\":\"fc29c429410be451\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/toggleStore.js\":\"4e813e61b9464ed1\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/untilStopped.js\":\"7bf703a048e02534\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/userActivity.js\":\"63e7a95cd05c4519\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewTransition.js\":\"d74bcf678d5dfcae\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/viewport.js\":\"80e55d42f9d06a75\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/webLock.js\":\"f566359b1bc8a078\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceRecovery.js\":\"82943f74e41103e3\",\"/knowledge-medium/pr-preview/pr-1854/src/utils/workspaceSnapshotStore.js\":\"388bb58e408a644c\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-compiler-runtime.js\":\"0eb224d5d80a543d\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-client.js\":\"87285beb4b43272f\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server-edge.js\":\"76729150f0c9f121\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-server.js\":\"420bad1e762bea1a\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static-edge.js\":\"5e62c32483a407ce\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-static.js\":\"28ff0cd15e6f3a91\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom-test-utils.js\":\"71c8192685205366\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-dom.js\":\"98f79ac5d2a07fb4\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react-jsx-runtime.js\":\"4182f3cd7d4b11cb\",\"/knowledge-medium/pr-preview/pr-1854/src/vendor/react.js\":\"47030749ddbab6a0\",\"/knowledge-medium/pr-preview/pr-1854/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1854/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
