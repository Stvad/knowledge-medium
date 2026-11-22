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
		buildId: "e722331e2f9d-b55cfc00",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/\":\"25ca783be9a5ca8f\",\"/knowledge-medium/pr-preview/pr-1855/index.html\":\"25ca783be9a5ca8f\",\"/knowledge-medium/pr-preview/pr-1855/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1855/assets/FacadeVFS-Bu1YjWDF.js\":\"8e1444f7af15783b\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSCoopSyncVFS-CSA8m7cM.js\":\"e45ae75fa125d0d2\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSWriteAheadVFS-Btf_B063.js\":\"dbba5f9bce1c5087\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-B0ISJw71.js\":\"5ebcc8a2224eef71\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-BMCXHq2c.js\":\"13e9dfd16ef80877\",\"/knowledge-medium/pr-preview/pr-1855/assets/worker-CqYrfOYn.js\":\"3960d3628264e5e6\",\"/knowledge-medium/pr-preview/pr-1855/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1855/chunks/app-DO2nCr4f.js\":\"11a5dac68f336da3\",\"/knowledge-medium/pr-preview/pr-1855/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1855/index.js\":\"117a0f4a942abe82\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1855/assets/AccessHandlePoolVFS-Cin_mKV7.js\":\"70c864b059872b65\",\"/knowledge-medium/pr-preview/pr-1855/assets/IDBBatchAtomicVFS-BHUIinYu.js\":\"dfefd7d4bb5c010b\",\"/knowledge-medium/pr-preview/pr-1855/assets/MemoryVFS-Bn5_JK03.js\":\"13d8c8c64204af9b\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-C9-B-XoZ.js\":\"55d6363f64e5a535\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-CprHVz1C.js\":\"5508f5e11e7ec0ef\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1855/chunks/AccessHandlePoolVFS-DjCpAJ1a.js\":\"5b98f5fed2078134\",\"/knowledge-medium/pr-preview/pr-1855/chunks/FacadeVFS-NHLMBTTA.js\":\"c9a84278360e6ab2\",\"/knowledge-medium/pr-preview/pr-1855/chunks/IDBBatchAtomicVFS-DHDurZwg.js\":\"fe05b02c064a30a9\",\"/knowledge-medium/pr-preview/pr-1855/chunks/MemoryVFS-CKbTIio5.js\":\"8a8c47133119a841\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSCoopSyncVFS-DesV8IBJ.js\":\"30b7b5e08b0d4f0a\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSWriteAheadVFS-BONLhPPZ.js\":\"db06aa17dbe8ba0a\",\"/knowledge-medium/pr-preview/pr-1855/chunks/Preview-Y-VxJ0DW.js\":\"dd5fa2923b378f1e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/card-Dsh7DzZG.js\":\"c82e23031d758768\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-BmE8W1nD.js\":\"0dadd1e3111c54b0\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1855/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-CJU1VvMQ.js\":\"4dea43806e4ca59b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-async-CVK4BPfn.js\":\"a833d89b81e39d72\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-B6JNr3jC.js\":\"5d16aebfa4460888\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-BcTtWlSz.js\":\"eef0c7a1b3ba5274\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-BxHAFS9a.js\":\"dc4bdf792d51a74e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CEpbFoe9.js\":\"18a158d9778c0d92\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DIZ9F0wu.js\":\"3066fbee762c0997\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DWYAIDyE.js\":\"105dd6f87d433df8\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DycHtXKt.js\":\"b5298b1b6f5a6a6b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-PF1bDUNK.js\":\"42c2f4af392170e5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server-legacy.browser.production-BjEtT8mB.js\":\"36e1496e14283fae\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.browser.production-B1rscrgP.js\":\"fe362339b70758a3\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.edge.production-CzW24GEQ.js\":\"88c51f70d9eea798\",\"/knowledge-medium/pr-preview/pr-1855/chunks/server.browser-CjxKSHx2.js\":\"c82ca5a9275ba820\",\"/knowledge-medium/pr-preview/pr-1855/chunks/textarea-DpF8Vksn.js\":\"f7d0fc5c00270633\",\"/knowledge-medium/pr-preview/pr-1855/chunks/ui-wj9bpFMy.js\":\"685013222b46d803\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-DPxMUF07.js\":\"3104a1c87d9a5202\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-async-DHDdnHGh.js\":\"65aa5a1bea4082b5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1855/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/src/App.js\":\"5f2e957e9e757530\",\"/knowledge-medium/pr-preview/pr-1855/src/appUpdate.js\":\"4b5e688e63179283\",\"/knowledge-medium/pr-preview/pr-1855/src/appVersion.js\":\"2d431fc03e5ad8ab\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/initialLayout.js\":\"868c219040927d5b\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/openWorkspaceData.js\":\"75485526a17d1d68\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/resolveWorkspace.js\":\"4970f0a9f658300b\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/workspaceBootstrap.js\":\"2b52147a4fa5d81f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockComponent.js\":\"f886da3e7a7b98a1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockCrumbs.js\":\"adb2a5079d95fb14\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockEditor.js\":\"172aebf1eb6d7d0f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockLoadingPlaceholder.js\":\"57e956b056f338d2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockProperties.js\":\"2f6ec246a072c151\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockSearchPicker.js\":\"b3c3dc12ffc61e26\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ConfirmBulkDeleteDialog.js\":\"5a30cce7abb9e043\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DividerHandle.js\":\"3de23dd2b5dccd6b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DraftEditor.js\":\"4a0c13c441ec9651\",\"/knowledge-medium/pr-preview/pr-1855/src/components/GutterPill.js\":\"c5d190022610e8b3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Header.js\":\"9ec66630cb7f8af8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/LazyBlockComponent.js\":\"ff4f141a6da71398\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Login.js\":\"6172563e8a35b5ff\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ZoomableSurface.js\":\"0276b6610faedaa1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/editModeKeepalive.js\":\"a5a65c7ce95230a4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b62be3d4a05f62c7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d81be1e536a1537a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefPropertyEditor.js\":\"9138e63ea5314c08\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefTargetTypePicker.js\":\"dd6473a2f1c4f564\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/SelectPropertyEditor.js\":\"f865827a5b5c7050\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/TypesPropertyEditor.js\":\"bd0a9c4d8c94898b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/defaults.js\":\"0e1b9584c53e82e6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/kernelValuePresets.js\":\"a097cf38641d024a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/selectablePresets.js\":\"f66405a591fd04e4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/typesPropertyUi.js\":\"b58faa65fb44981d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/AddPropertyForm.js\":\"c3ff00c3fca98fd0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyPicker.js\":\"b9c90fa7bf380fb9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyRow.js\":\"9f9ad233631d82b8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/Rows.js\":\"8297cd11b7dbaeb2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/actions.js\":\"b3e89293ce3682f6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/declarationOnly.js\":\"8dbd04686727fd83\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/layout.js\":\"7d4bd0a399da204e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/model.js\":\"b47c85c572068af3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapeUi.js\":\"04f0eab0febd892b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapes.js\":\"07e834e0299d7612\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/usePropertyEditingActivation.js\":\"af9693229dff9cfc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/visibility.js\":\"fee54255d155703c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanelSections.js\":\"c8c10990f697be10\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockEmbed.js\":\"dd2ccd877c10c7f0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockLink.js\":\"7ec0b763f5c6bba4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockRef.js\":\"726125df7d1811ca\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/ReferenceLink.js\":\"2568bd23b11da8b5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuard.js\":\"7a5cc6beeff0c3bc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuardContext.js\":\"5763c5edf7a4c7b6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/linkInteraction.js\":\"a1cb3522ae6b0280\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/referenceLayout.js\":\"8d0ed98393a21bd1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/useBlockRefAncestors.js\":\"edf122d153a24306\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockGutter.js\":\"3d4aa67798ad65cf\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockInfoDialog.js\":\"fb0429838eebca4d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockTypeBlockRenderer.js\":\"03826a4ee96dc865\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BulletHoverCard.js\":\"c3391a74c93496d4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorContentRenderer.js\":\"fd34c0f37b0087ab\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"76828162416a9987\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ColumnResizeHandles.js\":\"4f8c0dc2072c6290\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"306395ee25bf002d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/DefaultBlockRenderer.js\":\"dd5c1f9824afc63a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/LayoutRenderer.js\":\"5fa1e7a62e868fe7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MarkdownContentRenderer.js\":\"00bf6ef2ca85d157\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MissingDataRenderer.js\":\"e23588bd7cfc0b60\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PanelRenderer.js\":\"c873c456a1d592bf\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2d97a61549a9bf07\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/TopLevelRenderer.js\":\"1480e92357411908\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockGutterMode.js\":\"5e4e29ba9161534b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockTitleText.js\":\"33be3857b40cafce\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/fieldCreationKeydown.js\":\"ebc34affa7c3b605\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/layoutRootContext.js\":\"dd6822451da52a75\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/TypeChip.js\":\"c28e3feba6f6ad4a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/chipStyle.js\":\"322ba74efd187f32\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/anchored-floating.js\":\"53d03e46379273b6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/button.js\":\"124956cceaeb3532\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/card.js\":\"6a497ef5d1fb1c6a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/checkbox.js\":\"f92e535db857ae80\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/collapsible.js\":\"fe75a1f9ee4ec445\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/command.js\":\"697ca929510f282b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/context-menu.js\":\"7859c23d78b3d0f7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dialog.js\":\"1674a22e35ec0499\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dropdown-menu.js\":\"a2d58a695fa89289\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/floating-listbox.js\":\"e7d83e9b9d2ddadf\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/index.js\":\"60f9b42e11f953c8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/input.js\":\"5f9b7093e511e952\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/kbd.js\":\"01b93be6a456f177\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/label.js\":\"b1eec90d225a12a9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/textarea.js\":\"fdd36e033e04a55d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/useEditModeYieldKeepalive.js\":\"1f39d249a8960b8b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/BootFallback.js\":\"d01c2dfb3612224d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/FocusedRowLazyMount.js\":\"e78c5ce16b8ec62e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LazyViewportMount.js\":\"8b39407327dcd9d7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LocalDbCorruptionFallback.js\":\"8ec1bcbd1109bd20\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/error.js\":\"301b137a713e4db1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/lazyMountRegistry.js\":\"9a77711c4e31114a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/suspense.js\":\"48255b83b1f0720b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/CreateWorkspaceDialog.js\":\"416f617677f8c53c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/PendingInvitations.js\":\"dde10666e6b7be7a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/SyncProgress.js\":\"4845feafb3231904\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/UnlockProgress.js\":\"33336bd4ab108c27\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceKeyGate.js\":\"ecd2734d1d689905\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSettingsDialog.js\":\"f867e7616c8c3960\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSwitcher.js\":\"dfee70df805466d6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSyncGate.js\":\"67e8522dfe105039\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlow.js\":\"e9f19fcc7010eaf6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlowHost.js\":\"d3a7fd222aec8d27\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/EncryptionSection.js\":\"28504255362bad33\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/attachmentPrompts.js\":\"8a1a7a9a4af13cf3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1363ef073225e8b1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowDeps.js\":\"8b0f66873826459d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowStore.js\":\"e215d98e36d68a07\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/flowUi.js\":\"a4809b38e884fdd8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/useConversionRun.js\":\"aab4795886d385cc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/keyUi.js\":\"097c10de14b1c517\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnKeyLoss.js\":\"961e233da7dd7947\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnServerE2ee.js\":\"4f2755caf237f3e9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/workspaceUnlocked.js\":\"8bf520d4647515bd\",\"/knowledge-medium/pr-preview/pr-1855/src/context/backgroundSubtree.js\":\"683655a03746ef99\",\"/knowledge-medium/pr-preview/pr-1855/src/context/block.js\":\"ee570707e4b84acc\",\"/knowledge-medium/pr-preview/pr-1855/src/context/layoutWsContext.js\":\"9ec6da3e674cf944\",\"/knowledge-medium/pr-preview/pr-1855/src/context/propertyDisplay.js\":\"493e9e61c6c895f0\",\"/knowledge-medium/pr-preview/pr-1855/src/context/repo.js\":\"58aa41bd2cd1c0f4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasClaim.js\":\"48e7d5c294d5c06d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasSeatNamespace.js\":\"2c6bcd3364566740\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockData.js\":\"7fd2ead3664ad7de\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockType.js\":\"cfe2afcad9d7aae0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/changeScope.js\":\"ee01f9093c3361b0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/codecs.js\":\"dc5c828e57cef763\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/derivedData.js\":\"64116b0b22df0dc5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/errors.js\":\"3054b7efb5e5fe41\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/events.js\":\"b673542b7f7d8fe9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/handle.js\":\"8ef640d8a5642551\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/index.js\":\"1d62ae479db0f1e9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/mutator.js\":\"9b121fda87bf5a78\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/processor.js\":\"86070512892a7746\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/propertySchema.js\":\"d73d6d3f45e59542\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/query.js\":\"ce3864e3864d5abe\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/sameTxProcessor.js\":\"7c16175d49edfeec\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/schema.js\":\"8ef640d8a5642551\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/tx.js\":\"8ef640d8a5642551\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/typedBlockQuery.js\":\"37a8a1c38d6af851\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/user.js\":\"a2814221302741c4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresetCore.js\":\"bd82d8a9366ee406\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresets.js\":\"42507f315e15eba3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/attachmentCleanerIOVerb.js\":\"52d9055e2870984c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/block.js\":\"ece3323278b4853a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockCache.js\":\"2fb239eb82ccd3e7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockId.js\":\"136dedf7b8e5f1f7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockLiveness.js\":\"be9c8265da500dce\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockMerge.js\":\"2618223ceae9ecc1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockSchema.js\":\"02bf77b6e0e57f84\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypeLookup.js\":\"0fdd961842d22ed6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypes.js\":\"786e32b5937ca3b0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/childrenView.js\":\"5dd3ba09bd4e7733\",\"/knowledge-medium/pr-preview/pr-1855/src/data/clientContext.js\":\"768038a43833886e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/dbFileSiblings.js\":\"9b5980e2f7392bde\",\"/knowledge-medium/pr-preview/pr-1855/src/data/definitionSeeds.js\":\"b9ef4ae49efec401\",\"/knowledge-medium/pr-preview/pr-1855/src/data/derivedIds.js\":\"72a174497f4fcccc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/drawnSubtree.js\":\"ea572c42f6ada9f5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facetBridge.js\":\"f8a9551eab728b02\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facets.js\":\"d8a29d43733e266b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/globalState.js\":\"bd30e2cd44c83c12\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/aliasClaimRederiveProcessor.js\":\"3187623235cb1ba6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/ancestorBatch.js\":\"9cdcc30505bd3535\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/blockTypeTypeifyProcessor.js\":\"d77f4fc0f5b76505\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/clientSchema.js\":\"c9251a2a6edb7327\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/commitPipeline.js\":\"6eed3426d65d83ce\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/devAssertions.js\":\"49cce4a3e35269c5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/firstSync.js\":\"a4a970312e069e0a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/freshInitialLoad.js\":\"211d68457145ab24\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/graphBackfillClaim.js\":\"2d05fb819540a471\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/handleStore.js\":\"8b85e303f173ac17\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/idleMarkerJobs.js\":\"fc978737000d0032\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initialDownload.js\":\"17c985828e64f1be\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initializeClientDatabase.js\":\"95f9d10a51202918\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/jsonCanonical.js\":\"532828c819738529\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelInvalidation.js\":\"47b4849649680614\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelProcessors.js\":\"aeba1325af536b09\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelQueries.js\":\"b9d0ab539751f691\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/mergeTypeMembershipProcessor.js\":\"5afb8fbba9198e06\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/normalizeReferencesProcessor.js\":\"7e0e29ff96623be8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/poolInstrumentation.js\":\"e031b5f49ef8f288\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/processorRunner.js\":\"e9c20229ebc93bd4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyCellBackfill.js\":\"129ddbe6170c935a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildMint.js\":\"c233791f11aa9bf3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildrenProcessor.js\":\"7c1b54f820dfb000\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionChangeProcessor.js\":\"942f7c5aad320f1b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionSynthesis.js\":\"89ee92c42358c6d5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyKeyScan.js\":\"c90aafc13bda77bd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertySchemaResolution.js\":\"be0172cc818f1db6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyValueEdits.js\":\"4a356a795b0db0b6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/raiseProtocol.js\":\"5757cf4bd661375d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/readBatch.js\":\"65df8983f2e29855\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/refProjection.js\":\"9cbe3cb8f9580fce\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetLookups.js\":\"8ed7cfd5d7c51623\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetProcessor.js\":\"ea921f5e01f962d3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/replayMerge.js\":\"81119f4409a1cd4a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/sqlBinds.js\":\"6c437aad4cd0b050\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"79ac1de00b391cd1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/arrivalProcessors.js\":\"a2718e513f632a48\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/invalidate.js\":\"25863b2664077a37\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/materialize.js\":\"d794f04135fee32a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/observer.js\":\"89e3c901f2bb50c9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/reconcile.js\":\"54ab4d92dcf37a8c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/timingMetrics.js\":\"9829ad742046cd10\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/treeQueries.js\":\"76bf0a866f57d95b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txEngine.js\":\"9f117acdafb51d88\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txSnapshots.js\":\"f01bc2ffc4bf1d42\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/typedBlockQuery.js\":\"04f2dd58975c41b9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/undoManager.js\":\"2992572ad2df535a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/invalidation.js\":\"e9a27f9f5eaeb5ab\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelDataExtension.js\":\"e86b4130f4c77630\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelPage.js\":\"48ac76f249250913\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelValuePresetCores.js\":\"cc82a6fd6f33b4af\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbCorruptionSignal.js\":\"26c9534b4b3c8fb6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbStorage.js\":\"638f590643a0c385\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbVfs.js\":\"69b07ad88b43f334\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localSchema.js\":\"b574df17ace2fc31\",\"/knowledge-medium/pr-preview/pr-1855/src/data/maintenance.js\":\"7acb36a92d7d8453\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mergeProperties.js\":\"67d608623299028b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/metricsConsoleHook.js\":\"f271bb45642e780e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/migrationsPage.js\":\"221372701227d875\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mutators.js\":\"3c486f1c2d91b7e9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKey.js\":\"7645443354392007\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKeyPlacement.js\":\"e9659f069dfdfd9e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/outlineSurface.js\":\"60fad497f714fff3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingEditorContent.js\":\"fffcba83d1769e5e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingUploadsSql.js\":\"5c5dc2399699e40d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pluginStateExtensions.js\":\"b905e693aaea9519\",\"/knowledge-medium/pr-preview/pr-1855/src/data/powerSyncLogger.js\":\"6623c0cc364081ae\",\"/knowledge-medium/pr-preview/pr-1855/src/data/projectorRuntime.js\":\"4f02dd1ece22f195\",\"/knowledge-medium/pr-preview/pr-1855/src/data/properties.js\":\"dca7c2e78f2134c7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertiesPage.js\":\"d5916c6657d60bd8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyChildren.js\":\"7b6091428f326623\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionFanout.js\":\"904a9835c7f3934b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionMetadata.js\":\"3e9c603e614de4cc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionRegistry.js\":\"fd0e5216df8aa3ef\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDisplayMode.js\":\"c05566dedf003986\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyRowCreation.js\":\"efd237f400902da4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySchemaCreation.js\":\"3e7ae68338e4ce32\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySeeds.js\":\"584218030bcace9e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/recentsPage.js\":\"090cd93e18476d82\",\"/knowledge-medium/pr-preview/pr-1855/src/data/referenceBlock.js\":\"192f2f081d26a312\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rejectedUploads.js\":\"0f15bf83091fc743\",\"/knowledge-medium/pr-preview/pr-1855/src/data/releasePowerSyncConnection.js\":\"3e5f6d66dd48a587\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repo.js\":\"feb92aa2aefaa953\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repoProvider.js\":\"293e54ef0d399ae5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rowProperty.js\":\"b20153dc73af0f80\",\"/knowledge-medium/pr-preview/pr-1855/src/data/searchFilter.js\":\"dcfe5f5d55e55960\",\"/knowledge-medium/pr-preview/pr-1855/src/data/seedIdentityLedger.js\":\"e1dafdc21367da66\",\"/knowledge-medium/pr-preview/pr-1855/src/data/stateBlocks.js\":\"1f3dd8f1c546c448\",\"/knowledge-medium/pr-preview/pr-1855/src/data/structuralEditPolicy.js\":\"a34509f9f53d1ffc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/subtreeDelete.js\":\"b4d143d062727da4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncStreamLock.js\":\"22ab7b12c23aa15d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableSqlRecognizer.js\":\"829aaa70f2d1cee6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableWriteGuard.js\":\"6f76786b466483e9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/targets.js\":\"a523576857fd9efc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeColors.js\":\"7d06992ee41f5c8b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionMetadata.js\":\"090ed630d8e1b8a5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionRegistry.js\":\"0ee49f2623f7b076\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeExtraction.js\":\"fd7c2dd06485ddce\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeInitialValues.js\":\"550097ef4050f7c1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typePropertyGroups.js\":\"f571a37a4d2769d5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeSeeds.js\":\"da6539c261fcb1f4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeTagger.js\":\"a8c62a55fbfa07aa\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typedRecords.js\":\"7127670c8974f410\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typesPage.js\":\"1ffde5074145f2ef\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userPrefs.js\":\"07256aa6bf54733e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userSchemasService.js\":\"aa69060aec68496a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userTypesService.js\":\"f34664554703cf1c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/valuePresetRegistry.js\":\"511bb7afd6970c54\",\"/knowledge-medium/pr-preview/pr-1855/src/data/visibleChildren.js\":\"0a5011f3342fbefc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceConversion.js\":\"86621bbad62724d3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceFirstSync.js\":\"1af5ff2f298c09f2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceIdNamespace.js\":\"e8754693a7af6064\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceSchema.js\":\"999bc686be8f27a1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaces.js\":\"0da99a08e40b3bed\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadLog.js\":\"2ed3b4b36f7275f1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/BlockPasteShellDecorator.js\":\"b49ca0864a22c59d\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/atTrigger.js\":\"272db212cf60f8f9\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/autocomplete.js\":\"a9298e6e06c85eaa\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/codeMirrorExtensions.js\":\"8864d53714baafe5\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/contentFlush.js\":\"93b5388008951ec2\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/defaultInteractions.js\":\"9703026b643f1a87\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/editSettleSignal.js\":\"f99f772fb398bec9\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/insertImage.js\":\"7c9adba9a7d57a7e\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceCompletionRange.js\":\"0ecc0f5ffb590adf\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceTargetTypes.js\":\"a4f5a01594ea5ffc\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/syntaxContext.js\":\"340c96bdc2c7f7bb\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/triggerMatch.js\":\"d935cab7a4217a72\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/AppRuntimeProvider.js\":\"835c40868dd7bb9a\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/BlockFocusShellDecorator.js\":\"a1ec4ca15dffb096\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/ExtensionRenderBoundary.js\":\"4e3c9fa9b9fa61ec\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/PanelContentRecovery.js\":\"aead9a22343cdc1f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/apiCatalog.js\":\"b2692a481aaeacdd\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/approveExtensionHere.js\":\"c56dc734ef72ff63\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/armedCutAppMount.js\":\"f1aa1065790c4a8e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/batchableKeyedStore.js\":\"b413edeef3fee8ca\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockInteraction.js\":\"7aa53bb3b93ee7fc\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockSelectionAction.js\":\"72074da61952c440\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compileExtensionModule.js\":\"d0a1d9967219edaf\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compiledModuleCache.js\":\"3615bcada622d45b\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/continuousGestures.js\":\"7097750c17124191\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/core.js\":\"1050226613d8a5d0\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/defaultRenderers.js\":\"2ecf37b4e08719b3\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/definitionFanoutAppMount.js\":\"9dc7b016cc9b1375\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dialogAppMount.js\":\"b8a9e428a852dd5d\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensionSeeds.js\":\"3a6876f4a8a875b2\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensions.js\":\"ad2a23c5d2739fb9\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/exampleExtensions.js\":\"0a4e517d8e4f8010\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionApprovalStatus.js\":\"3cbca79caf6e0598\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrorToast.js\":\"4708a0ddd3fd39b2\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrors.js\":\"16e7b8027e450e89\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLookup.js\":\"a7fb009a4b361a26\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionToggles.js\":\"30539bc414f7ae16\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionUtilitiesCss.js\":\"bf75f50b489c15d7\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/kernelPageDeletionGuard.js\":\"abd879682017deb8\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/liveRuntime.js\":\"9451f0dfce3ff8d3\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/openExtensionsSettings.js\":\"f1788b041fe6e26e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/overridesCache.js\":\"9f09018688395427\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/pluginIds.js\":\"d69b9bf850fe732c\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/processorRejectionToast.js\":\"e654e25b499daf81\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeActions.js\":\"8b96657e355777b6\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeContext.js\":\"5154092426bab356\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticAppExtensions.js\":\"907ee412cbf7de3f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticDataExtensions.js\":\"d073c1fc903dbc02\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/toastAppMount.js\":\"a54ef53b8375e175\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useOverrides.js\":\"50bf7e2b60bedb4f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useShortcutSurfaceActivations.js\":\"8921238ec8244729\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/discoverToggleTree.js\":\"e888d05d6f066a87\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/facet.js\":\"711c8fdd3bfc4f64\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/resolveAppRuntime.js\":\"751394c5df4cf89e\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/runtimeEvents.js\":\"696cecf76f98c434\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/togglable.js\":\"785c4ce3290a7a12\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/variantFacet.js\":\"ad2ad9089d560386\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/verbFacet.js\":\"da692165e5cc3a6e\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/block.js\":\"54fa56aca978b66a\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/focusedChild.js\":\"a5c4d85aaf2d58ed\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/propertySchemas.js\":\"159da556eb8cb568\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/typeRegistry.js\":\"c85e3d8f28ffd406\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAncestorCrumbs.js\":\"7e7f85c57051b3d8\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAutocompleteListbox.js\":\"3d1d1a51ff0edc2c\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedSearch.js\":\"910b32614fb64f85\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedValue.js\":\"89a8c258ca2c0736\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsFocalRender.js\":\"6bd718ece97eecfd\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsReadOnly.js\":\"98a57aef70702d2c\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMaterializeBacklog.js\":\"c27f0782b697654b\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMinuteClock.js\":\"67b748696d7285a2\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePanelLayoutProjection.js\":\"8f6a2363efc820ce\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePendingInvitations.js\":\"63326289fa38e376\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRendererRegistry.js\":\"801da31283c35c3d\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRetainedFieldRows.js\":\"16f682373c2e1496\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useWorkspaces.js\":\"8dc7dd6ff9b66715\",\"/knowledge-medium/pr-preview/pr-1855/src/lib/utils.js\":\"0db3053cc33ece07\",\"/knowledge-medium/pr-preview/pr-1855/src/main.js\":\"7152bf3e7afbe932\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/MarkdownImage.js\":\"0f71b4a26c9b3602\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/blockSeparators.js\":\"12fd1c40aff69b51\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/context.js\":\"8651aa963c68943b\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/defaultMarkdownExtension.js\":\"3c949800a8528af6\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/extensions.js\":\"1dde92fb2a8860de\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/renderMarkdownHtml.js\":\"7b9082fde8a09c37\",\"/knowledge-medium/pr-preview/pr-1855/src/minimal-editor.js\":\"c4e9529db61ed684\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/armedCut.js\":\"f1842ed04d94c039\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/captureMediaVerb.js\":\"c77902705e6bbadc\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/clipboard.js\":\"1cb572b4d5291a85\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/decision.js\":\"077e32c8035a09d1\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/operations.js\":\"07bfa99b815f31cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/AccountHeaderItem.js\":\"4a867f8155564ae6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/index.js\":\"cd91a91df863c3d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"153b9a4dde4ece3b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askAgent.js\":\"28bf77d6e0c19c50\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askedStore.js\":\"1e7cbca8935eba77\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8db086e06f14457c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/chipState.js\":\"06057b9a0548332e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fa944aceb0c21228\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/index.js\":\"67760ebad82abb12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"30e85c8262fd40b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/schema.js\":\"9a6a8eb57ab507a9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8d3691498c7755b3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/BridgePairingDialog.js\":\"1651f62346f4f59d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/addMedia.js\":\"4ba9ac6ac9b065e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b92c4fd8d0ab783a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/block.js\":\"3e31309bc2f2a070\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/context.js\":\"bb171e8845209d5c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/displayIds.js\":\"99488779d732a79a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/index.js\":\"486e47586c2749b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/outline.js\":\"54fbf8eb27e721d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/properties.js\":\"68c9413cb41a349a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/refs.js\":\"ce7ba7a0eab33113\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d6c22a6045090415\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/search.js\":\"9e9d46aafe753bcc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/shared.js\":\"a2546481e7539084\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f09b10bb20681c79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/text.js\":\"1e860771092bebfa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentWrites.js\":\"0972dcab37bdb44d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/authoringCatalog.js\":\"d50935981fe5a6ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/blockRefTargets.js\":\"96dcf5bb8d542c58\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridge.js\":\"6a49ac20828fd25c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridgeLoop.js\":\"e498f7ed9c1a0722\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/changeHistory.js\":\"cc252a509ced30d7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commands.js\":\"3864853eb3ca84ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commentsCommands.js\":\"441af6313d2b669a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataExtension.js\":\"49314852eb76a33b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataModelGuide.js\":\"d50933609828f45a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/describeRuntime.js\":\"2851218f6051c6ed\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/extensionLint.js\":\"eab4034712fe6917\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/grainAudit.js\":\"03b5aeae20609319\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/healthCommand.js\":\"4e8d4db78487ff00\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/index.js\":\"50359348d14d8eb8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/presetIdentity.js\":\"b9cc3f3a8c8b3423\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0ef2834d8ae25c89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/readMedia.js\":\"36730d0555d58a4c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/schema.js\":\"d94ee3fc611155d3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/serialization.js\":\"62cfa74073483b95\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/targets.js\":\"dfad2f1281514c4e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/tokens.js\":\"9ff86f2c4bafff0b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/watchEvents.js\":\"789267e094c3ae1f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/workspaceGuard.js\":\"037015ee173264d0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/writeCommands.js\":\"3aa47d2ba8fd8cd8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/AliasCollisionToast.js\":\"1c5e43ad6e5149d7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/DuplicateNameBanner.js\":\"8b3394519ae8df92\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/collisionMerge.js\":\"1ac3ae57383cc1f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/dataExtension.js\":\"49447922112a7bde\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/index.js\":\"85439e9eff8f8647\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/mergeCollisionAction.js\":\"980022fe78bb11c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/pageStyling.js\":\"c6257ca19b3ff2d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/rejectionToast.js\":\"ca7dbe4718163c27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/syncProcessor.js\":\"a1007b26e226a5f8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/actions.js\":\"49bea3513ccec32a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/addComment.js\":\"ffb3afed5386a661\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchor.js\":\"36b7e1f390008ba2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchorState.js\":\"aceb1e6cf4f7bb59\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/commentLinks.js\":\"a32c084cee06e09a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/confirmThreadDeletion.js\":\"ff368b4dc570344c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/container.js\":\"1c61296120327e47\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/dataExtension.js\":\"4628affba5f5003e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/deleteComment.js\":\"af49ba08ef2a5fb5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/highlights.js\":\"ba4dc4c8bbf1348a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/index.js\":\"5e02c4cc08c57858\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/linkedCommentsPill.js\":\"cfed99f39ffb7cbb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/margin.js\":\"367c64f5aa68b68b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/marginSchema.js\":\"ee3a4252aee0413a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/newComment.js\":\"34e5f7d7ef0d0966\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ownThreadPicker.js\":\"a08d6b79eed1e92e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/placement.js\":\"ec4ccd74613af49d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/queries.js\":\"5a9c55bad83f178d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotePosition.js\":\"621c370eede3ec8b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedIn.js\":\"3d3b0f7fe83554a4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedRange.js\":\"8e18dd97e2836be5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/rangeRefs.js\":\"e55ac4c9b0c9e309\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readHighlights.js\":\"f500e222ca7a9e7c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelection.js\":\"65ac94ce5a648862\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelectionUi.js\":\"b822d4aa47d4ffbf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/reanchor.js\":\"a3dbe12fb2d54d29\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/schema.js\":\"1a647dcba735c88f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scope.js\":\"0f7a1ff2216093f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scopeThreads.js\":\"9a7eaef0afe253fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/splitRetarget.js\":\"5f5f8f77847845c9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestionCard.js\":\"92402f0426ea42ad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestions.js\":\"7e6db4db30f2bc38\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaries.js\":\"d19e0818427ff976\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaryBatch.js\":\"ff3dc87b20fce7d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/surface.js\":\"913c378285ecc50b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threadNavigation.js\":\"56e5ee394ab93707\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threads.js\":\"7a197e7effb1cfea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ui.js\":\"2a539eb2a79fdf2c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/uiStore.js\":\"b79cf8bbe65b3f7b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/appIntents.js\":\"6cc16f0c17768829\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/index.js\":\"00b4043690fdba04\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/index.js\":\"3c48f9fc75f27fad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/status.js\":\"0973f620a816935f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9794aa9a4e7a0fcc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaBlockRenderer.js\":\"0cd267d381dc2fce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ae64a08a09c123f5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaUploadReconciler.js\":\"f1fe473b4d8d0672\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetDownLane.js\":\"da69aef99e2569c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetResolver.js\":\"20164d371687ed2a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetUpload.js\":\"352a14574bade5d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/attachmentCleanerIO.js\":\"750bb2ca17461ecf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1afad7d357712b03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/blobStore.js\":\"a195f8c3aab834f8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/byteStore.js\":\"735960b76e18e8ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanerIO.js\":\"6ba95590f954cdc8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanupAttachments.js\":\"c88f194580e5b0e9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/dataExtension.js\":\"4744e82eef1df0a0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/downLane.js\":\"cdba7b13ed009afa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/index.js\":\"772672492efe225a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/insertImageContribution.js\":\"71b74f622fb0ff12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneArming.js\":\"4a2c9aaf02ecf96e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneLock.js\":\"dbacea9444f11324\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaBlock.js\":\"58bc33b8f53aec66\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaCapture.js\":\"f3eb270254271ee9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewers.js\":\"906ea3bbdb77671e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewersFacet.js\":\"e2fa0a60ea357a5d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/pasteCapture.js\":\"e019a664e051e0f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/resolver.js\":\"3079f0167f4e5e8f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/retryUploadsAction.js\":\"7d4e9b3092af1a2e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/storagePaths.js\":\"819dc99fd62f38a0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadDrain.js\":\"ba6908ea0868085a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadLaneStatus.js\":\"6d323eb3757ed9b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadReconcile.js\":\"83cc3044f17bd227\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadRecovery.js\":\"897bcb2e75fa2d95\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadStore.js\":\"364bfa67debc6b64\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/useAssetObjectUrl.js\":\"24872b129975a114\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c60dd9503023d542\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b18dfce9aa7cf392\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/facet.js\":\"66280b88bff04bab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/index.js\":\"4908bb567d74ce30\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/prop.js\":\"28e2c1cea25e49ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinkFilters.js\":\"4dfbbc551d91ac76\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4f2eb04d995aaecb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BlockEntry.js\":\"6f55da262e8646c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/LinkedReferences.js\":\"b24a5b8e8bdfd5e0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"dd19dc9c28661818\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dailyNoteDefaults.js\":\"8fd50fcbd37b5d16\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dataExtension.js\":\"34ab34b39aad13f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/edgeExclusions.js\":\"6299b047c27a34d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/filterProperty.js\":\"6b072d24b51325ee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/index.js\":\"a404db1735859cf8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2cc04d61df3b84a1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/applies.js\":\"b64b2838c733e663\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/countQuery.js\":\"d726235ccd8d522d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a78abfc3a9ee72b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/index.js\":\"aea02c4a03cd0747\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bd7e0e3a17eb8253\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/presentationInvalidation.js\":\"c2e99843b6f12cca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyEditorOverride.js\":\"5ad5bca4d199c845\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyFilter.js\":\"85f4887e85e842e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/query.js\":\"db355755a02d95b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/resolveFilter.js\":\"12ba4176d60e9be8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sourceBatch.js\":\"53375300f0241082\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sources.js\":\"8adf419373905367\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useBacklinks.js\":\"195a937fe97ebe16\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0fd45d8bbb491852\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayCelebration.js\":\"c2133434704a5a31\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayOverlay.js\":\"5e70200a6d06e326\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/gate.js\":\"ecae134fc1e7e72d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/index.js\":\"9bd04d60974848d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/wolfTheme.js\":\"f4829d4758d5eb89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/BlockDragLayer.js\":\"cc4a6eb89cc9f71a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dragController.js\":\"130c40f90760c16a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dropTarget.js\":\"2343715867d5026f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/index.js\":\"608c5b1ce61fbe2c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/projection.js\":\"6ba2ade744d89bd2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/BlockMetaCard.js\":\"7a73ef42f6270937\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/index.js\":\"b22312e17c080fd2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/AddTagDialog.js\":\"14f67e712ce5b467\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ad50cbe962c9e58e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/TagNameIssueHint.js\":\"836ec0a68f3930bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/addTagAction.js\":\"3d2e60309c37c072\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/appendTag.js\":\"4c0793cc8d2104a4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/config.js\":\"d320eb4c1fe32545\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/dataExtension.js\":\"075320f6590cf0f5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/index.js\":\"aa18a279b27db71c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/propertyEditorOverride.js\":\"5e84b26cb861e8eb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0385be847a440036\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"32fc8a9db63bf8de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/Breadcrumbs.js\":\"cf470c1e76dba8c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"78156c40790dc852\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ab4d31abb9bfd206\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/index.js\":\"9c6ca18c2383840d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2734d6a02665cd15\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/CharacterCountItem.js\":\"92e07499ee47c780\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/ProfilePropertyEditor.js\":\"90c7b255c91c3598\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/actions.js\":\"b8726cd3ca65466e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/blockType.js\":\"f1e4f8c9a07a22a8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/charCount.js\":\"4a353557fdfcdd87\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/dataExtension.js\":\"adb5354ae8953856\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/index.js\":\"d81e0615b07591fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/profiles.js\":\"f654a980a07bb5de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/properties.js\":\"7e7bd22728d91847\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/textCounts.js\":\"c145ed6b44fb57c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/colemak-keybindings/index.js\":\"7538ec8f848580e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/CommandPalette.js\":\"19590f13b908cfc4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/HeaderItem.js\":\"73c1616f12e0718a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/context.js\":\"2fed024abd3e1bb7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/index.js\":\"d740b6af3d661795\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/selection.js\":\"71066ab222d740fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/toggleStore.js\":\"12f4364301b92465\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/useCommandPaletteActions.js\":\"daf9c3acdc6d76ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/ContributorBadges.js\":\"2fb55552040d3f64\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/author.js\":\"d98ee921c14551b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/codeMirrorExtensions.js\":\"98a0add74f6a31f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/dataExtension.js\":\"8dc6a17117082a5c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/index.js\":\"28a0b5df80b7e26e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/mentionAutocomplete.js\":\"47101d7fc37926ee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/processor.js\":\"dc2d2179c5d130ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/profiles.js\":\"df8ed30026c7b652\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/queries.js\":\"1159ebab365ed9b9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/schema.js\":\"880ca71fd7769531\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7e994ffd280277c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/followOrigin.js\":\"509fee454b010314\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/index.js\":\"ab154bebd523ca51\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"821949b007465db6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"59be0f81bbafb5c9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/CalendarGrid.js\":\"b892e8f090dfb170\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DailyNotePicker.js\":\"a7ec5c08fc0f58bc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b1c07f0b5ee7e411\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateNavDecorator.js\":\"16288b1b3e202cd3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateScrubOverlay.js\":\"dde9a92bb192966a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/HeaderItem.js\":\"405fc201a3dffa29\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/ReschedulePicker.js\":\"f4eab9119b4e557a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a7be580df022a0ba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/actions.js\":\"e6bda5a6d26c9dca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/blockDateAdapter.js\":\"c3c691e8ce985562\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/calendar.js\":\"b553f17c40db74ba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dailyNotes.js\":\"85f4805f5823f3ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dataExtension.js\":\"f71db13eed72e92b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubActions.js\":\"a2276f174e540cc1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGesture.js\":\"ac1798d568d311af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8bc1673abb4077bc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubRecognizer.js\":\"18cca084be14c8af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/deletionGuard.js\":\"919f746901094d76\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dueQuery.js\":\"b7a69cd386c12018\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/index.js\":\"b63cff3a29d6465f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/landing.js\":\"1d95c3d85a236104\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/localSchema.js\":\"53bfe2d89572b1e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/referenceDateAdapter.js\":\"496a6ffd08f9adca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/rescheduleAction.js\":\"967ed0735ea431ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/schema.js\":\"852a382b68e739f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadBlockDates.js\":\"dcd3063817ef86fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadDatesAction.js\":\"508add445f14b62f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/today.js\":\"be7ed457952e66e0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"146afde9d14ce231\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6ca0c34b2f751354\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/audit.js\":\"cbf43c1be2047688\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditAction.js\":\"25944793b00c0b4e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditRanges.js\":\"e5ae9f2ce5a291bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/diagnosticsSource.js\":\"21dfa6a8d4ba6820\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/divergenceScan.js\":\"f2f0a46485061aee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/index.js\":\"67020b7b81e9558d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8d99291523380cd9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/referencesMirror.js\":\"82724b5085b7d2e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/rowJson.js\":\"1e70c4b7d2fd59de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/schedule.js\":\"e49fb49e038d6337\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/store.js\":\"ff9643e55106ed89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/action.js\":\"a649e392faef0050\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/index.js\":\"1f7c8ac01e8c64f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/plugin.js\":\"a08b30117c71f570\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0f2496c7ef6cddf7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/actions.js\":\"5da728e294f4bd50\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/changeMarker.js\":\"9566cc6e06b8685f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/diagnostics.js\":\"874b3acb97a4067c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/fileSystemAccess.js\":\"d603719ad6d6a7ed\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/filenames.js\":\"0c020b4fa8e48c89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/index.js\":\"fa0c396dede0b9b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/mirror.js\":\"904da9fe22dba743\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runLock.js\":\"4a47bb2cdedb5f00\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runtimeHealth.js\":\"6f65b842b5c2a00a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/schedule.js\":\"9432e55c52651ce6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/store.js\":\"28d6d7ecbfb8b1f7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/index.js\":\"36c9002a3c8e7ec6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/themes.js\":\"10b7087048583007\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/facet.js\":\"755225acb4feee7d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/useDiagnostics.js\":\"bdce3ed904cf64d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/dismissals.js\":\"6d162d15131c6641\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/index.js\":\"177418534aadede4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/status.js\":\"c5260ecd95137d32\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/store.js\":\"dfa3c0e7da47eb7b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"be690b172b758242\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bdbdb3bd863240eb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/actions.js\":\"d9047462b0098d20\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/config.js\":\"e9b4a8625d852d5b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/dataExtension.js\":\"e8c3b7f7af60066b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/effect.js\":\"940160f8c8062fa6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/index.js\":\"8bc44d1c739490aa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7c97a244562184c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/useToggleTree.js\":\"1591661dc9a2be98\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/ExtractTypeDialog.js\":\"e6492b3331e68d4d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"68b0a7820ef69a49\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/PropertyShapePicker.js\":\"fcdef070ebb8695a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/action.js\":\"8f2121c2f098a3e9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/index.js\":\"288a3cbc4be1e592\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/FindReplaceDialog.js\":\"7c367550f3abe020\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/HeaderItem.js\":\"47ea99720b351078\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/dataExtension.js\":\"5090146c49c0a8e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/index.js\":\"b30f677ec3dbf8a7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/search.js\":\"95b64a536f26d8f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/toggleStore.js\":\"1f9fff94ac874f4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/LocationPropertyEditor.js\":\"29d8ce480704da4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/MapView.js\":\"24b0d5ef49379a97\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/blockTypes.js\":\"1f307e90b0f8bf0b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/codeMirrorExtensions.js\":\"1d1d55b55f208e14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/createOrFindPlace.js\":\"4650c1e1be3f1b89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/currentLocation.js\":\"65b69699fa8462ca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/dataExtension.js\":\"6283a8e59e4a7b85\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/geoContentDecorator.js\":\"73cc53bb37b35167\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/googlePlacesClient.js\":\"3e66f1111b35066d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/index.js\":\"4872c13fe1777231\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/locationsPage.js\":\"6c1b9a71621cb682\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/mapViewport.js\":\"a70a4c0b6191a3ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/pickCurrentLocation.js\":\"c692310076aa0470\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeAutocomplete.js\":\"582915de06365401\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeNameCollision.js\":\"b37c18c5de13d6e4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/properties.js\":\"5b40d8036fb32e01\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/propertyEditorOverrides.js\":\"012771b3861b709b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/query.js\":\"56fd6192fe701cf7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/usePlaceSearch.js\":\"9824c744d497344a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0c5a98c593c66340\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7c70f3dbea14e537\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6de949f7ee5ecb10\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/config.js\":\"b99ebad4789c6a7c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/dataExtension.js\":\"4a15f9e251dc23d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/facet.js\":\"a13c817f45298651\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/grouping.js\":\"45182ecf289561c6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/index.js\":\"aea8e03f4afe40e7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d109f978c0c98eb9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/query.js\":\"3b0b6bd9d9a5d05c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/resolveConfig.js\":\"0adee2d7536497ef\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c7eeda0d2f21d420\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c1a47cb163f9b4d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlDocumentContent.js\":\"645029f0870de699\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlFrame.js\":\"9ced4725fb9e06fc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/actions.js\":\"27ce80bddfef5da0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/blockType.js\":\"5876e42eeaa4cbfd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/confirmRunScripts.js\":\"4c65d273bc55cad3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/dataExtension.js\":\"d255633d4d4000c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameAnnotations.js\":\"4dface79a7460860\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameDocument.js\":\"e390c4416f061914\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameTheme.js\":\"83b92e6a218286f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/index.js\":\"943f59ef19ce9db9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/scriptConsent.js\":\"686c0ed37731262f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/sourceMap.js\":\"d140fffa366ebd8c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/useDocumentScripts.js\":\"d1a8e2eb23e7bef5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/index.js\":\"8bcbc709a882c36a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/record.js\":\"f2cbcc6290da6d3a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/recordStore.js\":\"37e32d7866edaae0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/responsiveness.js\":\"50f68469f88020c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/schedule.js\":\"88c74127cebb6236\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/sessionContext.js\":\"f3409617bc263d30\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9447acabe88f9957\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e34cf4ca5ea82891\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/actions.js\":\"473edc3c5a4577c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/config.js\":\"f119e2bf79f86a4d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/dataExtension.js\":\"4c1d6e701ff6d191\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/effect.js\":\"35ab8f7a44d4e702\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/index.js\":\"3e1c217df4f5401e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/keyCapture.js\":\"d28ddfc61329bdd5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/overrideStore.js\":\"55dc5555bba8e8e9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fefdd35e8baf82aa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/HeaderItem.js\":\"b871b3f169b13c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/LeftSidebar.js\":\"b5fa0538b50d6fb5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/actions.js\":\"0170553d6e2ddcc9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/facet.js\":\"a5bc0c4107cccdba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/index.js\":\"b31934681a4142bc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/shortcuts.js\":\"2a09814c3e85e243\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/toggleStore.js\":\"f199e1ef5f700821\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/MergePicker.js\":\"f58725a17671aa44\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/index.js\":\"074446b0690445f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/mergeAction.js\":\"f38a0a2bc9a3f91a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/strategy.js\":\"b83be8ffbdc2619e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/Button.js\":\"23cf6227c1c5c715\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2944795c1f228595\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6cf93bbe38056c0e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/facet.js\":\"92336ce84ae73274\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/index.js\":\"972a448022ef314b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"dc30b2ac666d2b03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/actions.js\":\"72841ff99b21ac0f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bb4ce27a38c413a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f36bcc8322c51057\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/index.js\":\"cd82326ab677b3aa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5016acfbf9d6cc05\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d795851b7b7e3c5f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/contextMenuItem.js\":\"d0476f30c183f2f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/index.js\":\"0d7d4d91c7575cba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveAction.js\":\"dc1389534a5018b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveBlocks.js\":\"2ecfe261ccd6cb63\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/selectionAfterMove.js\":\"23e5cc89a91019ba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/TutorialBanner.js\":\"f9ce129c17230ef8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/action.js\":\"9b6e5bad32b56602\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/bannerDismissal.js\":\"da764486954baa4c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/documents/cheatSheet.js\":\"e384a9bd9f4224c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/index.js\":\"81fcdc8652b59171\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/keys.js\":\"dd52a5405a176c08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/landing.js\":\"0531926c82542b02\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/outline.js\":\"2d55360655609c8b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/seed.js\":\"e38d7dd44ebcbd1f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/PerfTrendDialog.js\":\"73d3cd4a717761b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/analyze.js\":\"f367d18df514325a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/diagnosticsSource.js\":\"2e59ac8c2f12fda3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/index.js\":\"1b428bbf5aa221f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/load.js\":\"b09351d47c7a9629\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/monitorRun.js\":\"b4134c48af038009\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/schedule.js\":\"21f86a5d5263c560\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/series.js\":\"93e3955900ff1f3b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/store.js\":\"ed52645714339840\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/trendAction.js\":\"44d08e492ee9206c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/verdict.js\":\"6e0380c699c29b90\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/clickToEditAction.js\":\"5eae78d9b2ac7ba1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/index.js\":\"edb476f214025cda\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/interactions.js\":\"19da8193ce31de2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"27b82b37c8807644\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGate.js\":\"f2ad625c083a46c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGateDialog.js\":\"d4268b99e674ca36\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/action.js\":\"f14b6636158d9330\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/index.js\":\"d47a98e5c75b0fa3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/localRunMessage.js\":\"e697f72b5cc15b7f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/plugin.js\":\"2f5e277ef2359aca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/progressReport.js\":\"8df560fc30833638\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/sweepProgress.js\":\"f6b0c6774b100eff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/FieldRowRenderer.js\":\"b7da163c2d0c36b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/ValueRowRenderer.js\":\"640e8368ff4bca8b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/actions.js\":\"2960e7b486a23584\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/autocomplete.js\":\"dbb616b51f3e5850\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/fieldRow.js\":\"8540249af7b4ccae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/index.js\":\"da3d59624d718d7d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/referenceWarning.js\":\"5ea8f4c35e889a4d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueAutocomplete.js\":\"31bcf844ed40521b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueSchema.js\":\"aeabda21b2de19ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/HeaderItem.js\":\"e3cc83fb885a8f57\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/QuickFind.js\":\"868c56f2b8244bdd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/index.js\":\"723408bbcba2bf60\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/recents.js\":\"8c284f4464ed35b3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/resultItems.js\":\"dc30939d65bda51b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/selection.js\":\"424d6eb439080e17\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/toggleStore.js\":\"e0f9b34451a55d0c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/HeaderItem.js\":\"71eb2aa9160f8879\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3746843f6b2906b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/grouping.js\":\"b7df2861c02e21c6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/index.js\":\"8ef0592555cc52c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/target.js\":\"66573cfeeb701b98\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/codeMirrorExtensions.js\":\"50ee4f35aed535a1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/contentPrefill.js\":\"f1f75a5e28a2cd11\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/dataExtension.js\":\"706d71859e3d349e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/index.js\":\"f052d1cbf83309a2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"52a26dfe57ad8ea9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/invalidation.js\":\"5cf58475297e275c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/localSchema.js\":\"979d1080a86f433e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/index.js\":\"913d5bfed351dd5a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"77f3941fb0ad6f22\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/index.js\":\"cef8db59f4280e51\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/referenceNode.js\":\"d9d2c220ef175658\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/remark-reference-occurrences.js\":\"173f3b24359823d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9a2e0cfc8872ff06\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/index.js\":\"ab9254684564d9ed\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0223bd79d7645250\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c11749fb5ad880f8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/mergeRetargetProcessor.js\":\"62c1df1d388b0d3d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/parseFence.js\":\"1ba0067d301110af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceParser.js\":\"688afa2d241fab0b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceProjection.js\":\"2b44527fe3394d79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referencesProcessor.js\":\"c6a91b5983891940\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/renameProcessor.js\":\"18ba7458b287b97e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/spanReplacement.js\":\"77fb10f21b014521\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/htmlToOutline.js\":\"c56da9f7c652eff2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/index.js\":\"ee8ff3b98fcbce8f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d004967f87dca1df\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/pasteDecision.js\":\"d918d3939c9906f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/action.js\":\"ae7de975dbf22623\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/blockIds.js\":\"f6edb318a158b8f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/content.js\":\"01c49ab6b70303ab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/effect.js\":\"0af75476732a882e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/ids.js\":\"b356a8678ade4b61\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/import.js\":\"d2bd9b1e5178260e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/index.js\":\"ea3f4ca49ac594da\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plan.js\":\"75db57822a677c7a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plugin.js\":\"006ff7787f0e517f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/promotion.js\":\"7675a887d6a596c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/properties.js\":\"30d3018bd28d3e61\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/references.js\":\"ec5406c506ee5d73\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/report.js\":\"92b9b591f5f297c9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/roamMemo.js\":\"114178cf386a2a97\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/runtime.js\":\"f361e591dc4599bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/schemaReconciliation.js\":\"f92310ab1a8c95ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/srsMarkers.js\":\"5a378aea43799a5e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/todo.js\":\"2bac36fe5d40d699\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/typeCandidates.js\":\"1f3dfa82264895a0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/types.js\":\"e287ef9d5e6ad8ea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/index.js\":\"cb71450c63c91594\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/store.js\":\"a7eee78f7fd6aa2b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/HeaderItem.js\":\"67d5708cdf22caf0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"434a71e9dc0044c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/index.js\":\"e566d98b93adeefd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/model.js\":\"376de93c8ec5b060\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/toggleStore.js\":\"9051be4251a81000\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/useKeyInspector.js\":\"45188fcfd6c5e223\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8e2d3d056e4769f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/ShellDecorator.js\":\"afb3222e28f1bfc3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/actions.js\":\"cd413289d252f253\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4d0677a9e6ad8c6c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/index.js\":\"8a86eebeda897acf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/shell.js\":\"15e4cc7ca173364a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/surface.js\":\"b5bfcd74e19a7c3f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/walker.js\":\"7977fe64636c40f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/RescheduleToast.js\":\"12e64ee6d96d3bfc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/dataExtension.js\":\"0b4ff3a83f48aa0f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/index.js\":\"4cb6c430bc10d65e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/indicator.js\":\"aeac3a0590097adb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/moveSrsState.js\":\"fb6345b7d432a93e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"51ddbba25efe30a2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/scheduler.js\":\"a52a59e5cb423d4e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/schema.js\":\"2c291d245f726fe1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"315e51e6fd1ed6b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsClipboard.js\":\"09649be0b936482c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bf647f5d88db91ad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DailyNoteReviewHint.js\":\"dd3c9f784eb2c87d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DeckPicker.js\":\"4fe860624a319988\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewControls.js\":\"95eb9e00cd1ffb31\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1574ea22b40e6335\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewSession.js\":\"4e87c241c9dfcc29\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/actions.js\":\"89ab9e6186a2262f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/archive.js\":\"06644a9e4681511e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dataExtension.js\":\"362387b39c4281d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/deck.js\":\"070c8a0127c58042\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dueQuery.js\":\"9e4e06fe0ffb690c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/gradeDecision.js\":\"57de85642a4fd38e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/index.js\":\"a661faa50f9f8fe0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/keyHints.js\":\"1377d6f9f56363b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewCardLayout.js\":\"662b35cf6539d959\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewProgress.js\":\"3fc9a012be5ebe71\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/schema.js\":\"79fd5c6a300becd1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/useDueCards.js\":\"302a835b1c386ca5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/index.js\":\"5741cc45e06d3c71\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/record.js\":\"87b40b5e2a8d5cb9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/index.js\":\"7bff51edd4d09495\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/persistenceStatus.js\":\"43b2d2a26d3f3da9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/requestAction.js\":\"c23821c04be89cbf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/TypeChipsDecorator.js\":\"9d591cf8fcca94b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/codeMirrorExtensions.js\":\"397d416294f8524c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/index.js\":\"271c3288b16f1eb2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/typeAutocomplete.js\":\"97e391a472085034\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"142dcfa99dc6fe3b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/actions.js\":\"473991bfc86b319e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/anchor.js\":\"64ad6a9134395b19\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/events.js\":\"658ad3daa302e4f5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/gestureActions.js\":\"d27e02a6b63d2846\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/index.js\":\"03b1cddb2ac1c913\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d2e2827bd6e6e0ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/collect.js\":\"9a5a6c8d62eea178\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/index.js\":\"83d95502b53f995c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/record.js\":\"e6569c1ed8b08616\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/RejectionDialog.js\":\"b05eb15a99ab4af0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/SystemStatusHeaderItem.js\":\"964170f672e0dde3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/index.js\":\"ae2091ebb3ef6ce9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/model.js\":\"55a0a497a7e696c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/queueCounts.js\":\"fcdaa6d9e3f43f09\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rejectedHelpers.js\":\"344c60e4771e9819\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rematerializeAction.js\":\"ad4db5368892b81f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/useHysteresis.js\":\"11a2915ee92e1e9e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/ColumnHeaders.js\":\"b4f6c2c19e69abbb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/QueryUi.js\":\"7f8382d362af9de9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/TableLayout.js\":\"10e85c9582a86eee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/actions.js\":\"6287a3e44e797e72\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/cellEdits.js\":\"e90d081db8de60ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/columns.js\":\"c78b8182cd751d5d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/controller.js\":\"7f5f974036745c5b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/convert.js\":\"083cdc4477e8a838\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/dataExtension.js\":\"b9c8648a12b2b3b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/index.js\":\"fcb511876b89402d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/keys.js\":\"3a55d5592b3b5df1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/model.js\":\"88e6eda325b14004\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/navigation.js\":\"b8a0e3ccf639bbdc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/backfill.js\":\"e57cae710390c52e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/completion.js\":\"6e205b2919c97a7c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/format.js\":\"61975f8dd8f00db8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/parse.js\":\"ff0364e430634aa4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/queryValue.js\":\"cefb936592284e79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/source.js\":\"c48df57587853b2c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/registry.js\":\"edca6d8f1d3b388c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowGutter.js\":\"017bda19ea31e3fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowVerbs.js\":\"2c5dd6909b93b0ab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/schema.js\":\"3c2cf44fef5df959\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/sort.js\":\"fc1cd803de3cdd23\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/effect.js\":\"796cc7340709c948\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/index.js\":\"f79061d3182dc02f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/theme.js\":\"506c9a14428e97f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/actions.js\":\"99b47d326c4d4192\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/dataExtension.js\":\"6915a4d2e2a629ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/index.js\":\"38a1a7fc512f8d8d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/schema.js\":\"c20c3c65058969ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9169b0b5c5fa236d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/actions.js\":\"ee72d4e2baa109ee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/defaultItems.js\":\"0e75d7fa866d049d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/facet.js\":\"76afb09d0477f4b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/holdRecognizer.js\":\"90eace2d373391c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/index.js\":\"1f4c1214cbab9dd2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/UpdateIndicator.js\":\"e72939752172d556\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/index.js\":\"4e83ba1acee5c99b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/loadTimes.js\":\"75aa31ad822211b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoNotesRenderer.js\":\"2b20d12f3f1a7aa0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoPlayerRenderer.js\":\"f9a18510db3c62f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoTimeStamp.js\":\"1c1371f384c8f267\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/actions.js\":\"46e546f7d5be22ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/index.js\":\"5bd294c8fb9c6dc8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/markdown.js\":\"a10f06ad68f4af2d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/notes.js\":\"5e96f17395af53fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/registry.js\":\"7d5cf85bcd54a60a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/remark-timestamps.js\":\"d9bff0285acc89fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/view.js\":\"24d5f138009aede4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/LinkHints.js\":\"d3a144ddcaa14d8c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/index.js\":\"fccf47b2cd3fbde2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/model.js\":\"82ed7dc766ee6074\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/settings.js\":\"cc89bac579cd1f14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/actions.js\":\"818e4d1f00e9bc6b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/index.js\":\"4b7d59369e671db9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/interactions.js\":\"03c6bffbc8e28e27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/workspace-header/index.js\":\"8b9344a4ea3bcc86\",\"/knowledge-medium/pr-preview/pr-1855/src/registerServiceWorker.js\":\"9f3fee9c5fc89d88\",\"/knowledge-medium/pr-preview/pr-1855/src/requestPersistentStorage.js\":\"b52dcd64c05b593f\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authRequestDeadline.js\":\"e12650a7492ad9c2\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authStorage.js\":\"42b4c50b1627bd9d\",\"/knowledge-medium/pr-preview/pr-1855/src/services/powersync.js\":\"0cd84384ad073f60\",\"/knowledge-medium/pr-preview/pr-1855/src/services/supabase.js\":\"4e3beefe0c6cfa3e\",\"/knowledge-medium/pr-preview/pr-1855/src/services/uploadErrorClassifier.js\":\"4ca26167f4008681\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/ActiveContexts.js\":\"0dbdfb1d89613313\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/HotkeyReconciler.js\":\"76fe05153163fdde\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/WipeLocalDataDialog.js\":\"6e05bc67f6db3784\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionDispatch.js\":\"e06aa9cabc49517f\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionRefItems.js\":\"fe801dca80bf20e4\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/applyKeybindingOverrides.js\":\"acb61b984c144f56\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockActions.js\":\"53048875e7296340\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockMergeGesture.js\":\"98aa7707c41c472e\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/canonicalizeChord.js\":\"55e5b4c74f5bd467\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultContexts.js\":\"db85e535031723d3\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultShortcuts.js\":\"77342f4e5db3575a\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/effectiveActions.js\":\"ee08b255ddccefa9\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureAction.js\":\"0e8525b7d3ea0b76\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureBinding.js\":\"a7f860f25c58c2bd\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/holdRegistry.js\":\"d4426f6989721dd6\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingConflicts.js\":\"ca8c862eb6a2d602\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingOverrides.js\":\"853ca8e810e580f1\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/pointerAction.js\":\"f37d1af9c4a2f92f\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/resolve.js\":\"3020caaa21101a47\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/runAction.js\":\"d2257e31a18ff510\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/sequenceMatcher.js\":\"5c098461f9603dcf\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/types.js\":\"f0f91be50c4606e2\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionContext.js\":\"7dc9ca254f08ab85\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionDiscovery.js\":\"5a1d80a6132b00a4\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/utils.js\":\"590a7ccfb1bfab76\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/bootStore.js\":\"6b05953030f32d50\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/previewDatabases.js\":\"4ae0d6b40c3fb431\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/byteTransform.js\":\"4fef5581b34447b1\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/attachmentCleaner.js\":\"8d61827947399a36\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/attachmentParts.js\":\"09e907cf3d6617f8\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleParts.js\":\"5cf368472a83bd43\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleRecord.js\":\"4fbd78fa0a960c76\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/manifest.js\":\"14eca30c6f1e1c57\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/takeBundle.js\":\"953813b5e8def769\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/verifyBundle.js\":\"11f766a86b38a08b\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/cleaningStage.js\":\"5b6b16df9a534fa0\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionKey.js\":\"a3609208607cf911\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionServer.js\":\"a7c5fc3d7ec3bc6d\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flip.js\":\"ba9d924c84a53861\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flipAttempts.js\":\"582f5e73a89aad15\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/pages.js\":\"532b3b3da8214385\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/preflight.js\":\"51e87685ced4e2a2\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/reseal.js\":\"d8ccb0c5a923170e\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runConversion.js\":\"1adb4dee4a84a802\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runLock.js\":\"f2e4e7a1de8be282\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealing.js\":\"98cfa4adb6f5400b\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealingStage.js\":\"794c7a09fcef40a5\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/stage.js\":\"b501227e7c4558cc\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/verifyReseal.js\":\"1197928526c7a0cb\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aad.js\":\"9fc87904b45f7d70\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aead.js\":\"5a788184d3954ec3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base32.js\":\"5f7e78ad9f0d73c3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base64url.js\":\"c78cdc25020f81cb\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/binaryEnvelope.js\":\"da2d567bd019be91\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/byteAead.js\":\"3e787c036acdceae\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/canary.js\":\"0d89588c2a0a2184\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentHash.js\":\"39aaabbffc384e6b\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentKey.js\":\"fa720df854096f82\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/derivedIdNamespace.js\":\"56c746b578f87331\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/envelope.js\":\"834ee813cc9172a4\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/hex.js\":\"b031880507cf8404\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/sha256Hex.js\":\"651822dfcf6e2fac\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/workspaceKey.js\":\"6ff4292dca290919\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/conversionState.js\":\"84b88a3c91ec8e57\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7bd14400ccfcb169\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/pastedKey.js\":\"c513217158cb1e66\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"24a0fdf63b1c1fb3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9b07ab34292ebd39\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/keyStore.js\":\"4a1681d25facec36\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/mintWorkspaceKey.js\":\"486bb9638a6fcc3a\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/modePin.js\":\"3bfece49812a5a8f\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/openWorkspaceKeys.js\":\"2905bc5c521734d0\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolveWorkspaceEntry.js\":\"18c5df2de807c6cc\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolver.js\":\"1a6633934d42f959\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/workspaceAccess.js\":\"b263d08e4d8bdb16\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/transform.js\":\"f374b897d13037e2\",\"/knowledge-medium/pr-preview/pr-1855/src/themeBootDefaults.js\":\"0a7ad0bc655aa107\",\"/knowledge-medium/pr-preview/pr-1855/src/types.js\":\"69e282b548356d04\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/ClientLocalSettings.js\":\"d2c29609ffe7c732\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/abortableSleep.js\":\"2d4bb157c8682046\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/array.js\":\"5e1a08430e0e1d20\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/backlinkAutocomplete.js\":\"aa1e5cc861450dd9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockCrumbs.js\":\"a951dcf327c51736\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockrefAutocomplete.js\":\"6e0963b371f966d1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/cadencedIdleJob.js\":\"f67196304da5c5b2\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/callbackSet.js\":\"bd57385ccc1f5d04\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/clientId.js\":\"b8af7d5917e1f476\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirror.js\":\"ff21a579b34cfec9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirrorCompletion.js\":\"f7ace8e340d1ab53\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/copy.js\":\"82b5c2fbf8e233f5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dailyPage.js\":\"cf47b887b86ccdbe\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensics.js\":\"b8c716afe8c09ce6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensicsHooks.js\":\"68f18e0ec7290244\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/deleteBlockThroughUi.js\":\"6c0d19fc5e836d22\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dialogs.js\":\"3f6c43c827e77135\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dom.js\":\"0647578f5b485fa7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/downloadBlob.js\":\"a62894f7bf53dbdc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/exportSqliteDb.js\":\"11f8feb70cc61fbd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fileSystemAccess.js\":\"74efbeb901cc1b55\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/flipSlide.js\":\"248204ba9aa3b7b4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fnv1a.js\":\"3c00f90dd46376a4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/formatBytes.js\":\"854406b682ac0069\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fuzzyRank.js\":\"3d613f36c31f0696\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idbKeyedStore.js\":\"bf1ad37aebaf0466\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idleCallbackPolyfill.js\":\"fc3e4804bb01e8e8\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardAwareScroll.js\":\"873223f5d86854ca\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardViewport.js\":\"ad5ce6d52c29450c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/lastWorkspace.js\":\"05cc87e9c69221fc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutColumns.js\":\"934c3eafb905c50a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionDom.js\":\"b7c7847c5ff66646\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionId.js\":\"a7ea6cd462ff17cf\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkClickGestures.js\":\"c3d6cc1d4ff3ecdf\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkTargetAutocomplete.js\":\"e1a695841006103d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbCorruption.js\":\"e662352a83dae31b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbRecovery.js\":\"ed0f6158caf05828\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/markdownParser.js\":\"d12065893b5778e9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/memoize.js\":\"0e3e4200ee117488\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameFieldCommit.js\":\"e567acfb0aa7d42e\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameList.js\":\"c8ffe599f996a68f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/navigation.js\":\"cf7c3a7cbdc6975c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/omnilinerNamespace.js\":\"0abdeec3a28f04a2\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/opfsPageScan.js\":\"2e5f37b834d8b763\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelClearance.js\":\"9614f8ffe4c53182\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelHistory.js\":\"b11f2d0207e7fcec\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLanes.js\":\"68b94fb9bd2938bd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLayoutProjection.js\":\"f068f4465d355b2a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelScrollAnchor.js\":\"bd2c132102e691a7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelUrlFlags.js\":\"f21e333399bbf078\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/platform.js\":\"48ad0fc6e02be6e4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/pluralize.js\":\"9120fedbfbf73810\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyCreation.js\":\"bb74288d6de5be15\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyNavigation.js\":\"fca1681502c1b522\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyValueContext.js\":\"36d6ab574b59f860\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/react.js\":\"48f2174c803fdc63\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeDate.js\":\"a195d883d95004a9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeTime.js\":\"0ba850927183a42f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/renderScope.js\":\"99f72d087092bdad\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/resolvedThenable.js\":\"728338f402d5ab30\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/routing.js\":\"4b56c28fe03b1c8d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/safeMode.js\":\"bf6151169b6c7f9e\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/scheduleIdle.js\":\"d93329f94b2ebe6f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/screenWakeLock.js\":\"f9879e92146f5c02\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/selection.js\":\"3fc930a070f79a64\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/softKeyboardGrab.js\":\"772bebb1c530962b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/startupTimeline.js\":\"99da4578ceb4784f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/state.js\":\"49e5b546e64370b6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/string.js\":\"172befed7dcb7414\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/surfaceZoom.js\":\"680f8f9812b38a71\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/time.js\":\"48909069af0cbc2c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toast.js\":\"97c3a069d2531d15\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toggleStore.js\":\"8dce361df64450a1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/untilStopped.js\":\"b7f9d8499109bbc4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/userActivity.js\":\"d9640119974eb278\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewTransition.js\":\"0dbb830e288e169d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewport.js\":\"a82e2301c1787f11\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/webLock.js\":\"9df86133c4409748\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceRecovery.js\":\"e092f23b3a7be76a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceSnapshotStore.js\":\"86791c23ec55987b\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-compiler-runtime.js\":\"fe257acca5a6b3a6\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-client.js\":\"87f245de318b3ed8\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server-edge.js\":\"7855ee1149137183\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server.js\":\"e6225f760f4d4bfc\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static-edge.js\":\"e8fc969464a1318b\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static.js\":\"c04757f4d51c45b2\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-test-utils.js\":\"18cc4b0049c6c8c8\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom.js\":\"a7068b748d99b6aa\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-runtime.js\":\"7bfaac3383a473a6\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react.js\":\"6a97928222fdec5d\",\"/knowledge-medium/pr-preview/pr-1855/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
