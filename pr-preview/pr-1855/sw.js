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
		buildId: "d5600d40c93b-1fb4d011",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/\":\"208a5fab6b42b7e2\",\"/knowledge-medium/pr-preview/pr-1855/index.html\":\"208a5fab6b42b7e2\",\"/knowledge-medium/pr-preview/pr-1855/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1855/assets/FacadeVFS-Bu1YjWDF.js\":\"8e1444f7af15783b\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSCoopSyncVFS-CSA8m7cM.js\":\"e45ae75fa125d0d2\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSWriteAheadVFS-Btf_B063.js\":\"dbba5f9bce1c5087\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-B0ISJw71.js\":\"5ebcc8a2224eef71\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-BMCXHq2c.js\":\"13e9dfd16ef80877\",\"/knowledge-medium/pr-preview/pr-1855/assets/worker-CqYrfOYn.js\":\"3960d3628264e5e6\",\"/knowledge-medium/pr-preview/pr-1855/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1855/chunks/app-r96OwSVe.js\":\"a37ca316cbdcd759\",\"/knowledge-medium/pr-preview/pr-1855/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1855/index.js\":\"45c40a56dc5734e6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1855/assets/AccessHandlePoolVFS-Cin_mKV7.js\":\"70c864b059872b65\",\"/knowledge-medium/pr-preview/pr-1855/assets/IDBBatchAtomicVFS-BHUIinYu.js\":\"dfefd7d4bb5c010b\",\"/knowledge-medium/pr-preview/pr-1855/assets/MemoryVFS-Bn5_JK03.js\":\"13d8c8c64204af9b\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-C9-B-XoZ.js\":\"55d6363f64e5a535\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-CprHVz1C.js\":\"5508f5e11e7ec0ef\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1855/chunks/AccessHandlePoolVFS-DjBIDulB.js\":\"667298767bd3092f\",\"/knowledge-medium/pr-preview/pr-1855/chunks/FacadeVFS-DIpTxQAF.js\":\"891a2e4f0c35cac6\",\"/knowledge-medium/pr-preview/pr-1855/chunks/IDBBatchAtomicVFS-DLOAETHV.js\":\"498b29f140723b74\",\"/knowledge-medium/pr-preview/pr-1855/chunks/MemoryVFS-BrL0EmAf.js\":\"5edb7f4a0fb19832\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSCoopSyncVFS-BjV3LUN0.js\":\"64a66e2b4bb23ac8\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSWriteAheadVFS-DhExCaju.js\":\"bec2eb33793c54b4\",\"/knowledge-medium/pr-preview/pr-1855/chunks/Preview-DZO3fpLL.js\":\"dbf845a886ae898d\",\"/knowledge-medium/pr-preview/pr-1855/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/card-BZdtn2lE.js\":\"ef88c7e6fca8aafe\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-gBP73H_7.js\":\"0757533dea5c451b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-CJU1VvMQ.js\":\"4dea43806e4ca59b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-async-CVK4BPfn.js\":\"a833d89b81e39d72\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-6a2Z88zx.js\":\"4bb6a52f5e544f37\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-BBSKk281.js\":\"5fff8b0802768a7e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-BWu5AhXD.js\":\"41b9df1390799eb5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CDTXX8SW.js\":\"2288650d6f35af0a\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CYzE41N8.js\":\"3dc560e43d62fdf7\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-D6s38nCB.js\":\"a859572dce65edcf\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DYsCciLA.js\":\"cb1422829919f00c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DtFP79Y7.js\":\"0e526c074cd74e0c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server-legacy.browser.production-CP5P7D_7.js\":\"69eea4c0a5fdca0f\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.browser.production-WgAteiUM.js\":\"33269c95afa40a3b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.edge.production-BmAZE9vT.js\":\"9efc2b63719db3d8\",\"/knowledge-medium/pr-preview/pr-1855/chunks/server.browser-DE_AETRa.js\":\"206d67f2f148e751\",\"/knowledge-medium/pr-preview/pr-1855/chunks/textarea-CeYMFVhr.js\":\"fddd30b33dc298e8\",\"/knowledge-medium/pr-preview/pr-1855/chunks/ui-CzC-afb3.js\":\"1741e85d87d3a8b7\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-DPxMUF07.js\":\"3104a1c87d9a5202\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-async-DHDdnHGh.js\":\"65aa5a1bea4082b5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1855/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/src/App.js\":\"b676e3826123b710\",\"/knowledge-medium/pr-preview/pr-1855/src/appUpdate.js\":\"3c2459186d13a676\",\"/knowledge-medium/pr-preview/pr-1855/src/appVersion.js\":\"ccec7b030611db19\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/initialLayout.js\":\"bd4064101155e06a\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/openWorkspaceData.js\":\"00c0919feb5d7d02\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/resolveWorkspace.js\":\"9b1db17f2d3105eb\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/workspaceBootstrap.js\":\"5652a67966e929b9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockComponent.js\":\"8e79a73d7469d25a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockCrumbs.js\":\"225f1cbaffe0c3ee\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockEditor.js\":\"2fcb90e17f71196b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockLoadingPlaceholder.js\":\"ed74a3ed29442d85\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockProperties.js\":\"917a82628f0544d0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockSearchPicker.js\":\"a47b8f66e3eb9b2f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ConfirmBulkDeleteDialog.js\":\"54bdd57a96272684\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DividerHandle.js\":\"4c453a59570b1bfd\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DraftEditor.js\":\"3a2b2273c2978a38\",\"/knowledge-medium/pr-preview/pr-1855/src/components/GutterPill.js\":\"bd965c28d646636c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Header.js\":\"6b50a62db5ad39c8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/LazyBlockComponent.js\":\"5a24e1cf98d6a941\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Login.js\":\"f123a67011f27e06\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ZoomableSurface.js\":\"73c7491428bbbc2b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/editModeKeepalive.js\":\"e0cf3d6eb38bd1c7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2e5e5a8e0af99ed3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4e093f7436ac4b46\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefPropertyEditor.js\":\"d5f1040b0b7f7d61\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefTargetTypePicker.js\":\"af6b16070b1fd62b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/SelectPropertyEditor.js\":\"a25770c2df124824\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/TypesPropertyEditor.js\":\"c1506f22ba6893de\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/defaults.js\":\"fcded834b2d2c438\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/kernelValuePresets.js\":\"0c15d1f5dd4ec352\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/selectablePresets.js\":\"bac5665fdf346338\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/typesPropertyUi.js\":\"d73606058661987c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/AddPropertyForm.js\":\"49f7a9dc71e25acc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyPicker.js\":\"b185dbd6ce10f922\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyRow.js\":\"35d4cf6ae976c2db\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/Rows.js\":\"8dd306aaab2fafa7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/actions.js\":\"fbcbbf4f2dea734a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/declarationOnly.js\":\"c72fc6fccd4a035a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/layout.js\":\"b3fc588fe290ba00\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/model.js\":\"8dd5983e855e3db6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapeUi.js\":\"84a48abe7387e9d3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapes.js\":\"8ebe3c19fc683c90\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/usePropertyEditingActivation.js\":\"72bbc135f7db5271\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/visibility.js\":\"f06f5a26ee88f9d9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanelSections.js\":\"22cbc336d5c3d9c2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockEmbed.js\":\"626dd4dc3c63fa0b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockLink.js\":\"1af8422b5ff36e67\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockRef.js\":\"08c903cabcd402e8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/ReferenceLink.js\":\"ba0e5c8999cfbdc5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuard.js\":\"97826c7c00a03e73\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuardContext.js\":\"7b395cc5a174d321\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/linkInteraction.js\":\"0ad193f44fffc0f1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/referenceLayout.js\":\"a8a774cb7bb45aa6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/useBlockRefAncestors.js\":\"aece8ffa62ff388f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockGutter.js\":\"f1cf1559378836ce\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockInfoDialog.js\":\"a3e128d557f6e0a5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockTypeBlockRenderer.js\":\"ac6f34f5551c1185\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BulletHoverCard.js\":\"2de54f77a63d135e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorContentRenderer.js\":\"b15231b2cef64bc2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"62a42bf39737a533\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ColumnResizeHandles.js\":\"b61696627bdb013f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"03e0cea16d954b4a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/DefaultBlockRenderer.js\":\"75ef03bd14748abd\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/LayoutRenderer.js\":\"ed1aeb3253efb90d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MarkdownContentRenderer.js\":\"b86397adab9764e0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MissingDataRenderer.js\":\"105c84ff202aa199\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PanelRenderer.js\":\"90c2275fbdf98448\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6ecb595d0cd878be\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/TopLevelRenderer.js\":\"9de1a0e8a65e40ad\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockGutterMode.js\":\"987ad49141deadce\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockTitleText.js\":\"48aff226c8b99d76\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/fieldCreationKeydown.js\":\"c7c5b976e18fe5b8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/layoutRootContext.js\":\"511c69989ad907c6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/TypeChip.js\":\"6e288f2e1a889531\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/chipStyle.js\":\"f2e72e99a138c85c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/anchored-floating.js\":\"136677cf37b4719e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/button.js\":\"88a2ff7e1e767e95\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/card.js\":\"9c19abd802ff77b7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/checkbox.js\":\"f0f26e0b152e7cd4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/collapsible.js\":\"c48a1e7deca68d7c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/command.js\":\"355633c495d11f77\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/context-menu.js\":\"f09fa3eaf52a9c71\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dialog.js\":\"233f7140b1d7c007\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dropdown-menu.js\":\"4f467923d70deded\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/floating-listbox.js\":\"91f476942d5f00c5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/index.js\":\"143ff57a7ae176fc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/input.js\":\"a7807a23ade2b7f9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/kbd.js\":\"319ee7debb32b547\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/label.js\":\"e07189680aead579\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/textarea.js\":\"3465c7379e44c277\",\"/knowledge-medium/pr-preview/pr-1855/src/components/useEditModeYieldKeepalive.js\":\"5f884775d77354d2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/BootFallback.js\":\"525dd8a08681a497\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/FocusedRowLazyMount.js\":\"0a80803228b339fe\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LazyViewportMount.js\":\"5e8c32ca7f197fd0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LocalDbCorruptionFallback.js\":\"d190a3e7791841a7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/error.js\":\"1fd23d86279fb66a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/lazyMountRegistry.js\":\"f062f2e92029a653\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/suspense.js\":\"e0568f3f0c2cab4e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/CreateWorkspaceDialog.js\":\"6b5250a0889771fa\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/PendingInvitations.js\":\"5c6c029008e2c1d5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/SyncProgress.js\":\"200b744fc7d6d7ea\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/UnlockProgress.js\":\"f917e3adc6aa6282\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceKeyGate.js\":\"5e5d6a97c253819e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSettingsDialog.js\":\"e8fc6e9678a7da6c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSwitcher.js\":\"f990f244272155c6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSyncGate.js\":\"9d15ff5f83479c54\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlow.js\":\"3514184419963610\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlowHost.js\":\"834dae6d980ef6e4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/EncryptionSection.js\":\"d226c45623a5f775\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/attachmentPrompts.js\":\"735cb83dfb77fa44\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b6ee81273dd00a8f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowDeps.js\":\"67958cdd75587783\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowStore.js\":\"68437e1d1eb781d6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/flowUi.js\":\"3aa2102d5bd07e4b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/useConversionRun.js\":\"3669e512104f15d0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/keyUi.js\":\"857bbe35c815ca8e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnKeyLoss.js\":\"7a0f44179cdeafb1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnServerE2ee.js\":\"e2086105cce2da69\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/workspaceUnlocked.js\":\"99ba5b5e8f6ff7b4\",\"/knowledge-medium/pr-preview/pr-1855/src/context/backgroundSubtree.js\":\"4a98dd10a3c6a11b\",\"/knowledge-medium/pr-preview/pr-1855/src/context/block.js\":\"4cf70df6f5dda254\",\"/knowledge-medium/pr-preview/pr-1855/src/context/layoutWsContext.js\":\"3392b9e57abf3fe0\",\"/knowledge-medium/pr-preview/pr-1855/src/context/propertyDisplay.js\":\"620e231fe72a61c3\",\"/knowledge-medium/pr-preview/pr-1855/src/context/repo.js\":\"c20cc582633cc393\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasClaim.js\":\"cea596bd936c4993\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasSeatNamespace.js\":\"7e9e3aaf52cb8e4b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockData.js\":\"5d894fe0ad2f5223\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockType.js\":\"f06b393003d1117b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/changeScope.js\":\"5f169c243d2c95b1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/codecs.js\":\"c8595c898aa80e85\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/derivedData.js\":\"9b995431c68aa397\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/errors.js\":\"846bd62f1ecade3c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/events.js\":\"29ff0fcb8d8c7844\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/handle.js\":\"2bec766e0ea30805\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/index.js\":\"5f42ecf1ec7fcb23\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/mutator.js\":\"b7ca5374d607b0be\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/processor.js\":\"6f459cb163f46c4a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/propertySchema.js\":\"5a521d1f4041d985\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/query.js\":\"87f115686d49a5d6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/sameTxProcessor.js\":\"320dc826364d9ed2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/schema.js\":\"2bec766e0ea30805\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/tx.js\":\"2bec766e0ea30805\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/typedBlockQuery.js\":\"d8896fcf8d903ccf\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/user.js\":\"84d442472c78bf10\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresetCore.js\":\"1ba2e27e6bb19f3b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresets.js\":\"1bf7c9da3b7bde72\",\"/knowledge-medium/pr-preview/pr-1855/src/data/attachmentCleanerIOVerb.js\":\"b78096e137568bc7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/block.js\":\"471097783cea085e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockCache.js\":\"d38b71a1867488f1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockId.js\":\"ba8293f1e9b382fb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockLiveness.js\":\"0600a3e569bdd302\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockMerge.js\":\"c20ed4587bfc9634\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockSchema.js\":\"fc2d76116442d291\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypeLookup.js\":\"38b1b934ca69df33\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypes.js\":\"23355a536203b4ab\",\"/knowledge-medium/pr-preview/pr-1855/src/data/childrenView.js\":\"6f4fc7d8951e3ae6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/clientContext.js\":\"03dfccc38f30fd2a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/dbFileSiblings.js\":\"878c6ae115b5711d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/definitionSeeds.js\":\"96b3125f31ed5151\",\"/knowledge-medium/pr-preview/pr-1855/src/data/derivedIds.js\":\"b797a2daee3dc0d7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/drawnSubtree.js\":\"b60da619b362c745\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facetBridge.js\":\"b3d6e65742f08d57\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facets.js\":\"a5dfbc6fb87d3de6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/globalState.js\":\"ab4bbbd5de6019dc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/aliasClaimRederiveProcessor.js\":\"578900f6fbfd501c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/ancestorBatch.js\":\"36df3bef6acecc7d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/blockTypeTypeifyProcessor.js\":\"3b7ae38dd11a72c2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/clientSchema.js\":\"1fafb959d4276cd8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/commitPipeline.js\":\"a681a5d4fde4af3b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/devAssertions.js\":\"78d3a7c0f113940d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/firstSync.js\":\"657fa7f1e2c70d0b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/freshInitialLoad.js\":\"53367bb3f1d8f358\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/graphBackfillClaim.js\":\"85475d98087a21cd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/handleStore.js\":\"094467431b169646\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/idleMarkerJobs.js\":\"e7b09afd2a9670bb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initialDownload.js\":\"ba9f9f4fad5d1ece\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initializeClientDatabase.js\":\"daf6299146bdc5df\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/jsonCanonical.js\":\"1ed43921301fa2db\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelInvalidation.js\":\"c3989a110556d79d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelProcessors.js\":\"75fae631fa22eac9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelQueries.js\":\"b4c72d3a5fb7d8f1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/mergeTypeMembershipProcessor.js\":\"cc911630e8e70b59\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/normalizeReferencesProcessor.js\":\"89cabe0d7d33b45f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/poolInstrumentation.js\":\"16c518b969926e53\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/processorRunner.js\":\"a892d55f04b81090\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyCellBackfill.js\":\"1a2386dbe9915a3f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildMint.js\":\"1c3890965877f1ce\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildrenProcessor.js\":\"622b7d5e53ad5f34\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionChangeProcessor.js\":\"353ebd20a8d1dc6d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionSynthesis.js\":\"57abdfd0bc0d57e0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyKeyScan.js\":\"463124fa3df25849\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertySchemaResolution.js\":\"e18cfbb7a72cc784\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyValueEdits.js\":\"2912fd3de08ae91b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/raiseProtocol.js\":\"a6b122f57ab4de94\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/readBatch.js\":\"bb2455da3de833f5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/refProjection.js\":\"6298ce69441525ea\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetLookups.js\":\"3bf1c6833b40c8bf\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetProcessor.js\":\"44c89e8cc287d043\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/replayMerge.js\":\"4ca1b6bf18a7e32a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/sqlBinds.js\":\"e6d9a7ef108c61e9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d920a7c2d49b1b30\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/arrivalProcessors.js\":\"47f45fa196ebfd0a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/invalidate.js\":\"229c6047b8a87dd6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/materialize.js\":\"25790429dfee8b72\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/observer.js\":\"9be2ec5ed2809d94\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/reconcile.js\":\"15a3d7dbad3dc41f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/timingMetrics.js\":\"5b07f355deabbf08\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/treeQueries.js\":\"626f678c92d9aa94\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txEngine.js\":\"6fb6baed417ab963\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txSnapshots.js\":\"2924dac370dc7065\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/typedBlockQuery.js\":\"7cffc765cd873f42\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/undoManager.js\":\"872766e7f7832d7f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/invalidation.js\":\"11a67c0d607db0a2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelDataExtension.js\":\"029320e3ea299b38\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelPage.js\":\"1583d7ac5aa17af4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelValuePresetCores.js\":\"dec186e0ca4693cb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbCorruptionSignal.js\":\"bc7516486b3d310a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbStorage.js\":\"a385a4bc6f2a9cf5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbVfs.js\":\"2749f474ac914738\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localSchema.js\":\"f7b99429ce5a6b2b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/maintenance.js\":\"4b9b8dc7a68592bf\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mergeProperties.js\":\"dec3382523d06330\",\"/knowledge-medium/pr-preview/pr-1855/src/data/metricsConsoleHook.js\":\"9ac3cc858d5f166c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/migrationsPage.js\":\"e91c3aff2116276b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mutators.js\":\"c51318049fc7d3a4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKey.js\":\"37d15c0e93c930a3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKeyPlacement.js\":\"f8793016de307e65\",\"/knowledge-medium/pr-preview/pr-1855/src/data/outlineSurface.js\":\"94ecc251ee936cc5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingEditorContent.js\":\"63224e5a0f10d5ac\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingUploadsSql.js\":\"a6e283d9892e741b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pluginStateExtensions.js\":\"144ca2b1cd7d3980\",\"/knowledge-medium/pr-preview/pr-1855/src/data/powerSyncLogger.js\":\"3657a95d3de72bee\",\"/knowledge-medium/pr-preview/pr-1855/src/data/projectorRuntime.js\":\"979e3b12f74d7c48\",\"/knowledge-medium/pr-preview/pr-1855/src/data/properties.js\":\"90e3b13772c25f97\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertiesPage.js\":\"84f7e5845a7c2418\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyChildren.js\":\"322a69d8c1588896\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionFanout.js\":\"82fd2143a2a2f866\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionMetadata.js\":\"9db3c7d98d4bee2c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionRegistry.js\":\"c0119138b11eda1f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDisplayMode.js\":\"0d8db206e1aaf468\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyRowCreation.js\":\"cc912bce3220d8c4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySchemaCreation.js\":\"b19ead99654c8f4a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySeeds.js\":\"4f24fb24a0dfa1a9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/recentsPage.js\":\"7c2d825c12d8ab47\",\"/knowledge-medium/pr-preview/pr-1855/src/data/referenceBlock.js\":\"a7f4a0ff7133e57b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rejectedUploads.js\":\"5ca5827d92633ac4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/releasePowerSyncConnection.js\":\"0ccc85b307befe28\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repo.js\":\"823fdf79d2db80a2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repoProvider.js\":\"062dd23042967e6e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rowProperty.js\":\"48cf985fca14e27a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/searchFilter.js\":\"9df41c69bc316a84\",\"/knowledge-medium/pr-preview/pr-1855/src/data/seedIdentityLedger.js\":\"2bd4fdf3d48333e4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/stateBlocks.js\":\"3e51c7b1e9af8e6f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/structuralEditPolicy.js\":\"4952710bf0cbe25a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/subtreeDelete.js\":\"7d42c085960313d3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncStreamLock.js\":\"065c1e7ab090e2ab\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableSqlRecognizer.js\":\"fdb1b64635d4d0e4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableWriteGuard.js\":\"7ceacdcfba1d7539\",\"/knowledge-medium/pr-preview/pr-1855/src/data/targets.js\":\"9ef4714f85313688\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeColors.js\":\"9cc1e89340867c7c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionMetadata.js\":\"7811987294d529a7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionRegistry.js\":\"f430c28b65d0abe9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeExtraction.js\":\"964f3fb1445d871d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeInitialValues.js\":\"7671662763fe6493\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typePropertyGroups.js\":\"e4e8f5e84bf0071e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeSeeds.js\":\"400f35a178b83f81\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeTagger.js\":\"6e313478c8d03021\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typedRecords.js\":\"ec4352b6fdb4217d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typesPage.js\":\"7de312b32a59204d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userPrefs.js\":\"c557a3c7c8cba733\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userSchemasService.js\":\"adffd7a5501eb9a9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userTypesService.js\":\"bda77301c1f01f14\",\"/knowledge-medium/pr-preview/pr-1855/src/data/valuePresetRegistry.js\":\"ae728ddd0a7d8249\",\"/knowledge-medium/pr-preview/pr-1855/src/data/visibleChildren.js\":\"5976e90619164260\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceConversion.js\":\"d658713df542a4c1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceFirstSync.js\":\"e5aa4a58106a21e3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceIdNamespace.js\":\"438567d780e650cd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceSchema.js\":\"83265c684adf6f57\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaces.js\":\"33bb5e9ed4ef5c45\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadLog.js\":\"317fbe103f42907c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/BlockPasteShellDecorator.js\":\"338b4f9845e99245\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/atTrigger.js\":\"6529616006becdd3\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/autocomplete.js\":\"89c5d080d3375914\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/codeMirrorExtensions.js\":\"9c13fb6d50fff648\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/contentFlush.js\":\"dc1a6f5f0753698c\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/defaultInteractions.js\":\"19a4ad76c2d763d7\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/editSettleSignal.js\":\"749822e721327d33\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/insertImage.js\":\"16fe225b6d013345\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceCompletionRange.js\":\"92184d2584ee35c5\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceTargetTypes.js\":\"0474833fefb28522\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/syntaxContext.js\":\"996070b787849867\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/triggerMatch.js\":\"3a3a77f798bd97c0\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/AppRuntimeProvider.js\":\"d60d59ab0952733e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/BlockFocusShellDecorator.js\":\"ca79bfa3c50d0855\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/ExtensionRenderBoundary.js\":\"a0b0c6098d89ac17\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/PanelContentRecovery.js\":\"a476b4475bf3e273\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/apiCatalog.js\":\"b63800b0fffc98ea\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/approveExtensionHere.js\":\"9d12ac4075882500\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/armedCutAppMount.js\":\"0375564845b02211\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/batchableKeyedStore.js\":\"1f583a2ad0a2b39b\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockInteraction.js\":\"80f8e8099cb241f9\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockSelectionAction.js\":\"71b0cf34bc231ade\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compileExtensionModule.js\":\"a838a3abe66f452a\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compiledModuleCache.js\":\"c3a214693da2a16b\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/continuousGestures.js\":\"a8f457b5d33694a8\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/core.js\":\"abbeeba9f0caefef\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/defaultRenderers.js\":\"1b431d58c9622077\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/definitionFanoutAppMount.js\":\"9caa489151da8347\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dialogAppMount.js\":\"ac1f1b2e8f47ecf3\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensionSeeds.js\":\"ba433e5062dad398\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensions.js\":\"5980394163559a15\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/exampleExtensions.js\":\"93e1fa3c3eb3e737\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionApprovalStatus.js\":\"bb5a6226f1eb9cbe\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrorToast.js\":\"9d3b4aa1525d9556\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrors.js\":\"6ef087fff51d772f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLookup.js\":\"dd5364ef2f3ee572\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionToggles.js\":\"2da4b617d55aa225\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionUtilitiesCss.js\":\"abf597b2943b2e60\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/kernelPageDeletionGuard.js\":\"5ffb4a86738eb20e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/liveRuntime.js\":\"b187396e47daf7b7\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/openExtensionsSettings.js\":\"aea9691810ee29e6\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/overridesCache.js\":\"33481c6f7822ac28\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/pluginIds.js\":\"da876a06fc1999b7\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/processorRejectionToast.js\":\"5e384b38dc6acf17\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeActions.js\":\"ece1e499bba1ef99\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeContext.js\":\"f266fa58e8cf9881\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticAppExtensions.js\":\"b57113d6dba86bae\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticDataExtensions.js\":\"a173d74b3129297e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/toastAppMount.js\":\"a2104a7b06493248\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useOverrides.js\":\"ad025ef1d26fdf2a\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useShortcutSurfaceActivations.js\":\"79155fa5e61ab375\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/discoverToggleTree.js\":\"07e6c1376a308f68\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/facet.js\":\"2b1aeca74464637b\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/resolveAppRuntime.js\":\"f630802bef60ff6f\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/runtimeEvents.js\":\"58b34951ff1a21de\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/togglable.js\":\"5f933ce22d11b457\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/variantFacet.js\":\"8ec0c8b1b6307ae1\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/verbFacet.js\":\"19f54d1ad437b7a4\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/block.js\":\"54dfd2e55d6a77c8\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/focusedChild.js\":\"0d585e8aa7fa64ef\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/propertySchemas.js\":\"0cf77125a7685184\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/typeRegistry.js\":\"51f63577ad6cb7db\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAncestorCrumbs.js\":\"a19fb4167402f3d0\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAutocompleteListbox.js\":\"1bce6c30d15330c2\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedSearch.js\":\"9159a3b030d8cf06\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedValue.js\":\"22cd13aacdd2b8fd\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsFocalRender.js\":\"21e252102595599a\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsReadOnly.js\":\"26196016a239fd9d\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMaterializeBacklog.js\":\"234707abe9f299b3\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMinuteClock.js\":\"98fe6e8acf73c65b\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePanelLayoutProjection.js\":\"402e28e7c7c9336d\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePendingInvitations.js\":\"ff265273398722b0\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRendererRegistry.js\":\"b65dd97b0897aea7\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRetainedFieldRows.js\":\"0d238c567c1692b2\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useWorkspaces.js\":\"ec92d1017f8f3385\",\"/knowledge-medium/pr-preview/pr-1855/src/lib/utils.js\":\"552bebf8570a23d8\",\"/knowledge-medium/pr-preview/pr-1855/src/main.js\":\"69ca1c348fe65e3f\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/MarkdownImage.js\":\"7a087b96a4f8c15a\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/blockSeparators.js\":\"0309b10d24af8379\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/context.js\":\"1060c0d1a570f835\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/defaultMarkdownExtension.js\":\"afb4907c4efab4c4\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/extensions.js\":\"966930da51f975fe\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/renderMarkdownHtml.js\":\"cc8057148ec228f6\",\"/knowledge-medium/pr-preview/pr-1855/src/minimal-editor.js\":\"96825e69a562ba7e\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/armedCut.js\":\"4211911e8fd25eb8\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/captureMediaVerb.js\":\"4bbee02c4136f67a\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/clipboard.js\":\"c7ac180d675c5c07\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/decision.js\":\"51a33ea9b5ee2207\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/operations.js\":\"6072490a439ccb21\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/AccountHeaderItem.js\":\"3d00a719676742b7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/index.js\":\"d0d7f4676238bac8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0792dd507d95742a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askAgent.js\":\"19c266c216b4fce3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askedStore.js\":\"d8ad9346f9844c92\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"32837a52fa0bbc06\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/chipState.js\":\"a5aef9f0d58b8824\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d18641438ccccd50\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/index.js\":\"86e0b553253d76e4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4f9d147a8d1db6dc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/schema.js\":\"8b0063297d6d8a99\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/AgentTokensDialog.js\":\"00c609a04507a2fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/BridgePairingDialog.js\":\"887aeab0ccebbe09\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/addMedia.js\":\"31acaca2fcbd9954\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b083a5bad88f7f4f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/block.js\":\"460f96c8bf459f23\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/context.js\":\"7a9ade3a48669916\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7852bd9b57e5cb37\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/index.js\":\"cf5fd038140541ea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/outline.js\":\"7026abc410b7a19c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/properties.js\":\"d6791c5e4cdc9801\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/refs.js\":\"d3a345170e4e5184\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"36061cc8bcb76cc1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/search.js\":\"63644934810b926a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/shared.js\":\"525aa7bcd7d8ec19\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2deafde5dc88bce0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/text.js\":\"15349fd0ee283694\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentWrites.js\":\"2037c7b06f412e55\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/authoringCatalog.js\":\"3fbc051d52e0e583\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/blockRefTargets.js\":\"a9d98368de45971c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridge.js\":\"cb75789a6aae8693\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridgeLoop.js\":\"2bc9a6a40c66a41f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/changeHistory.js\":\"34a125d186afdee3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commands.js\":\"f7f7e4ecabcd67a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commentsCommands.js\":\"4ad374379e5192af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataExtension.js\":\"c54f3e0401307664\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataModelGuide.js\":\"bd7436d8b5a64096\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/describeRuntime.js\":\"447ce48374a23eb7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/extensionLint.js\":\"ca53cad915c12dd9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/grainAudit.js\":\"f071e791582674c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/healthCommand.js\":\"ece4b49d3843e02c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/index.js\":\"ca76ff9ecd1f247b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/presetIdentity.js\":\"b0273e5059ee45e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4a16eda01dbc553a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/readMedia.js\":\"48f7a8305786ced8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/schema.js\":\"7dead91be8462a80\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/serialization.js\":\"1210e30431a39e4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/targets.js\":\"40627437708b2890\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/tokens.js\":\"f2c08b1ad41a0119\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/watchEvents.js\":\"e4bc53a09547fc1c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/workspaceGuard.js\":\"38eb4e6a628899bc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/writeCommands.js\":\"e509511c1786b288\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/AliasCollisionToast.js\":\"d963aed0dff7d622\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/DuplicateNameBanner.js\":\"e8b8a65a6594f9e4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/collisionMerge.js\":\"fcd7f8bc2478cfb6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/dataExtension.js\":\"995f379cb9a479de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/index.js\":\"ac4bee08796a3f3b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/mergeCollisionAction.js\":\"7142f75c5cd42cef\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/pageStyling.js\":\"ca9e1549481c3424\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/rejectionToast.js\":\"aeeaa3d5a2477c4c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/syncProcessor.js\":\"9beaff5404f3fe62\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/actions.js\":\"0051fcb8c2eb1153\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/addComment.js\":\"17cbeb53d39eebae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchor.js\":\"d026225adf3eea35\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchorState.js\":\"3476d8603ef95335\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/commentLinks.js\":\"9461c2cffb4a98c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/confirmThreadDeletion.js\":\"bc7deca7cda5372b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/container.js\":\"7d3930fabf48db95\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/dataExtension.js\":\"1bc8fc5fb38575e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/deleteComment.js\":\"cdd2fbcac295c8e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/highlights.js\":\"ef5f31af5d6aec07\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/index.js\":\"f2993a18a1f32d4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/linkedCommentsPill.js\":\"81ec9cfc69e5a019\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/margin.js\":\"282473f82f44502b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/marginSchema.js\":\"5c9d790b8c26653e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/newComment.js\":\"43ecf170999d16df\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ownThreadPicker.js\":\"a4730bfeefa50f13\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/placement.js\":\"eb7d0f0b47ec09fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/queries.js\":\"ee693731a5929716\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotePosition.js\":\"22c0d228fe8a4a6d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedIn.js\":\"96eebb4171886716\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedRange.js\":\"027d577636c5f2fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/rangeRefs.js\":\"539d92e0670c1986\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readHighlights.js\":\"10bdab8584ae9cdc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelection.js\":\"e3e240c03ddf6824\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelectionUi.js\":\"99beb7b0deedb81f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/reanchor.js\":\"2b50375776556fa9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/schema.js\":\"18173caa045041c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scope.js\":\"0bd6e119a66e13a0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scopeThreads.js\":\"103a879cd915b069\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/splitRetarget.js\":\"64b7a71a539e8a78\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestionCard.js\":\"499e2b5def2615cc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestions.js\":\"f991866a54629508\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaries.js\":\"0bc18288681bfb78\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaryBatch.js\":\"e2fac49c66c61be1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/surface.js\":\"9a2d72e307b3c604\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threadNavigation.js\":\"e8f2d3768fd19d22\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threads.js\":\"ce7d3cd25247a6e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ui.js\":\"2ff95b247f93e35a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/uiStore.js\":\"2310dc04af7dbe9e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/appIntents.js\":\"d426bba4950e621f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/index.js\":\"98b6ff733de2a4f0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/index.js\":\"aa91909f6aee497a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/status.js\":\"344af9efd7ab2a27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0dc711a58fad6cbb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaBlockRenderer.js\":\"8e01a891b6346529\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaDownLaneReplicator.js\":\"705ccf69f41e1969\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaUploadReconciler.js\":\"60f98b546c76828c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetDownLane.js\":\"2671e4c70bafeeca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetResolver.js\":\"aa7c4172100e8c1c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetUpload.js\":\"bf2682bdd57ee6c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/attachmentCleanerIO.js\":\"878fc2447fc93b7f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/supabaseAuditIO.js\":\"51c27dcd1915a611\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/blobStore.js\":\"17b1013249730470\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/byteStore.js\":\"22c15fa4af616575\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanerIO.js\":\"b6e6d5c6da7afa74\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanupAttachments.js\":\"661ba87eb7237e11\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/dataExtension.js\":\"5508f6f85e507695\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/downLane.js\":\"e30cd9e32f956725\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/index.js\":\"d29e383b2bb51d2a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/insertImageContribution.js\":\"042703a97a7ceb4f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneArming.js\":\"20003b3860612ea4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneLock.js\":\"3e0e8dcf303d9f88\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaBlock.js\":\"9d2b5e4903aedd77\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaCapture.js\":\"bc9a85858820ef8b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaLanes.js\":\"74cac3cf8e56a65c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewers.js\":\"07e36884c008b589\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewersFacet.js\":\"fec37303893a2c93\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/pasteCapture.js\":\"ee99e54cbe91bfec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/resolver.js\":\"d0497cd3f2d70c57\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/retryUploadsAction.js\":\"806aa8fc759c0d37\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/storagePaths.js\":\"0c258f121eab33d8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadDrain.js\":\"d7fb7cd145bf4f93\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadLaneStatus.js\":\"9da93d3292d44bd9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadReconcile.js\":\"58202212091506b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadRecovery.js\":\"b9d3950a76be5da4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadStore.js\":\"b82d3ddc903a5763\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/useAssetObjectUrl.js\":\"d15e9621e0086d2c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a2d18bd2706790fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksViewSection.js\":\"08c8ea16574cadfd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/facet.js\":\"bcec219d716499f0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/index.js\":\"516dd70f3fd5efac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/prop.js\":\"756ef358f7630e6d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinkFilters.js\":\"e60c18e57405e4dd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"70aabb7b2f959b16\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BlockEntry.js\":\"594978f2e6b483bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/LinkedReferences.js\":\"784d4d8b535480ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"eadc4414cb9059be\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dailyNoteDefaults.js\":\"8edb3a3bee87fc1b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dataExtension.js\":\"f5f0920c0d6fc75c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/edgeExclusions.js\":\"a3a99595b5f09be3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/filterProperty.js\":\"812d28efef62caa3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/index.js\":\"ed8126856be6c23c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"8de73da2c73a0adc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/applies.js\":\"c29c86c7605e2190\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/countQuery.js\":\"ebb17174ccc31be2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/expansionStore.js\":\"947c2e8a47cd9589\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/index.js\":\"6df942530215decb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d8cb2f576f9aa2a3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/presentationInvalidation.js\":\"47a7914b61df4408\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyEditorOverride.js\":\"f513000fc743d7a1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyFilter.js\":\"e0be16191ba01209\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/query.js\":\"8328e3ad32474573\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/resolveFilter.js\":\"e48ecf7e91843315\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sourceBatch.js\":\"85523ff168e9f266\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sources.js\":\"689e3260f2635660\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useBacklinks.js\":\"ccb11b8d544aa0c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1ffaf2731a353adb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayCelebration.js\":\"ac6c762dc3f4928a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayOverlay.js\":\"81d459bb7c6f450d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/gate.js\":\"132220c3f23635e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/index.js\":\"dc9c709f6ed30092\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/wolfTheme.js\":\"1567cb232abf56ca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/BlockDragLayer.js\":\"24b48ec6d492376d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dragController.js\":\"e0d3cc02b9966b7d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dropTarget.js\":\"2cdf9e2fbffb3457\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/index.js\":\"0be5df51e0586a19\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/projection.js\":\"834334f122da8a28\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/BlockMetaCard.js\":\"cf61d14410515e9d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/index.js\":\"2877f2835826b214\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/AddTagDialog.js\":\"f5e91af0b835c126\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e8017d4a62b4ec87\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/TagNameIssueHint.js\":\"1ab69447ed5746ea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/addTagAction.js\":\"264b4fca7e61aec1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/appendTag.js\":\"7b0445e7c3429efd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/config.js\":\"0d8d620a843222de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/dataExtension.js\":\"4d6604dcdd0f92c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/index.js\":\"594a336d8af22c3f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/propertyEditorOverride.js\":\"72a6c5cb46f3b109\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbList.js\":\"85f7fe711710dcb4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a1ff4ec5fa78fc33\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4cec7330c677dc2e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0f486eba88eaad43\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"70efa51c37a9fb67\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/index.js\":\"916f6e29014f6a03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"109189e4b92f60c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/CharacterCountItem.js\":\"08a3a5b36459d146\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f04379ba92fb77d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/actions.js\":\"8a9b45c32fbe0227\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/blockType.js\":\"666899f01e2d05cb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/charCount.js\":\"87fc73fa3a6e258e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/dataExtension.js\":\"3b4694b047e35d82\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/index.js\":\"e0d8000e954d023f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/profiles.js\":\"c117d0d0553b45f7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/properties.js\":\"1006b4bb5b97a4c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/textCounts.js\":\"60df695f8a49c21b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/colemak-keybindings/index.js\":\"43a0a65280cf2572\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/CommandPalette.js\":\"421a8c1e57f0330e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/HeaderItem.js\":\"7ed2c0805c66c70e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/context.js\":\"b71cac8d2666bce5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/index.js\":\"6ccbc759404e8315\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/selection.js\":\"f02b3f940f0dd237\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/toggleStore.js\":\"97c77504ef647c2e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/useCommandPaletteActions.js\":\"a2db99d6981855de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/ContributorBadges.js\":\"f7f476a1a5fc7255\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/author.js\":\"b25b978fc67de724\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/codeMirrorExtensions.js\":\"76031085b2aa3049\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/dataExtension.js\":\"8aea7f165ec5429f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/index.js\":\"4e529b4595f653ef\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/mentionAutocomplete.js\":\"a386be79dfee1713\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/processor.js\":\"8d4b669b0f0f8be2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/profiles.js\":\"b62880b871273169\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/queries.js\":\"2992ad785366089f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/schema.js\":\"a60dd543ec859be4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9c17be43443fc75f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8aed6bdd1930b386\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/index.js\":\"c920edc88b51fd5e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2f154e3f3f793668\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"fe73c51794b37400\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/CalendarGrid.js\":\"c566a8a5dd16a408\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DailyNotePicker.js\":\"07b7d73608efe97f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"72f3aa3493ac219b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateNavDecorator.js\":\"9a47ad0f89e257e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateScrubOverlay.js\":\"2cec55e46799fe41\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/HeaderItem.js\":\"c9130fd336582204\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/ReschedulePicker.js\":\"80c0420030777728\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bae8bb5a5a5e129f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/actions.js\":\"076648fa038630ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/blockDateAdapter.js\":\"80aac291b4686329\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/calendar.js\":\"30531098027612e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dailyNotes.js\":\"0d900ef96569de6f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dataExtension.js\":\"d9e0ed6ac37de3de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubActions.js\":\"a2acad933e989625\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGesture.js\":\"75f24337d613dbc3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fce7a6e5243cc251\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a5bbdd2f8aad8c81\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/deletionGuard.js\":\"cd672006fa0c5552\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dueQuery.js\":\"eef009588ca7ada8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/index.js\":\"6bc8477e1306869a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/landing.js\":\"37c976e995a7ef8b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/localSchema.js\":\"aafebea678a4ed19\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/referenceDateAdapter.js\":\"1d1f171917b01796\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/rescheduleAction.js\":\"24cd1d151907afae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/schema.js\":\"ecdea185add62a2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadBlockDates.js\":\"20db954176cb8861\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadDatesAction.js\":\"9bf4e3c0cb0ea654\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/today.js\":\"9a66696555befbcd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cde14fe5fa8e111a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9a6ce99d577c23de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/audit.js\":\"458e031111b177fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditAction.js\":\"64a78ec39a5e0f8f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditRanges.js\":\"e1b92a9c990b70d2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/diagnosticsSource.js\":\"b0b34f8f4a0292ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/divergenceScan.js\":\"a80543d1fefbd8f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/index.js\":\"fe19474c48b2878d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4e02494caaf5f5f5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/referencesMirror.js\":\"3e1357e38c256b40\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/rowJson.js\":\"4e17ae6195954ed1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/schedule.js\":\"8bab5d92db0e5f51\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/store.js\":\"44e01ab2cfcfc000\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/action.js\":\"ad0f21e0b73d6981\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/index.js\":\"d7875838d84dc3f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/plugin.js\":\"c21af24998a3a035\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9514b57304de2156\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/actions.js\":\"73db5049da965cc3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/changeMarker.js\":\"ad04c85f1c5ede52\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/diagnostics.js\":\"6da73824617263a1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/fileSystemAccess.js\":\"c60670033838540e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/filenames.js\":\"4e7061e9314e6b1c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/index.js\":\"599ca53ab2873936\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/mirror.js\":\"3192e250bf09e25a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runLock.js\":\"764888e2ea917b6f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runtimeHealth.js\":\"15350bab0e6f92d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/schedule.js\":\"45be2ebf8b521ce2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/store.js\":\"4392b4af14e56d90\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/index.js\":\"5002455d6f316235\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/themes.js\":\"b611505f57b58bc1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/facet.js\":\"540368416c9bc6f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/useDiagnostics.js\":\"eb234344e5a97a64\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/dismissals.js\":\"2f546ab99cc34e27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/index.js\":\"3f67ef71b6b36d64\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/status.js\":\"150ff6db9b060d96\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/store.js\":\"b171f19b17c86945\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b19c64e92b6207fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsSettings.js\":\"edbffd660f9dba3f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/actions.js\":\"6dbb3f0374173895\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/config.js\":\"08560d593e416cef\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/dataExtension.js\":\"69f3af050ff79c8f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/effect.js\":\"40ce006324ffad27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/index.js\":\"48deb5a5db4f60bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/propertyEditorOverride.js\":\"969815d7d37f482b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/useToggleTree.js\":\"6f79cf1e93a01f4f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/ExtractTypeDialog.js\":\"affcdf6cda352375\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"db75c44c9144da25\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/PropertyShapePicker.js\":\"09dd40d781fdcbae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/action.js\":\"b76891b2ffdc895f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/index.js\":\"059deb0fb81e24e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/FindReplaceDialog.js\":\"1a27642b50dac478\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/HeaderItem.js\":\"00a026d4845b3f99\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/dataExtension.js\":\"fbe51dd976af5ad1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/index.js\":\"ad7a30b12b2d4982\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/search.js\":\"f5c5a31fe0fe0ec9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/toggleStore.js\":\"13a0283fd238dd55\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/LocationPropertyEditor.js\":\"27aa9d2efaefdb0d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/MapView.js\":\"ffcca366c4b72dc1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/blockTypes.js\":\"fdf0d19c41446a12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/codeMirrorExtensions.js\":\"ec997e7b9dee73c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/createOrFindPlace.js\":\"b8ca633bdb766234\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/currentLocation.js\":\"3399240bf876b44c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/dataExtension.js\":\"8b941dd1fa678172\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/geoContentDecorator.js\":\"2743a4ef6c4585d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/googlePlacesClient.js\":\"c9af148682501091\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/index.js\":\"1f0e7795adcd8be3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/locationsPage.js\":\"d33a6013f9a2f624\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/mapViewport.js\":\"9af66c4cff7d1793\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/pickCurrentLocation.js\":\"b8e9a603d3e28239\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeAutocomplete.js\":\"c85324f5bc079fe8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeNameCollision.js\":\"af1c01ff864d7ca4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/properties.js\":\"d947327bf69e8880\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/propertyEditorOverrides.js\":\"a80b625ca85d9f27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/query.js\":\"a2c5b979cddd3945\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/usePlaceSearch.js\":\"21e335ce9ec5b479\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"37780ebc9831d677\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"418761ece25c73e5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3a68f65ba55ab1df\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/config.js\":\"3c64e7c93191e590\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/dataExtension.js\":\"81cf39f54453727a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/facet.js\":\"1316b12c7080d80d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/grouping.js\":\"7d943a3403375365\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/index.js\":\"62875d69c0b9041b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"196f63ce155524bb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/query.js\":\"6a1dffee0e490512\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/resolveConfig.js\":\"d71eddf1c671cd2a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a55a093650c6e72b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"95fb36cbcfbfd377\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlDocumentContent.js\":\"4d87ced1cf7c0d3c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlFrame.js\":\"b398bae1d9d5105e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/actions.js\":\"268e70b7f84fe356\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/blockType.js\":\"905517fd446a6894\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/confirmRunScripts.js\":\"a067eeab62cae571\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/dataExtension.js\":\"e10c36ac1e0cc178\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameAnnotations.js\":\"7a1d0104c0162abc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameDocument.js\":\"b219879704bea4cc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameTheme.js\":\"8d16c98d45722ddb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/index.js\":\"9ef5412604c6dc27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/scriptConsent.js\":\"40eb198d65e5a1c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/sourceMap.js\":\"a3f2a715af9a4b40\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/useDocumentScripts.js\":\"0fec6f9ef73b8858\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/index.js\":\"6959eea06b2fdd94\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/record.js\":\"8dc1ad8d49c63bb7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/recordStore.js\":\"88a859209ae76c8e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/responsiveness.js\":\"cdf614a5b7ffc84f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/schedule.js\":\"29d4967327653796\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/sessionContext.js\":\"4015925effc5a751\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"de63887ef9a9e430\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"367c27389608cde7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/actions.js\":\"4b7758be9f7a75fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/config.js\":\"df1b65ac7801e62b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/dataExtension.js\":\"20daec520cd2d037\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/effect.js\":\"0d6647dcd7f9a9d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/index.js\":\"e73ef1a8e9a85f37\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/keyCapture.js\":\"f5191282b58ab583\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/overrideStore.js\":\"f790b4fcd11f662d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c71fac392e76c2d0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/HeaderItem.js\":\"4788cb2c0d23d3ad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/LeftSidebar.js\":\"8f9d9bed52d4f6e4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/actions.js\":\"3a179cd9f6d1de89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/facet.js\":\"f30f035b191f6387\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/index.js\":\"150026de6b3b64d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/shortcuts.js\":\"090011c81006184b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/toggleStore.js\":\"1c1b3f5199617972\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/MergePicker.js\":\"bbbdc85ff00d60e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/index.js\":\"11e52fd70cefe6f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/mergeAction.js\":\"c9eac263691a36fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/strategy.js\":\"b20d0836add244a3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/Button.js\":\"6c1b7265a510f72c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0b5a7dfa5af4f8ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8066a7710d99cf23\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/facet.js\":\"559157d8827ff6bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/index.js\":\"90788641236e1060\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"20e0ca85343c5bfb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7836c8ab342ae803\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"87b4c6c54aa1323f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8d05056fc436e3df\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/index.js\":\"a76d7c3c4155a61b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6e6a1633e544c4e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/blockSubtreeMembership.js\":\"37c68a8d479838d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/contextMenuItem.js\":\"618ded7de86ba7a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/index.js\":\"c249a8c9625ca3f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveAction.js\":\"b238c9e2c99b6aea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveBlocks.js\":\"0eca5500a367cb3f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/selectionAfterMove.js\":\"dc5358836b4fe32f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/TutorialBanner.js\":\"ffc2dbd006930e35\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/action.js\":\"e5dae108358a2d68\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/bannerDismissal.js\":\"1e75c0d246832645\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/documents/cheatSheet.js\":\"394320dd144e7230\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/index.js\":\"e5b7c4ad25e4ce9f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/keys.js\":\"74d3cd2856640f33\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/landing.js\":\"0f96d25837af59d8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/outline.js\":\"d201b84924f75881\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/seed.js\":\"c74778edbde66c99\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1752caf6b63d2c79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/analyze.js\":\"8c5c4316ed243b53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/diagnosticsSource.js\":\"1c333cc91c5ac34e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/index.js\":\"c2bf84bc4e84aa7b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/load.js\":\"4a38533c784fad77\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/monitorRun.js\":\"4d8bd48acdab73f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/schedule.js\":\"2106d795de7aca34\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/series.js\":\"ac2bdec35f257e9e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/store.js\":\"08c8f4e2828e1729\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/trendAction.js\":\"81656a6abcf18cb0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/verdict.js\":\"27adef8444dad6f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/clickToEditAction.js\":\"9ad9376dce4793e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/index.js\":\"709cee8940655013\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/interactions.js\":\"a629f8cd45daf3e0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fea3eb4fb159ac2c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGate.js\":\"5cb1bca828318144\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGateDialog.js\":\"2f943e6bf56f12e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/action.js\":\"58b8f69c614676bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/index.js\":\"7b6f3521d4aab9fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/localRunMessage.js\":\"468e7da00f90f0d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/plugin.js\":\"6c9b6b3ceaf2fc43\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/progressReport.js\":\"55369f9b6b0acd2b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/sweepProgress.js\":\"2b1774855c1a39ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/FieldRowRenderer.js\":\"573eafd44cd2b199\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/ValueRowRenderer.js\":\"6bb03237a19fbe4c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/actions.js\":\"af2fd92dc64b70d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/autocomplete.js\":\"7bfa8d4a6e1d452a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/fieldRow.js\":\"b0146087c88d052e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/index.js\":\"a7e45b1f10288c2e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/referenceWarning.js\":\"6c2ecef7d44c4ebe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueAutocomplete.js\":\"2a558a46289e1132\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueSchema.js\":\"906c5f8762fa068c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/HeaderItem.js\":\"bc7256e4f8c50e84\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/QuickFind.js\":\"4bf97f641c4e6842\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/index.js\":\"6272adb675635d5f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/recents.js\":\"b492c48e90d41a30\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/resultItems.js\":\"c9600559829eff9a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/selection.js\":\"b4b52240558b61c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/toggleStore.js\":\"e6ac83a2854fdd2b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/HeaderItem.js\":\"e3cb3e4abd4d9039\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5ddee086aa622bcf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/grouping.js\":\"32d3b8593dc7bdf6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/index.js\":\"29336cfc799daadb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/target.js\":\"ea884851f12c6847\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/codeMirrorExtensions.js\":\"02a3228c48854f9b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/contentPrefill.js\":\"842519772fb95518\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/dataExtension.js\":\"b1d46fd2cd10e8ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/index.js\":\"16e29b712db5f321\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f313b1a8452a9e20\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/invalidation.js\":\"94762f9b1a73167b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/localSchema.js\":\"c5825cce79d00cc5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/index.js\":\"d4c128950e9e10f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"48dd5f2b83a2733e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/index.js\":\"8d91171500443ec9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/referenceNode.js\":\"8bf8572de8535660\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/remark-reference-occurrences.js\":\"efed46579c5ec5f7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"747f52310442e5eb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/index.js\":\"2a41cad7afad6728\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4c4068ce77dabe85\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0f1ffdda3155eeea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/mergeRetargetProcessor.js\":\"b94b834788aba711\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/parseFence.js\":\"0b92a746c6c2dc3a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceParser.js\":\"c05c6395d59f479b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceProjection.js\":\"1a81e02e1ff9107b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referencesProcessor.js\":\"574fe3935e4bb190\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/renameProcessor.js\":\"1acc84ea15ad46b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/spanReplacement.js\":\"d1bf735c53464f1d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/htmlToOutline.js\":\"05cc7df55fef11d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/index.js\":\"fb4a85950d5592f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e985504b4d8c72fa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/pasteDecision.js\":\"a68bc7fb72aa6544\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/action.js\":\"71f1bd64a38e04cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/blockIds.js\":\"9c1e35c4a77ee5c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/content.js\":\"d75d105b736fdd40\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/effect.js\":\"416e859e7fded822\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/ids.js\":\"6e1b1e51134f0075\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/import.js\":\"c51d596d5ee3a99e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/index.js\":\"6952e1ff84c9b76a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plan.js\":\"61dda7a4835ed5c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plugin.js\":\"2791598e0f51c429\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/promotion.js\":\"1b4af5e9304e0bdb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/properties.js\":\"cf150e5b7eb35f59\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/references.js\":\"7e705e5d828dc2d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/report.js\":\"bb839f48e38b889e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/roamMemo.js\":\"bb12e75772f48720\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/runtime.js\":\"dee1b924fb7bc8e7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/schemaReconciliation.js\":\"976f0dcd0c291ebe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/srsMarkers.js\":\"977813ee71e85496\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/todo.js\":\"7242d2c45189a813\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/typeCandidates.js\":\"a90bc76790b06bc6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/types.js\":\"f86c0f400e175ff7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/index.js\":\"a69dc98f326b0781\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/store.js\":\"5bab6d9abaf1c45a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/HeaderItem.js\":\"4560129859bf3c18\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b1dae3e393fb25d1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/index.js\":\"1d2d578f60a58677\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/model.js\":\"cd47c3aea39c36f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/toggleStore.js\":\"04d8e753b38cc8b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/useKeyInspector.js\":\"b88fc68bed858e13\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"65d6964918755461\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/ShellDecorator.js\":\"0d89d43025a3f0be\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/actions.js\":\"48c4747b5cf7c1c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4802c5ff6a5cd986\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/index.js\":\"0c02e5613dfe748b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/shell.js\":\"0722efbdb65a4781\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/surface.js\":\"507eaf1c9f5031c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/walker.js\":\"ee79849288ab7b9f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/RescheduleToast.js\":\"81213e5e582baef3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/dataExtension.js\":\"16c78ba6935d0a54\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/index.js\":\"bf6e9877b58618b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/indicator.js\":\"dc5b9a3a59ec7fa9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/moveSrsState.js\":\"e3f76c3d240e2857\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6b3675a7cf1fd90e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/scheduler.js\":\"70ecdb6a9bd6a814\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/schema.js\":\"531f981811ccb6e3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"20ea2f55d0d1b0fc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsClipboard.js\":\"bd836c133cf8c0bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a0dcc8971b8dd830\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1f1001a25da3fcf8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DeckPicker.js\":\"04f6e792b33e23a0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewControls.js\":\"26e9218b8f502a81\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ac9c116b4a28b354\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewSession.js\":\"5dc1ab5ce825c25c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/actions.js\":\"5a3375f7d353b730\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/archive.js\":\"a560592817c857ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dataExtension.js\":\"af44f02505a01ffc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/deck.js\":\"1481cd95bf8bca95\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dueQuery.js\":\"b5a2eb2a62c549f8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/gradeDecision.js\":\"40352353d303a313\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/index.js\":\"9ce1044c271989f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/keyHints.js\":\"3da1a4dddbc07daf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewCardLayout.js\":\"eaa5408e89ed507a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewProgress.js\":\"d7d613526442a571\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/schema.js\":\"6d5a5914e984d105\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/useDueCards.js\":\"ff8787e148a618d7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/index.js\":\"6a47118a64c06b5a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/record.js\":\"3393c6f046e21d4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/index.js\":\"51445c69db5d03fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/persistenceStatus.js\":\"abdec0e4301861b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/requestAction.js\":\"92d2ee6ed422c487\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/TypeChipsDecorator.js\":\"0d84000625058b88\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/codeMirrorExtensions.js\":\"e3861a523ebf6771\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/index.js\":\"35585054c3dcbe2d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/typeAutocomplete.js\":\"4bb3794f7891359f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"dbccf21677849159\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/actions.js\":\"c3ae531e04204936\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/anchor.js\":\"6e5b3b873e51ce72\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/events.js\":\"5eb8c4d5c7754f36\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/gestureActions.js\":\"b2d34b1c740d175a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/index.js\":\"bfb9b1114a32bec6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cb8f914269299342\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/collect.js\":\"51d8c0f423f58e8e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/index.js\":\"05b4d92e85cb9668\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/record.js\":\"4abfa4bac07092e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/RejectionDialog.js\":\"2f82401f6fb9b559\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1d346c1239c4a76b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/index.js\":\"e55a4b2bb42a25aa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/model.js\":\"fac3c50f89a66900\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/queueCounts.js\":\"46b8d6e239399945\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rejectedHelpers.js\":\"740bee73e00b3232\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rematerializeAction.js\":\"1d4fbb19fb775af8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/useHysteresis.js\":\"915a232f2f4b99c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/ColumnHeaders.js\":\"e1d660e3cf8720d0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/QueryUi.js\":\"74981a91e54918fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/TableLayout.js\":\"68283c7d9371f6b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/actions.js\":\"bc52059c34129595\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/cellEdits.js\":\"64904df7107ce30e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/columns.js\":\"5d8e185ce4e50da4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/controller.js\":\"fafdf505b7ffdfb6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/convert.js\":\"4e9c6e4fe9c69778\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/dataExtension.js\":\"d318cc8c7b22e869\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/index.js\":\"bfd0aea8ee389494\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/keys.js\":\"03ee95bdef113212\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/model.js\":\"27df35ae27d98efe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/navigation.js\":\"ebcf2bfcb09c9e79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/backfill.js\":\"11c4086b0adb0552\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/completion.js\":\"0a48f783be7fa419\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/format.js\":\"325274bde569d4f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/parse.js\":\"09eadf27894e4771\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/queryValue.js\":\"b0be74fed5de6cdc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/source.js\":\"0d53b1d05343f9e9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/registry.js\":\"43ad3fc2c527ca64\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowGutter.js\":\"238a34d53c4e3175\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowVerbs.js\":\"63d9fc2606a7e4ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/schema.js\":\"ed175368428ba265\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/sort.js\":\"0e7c9eb34e9f549c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/effect.js\":\"78ed84fdd16a8646\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/index.js\":\"dbcb9d22877b9ccd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/theme.js\":\"b0e2709820e9c30b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/actions.js\":\"ae9b6982eac048f7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/dataExtension.js\":\"55e727a2cc697a48\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/index.js\":\"77b9a323595789bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/schema.js\":\"9392029e75ca37b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/TouchSelectionLayer.js\":\"db242478b742779e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/actions.js\":\"65ebdcb9ca6b7a79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/defaultItems.js\":\"91de94f40adcf11e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/facet.js\":\"30064c1afad08ceb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/holdRecognizer.js\":\"8ccd9e7597d7b7db\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/index.js\":\"ad4fbfbbd00a1f95\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/UpdateIndicator.js\":\"0a515ae45d23701a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/index.js\":\"2572f41808059704\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/loadTimes.js\":\"776f89e459c8d66f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoNotesRenderer.js\":\"5a4af4d21b7c0389\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoPlayerRenderer.js\":\"19669dc7f9ddba4e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoTimeStamp.js\":\"f02c5ff128004ff2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/actions.js\":\"d8907e5083b69edc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/index.js\":\"878b7e15d89a8be6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/markdown.js\":\"64cd057ebaec939f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/notes.js\":\"c59de5f1bd4d0c56\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/registry.js\":\"3150959cd3a42b41\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/remark-timestamps.js\":\"f1f659bc941b67c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/view.js\":\"6269827be1428aaf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/LinkHints.js\":\"08a7a201669f15c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/index.js\":\"4d6982879b5404b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/model.js\":\"b04720f9aa16a7f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/settings.js\":\"294b8450238671f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/actions.js\":\"886a8746d7b2446f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/index.js\":\"ac50223525af05ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/interactions.js\":\"c494f6330642fb02\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/workspace-header/index.js\":\"49ed9a335404fb21\",\"/knowledge-medium/pr-preview/pr-1855/src/registerServiceWorker.js\":\"628e889b67866f4c\",\"/knowledge-medium/pr-preview/pr-1855/src/requestPersistentStorage.js\":\"7b133cf827e73be9\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authRequestDeadline.js\":\"e5052c6a1c9787fd\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authStorage.js\":\"5738556e26359975\",\"/knowledge-medium/pr-preview/pr-1855/src/services/powersync.js\":\"21ebd6a4d2bf2943\",\"/knowledge-medium/pr-preview/pr-1855/src/services/supabase.js\":\"47ab69a488b12b09\",\"/knowledge-medium/pr-preview/pr-1855/src/services/uploadErrorClassifier.js\":\"e03e030e1042c52a\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/ActiveContexts.js\":\"4a51357381da62ff\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/HotkeyReconciler.js\":\"d102b77d74181dea\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/WipeLocalDataDialog.js\":\"60d5f6a156bdf43c\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionDispatch.js\":\"6b639ba4cfb25e49\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionRefItems.js\":\"b24433e60db48efc\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/applyKeybindingOverrides.js\":\"e4a2d56a00b1bb12\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockActions.js\":\"cb9ba4789f0cd76a\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockMergeGesture.js\":\"91c0effab0916036\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/canonicalizeChord.js\":\"f401c26e456efb58\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultContexts.js\":\"e7ae5102739dff4d\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultShortcuts.js\":\"7c3283f76cedcc90\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/effectiveActions.js\":\"fdb12597f38affd0\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureAction.js\":\"6fc7df20c7776af5\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureBinding.js\":\"31e489ae093120a2\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/holdRegistry.js\":\"5ab647cfd8ba8a3c\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingConflicts.js\":\"9e4486dea05bbd14\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingOverrides.js\":\"31eb2300c0302912\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/pointerAction.js\":\"006ea363adb6116c\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/resolve.js\":\"12e11de2a13d9843\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/runAction.js\":\"bfb696d49f71decf\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/sequenceMatcher.js\":\"dfb884bcd1122306\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/types.js\":\"6fff9eecd6310b27\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionContext.js\":\"dc00a863dd36acc2\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionDiscovery.js\":\"04604f87adc2c545\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/utils.js\":\"72d263d6749b48be\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/bootStore.js\":\"68fc766831c86545\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/previewDatabases.js\":\"3d1ed48ae83f8253\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/byteTransform.js\":\"26a6057fc9fa2d65\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/attachmentCleaner.js\":\"7b335d1697735cd6\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/attachmentParts.js\":\"baa8097445a540ca\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleParts.js\":\"6fa0f9fcfe2aa4b2\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleRecord.js\":\"25bf2e2dd6a75bbb\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/manifest.js\":\"c345831edfb21bb6\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/takeBundle.js\":\"2092b7a5306c6f6e\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/verifyBundle.js\":\"6e84729c90e43f39\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/cleaningStage.js\":\"f8f29f91d1b309a2\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionKey.js\":\"b8153137165b3df2\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionServer.js\":\"66a4cdb2290dd2fc\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flip.js\":\"25d688d46fbd1fe7\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flipAttempts.js\":\"ca7d6469c37ebc47\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/pages.js\":\"87ecea8b81d4b47c\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/preflight.js\":\"3c0fc1df736590b8\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/reseal.js\":\"c60a557cfcb9a462\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runConversion.js\":\"1609ad76f92fb67c\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runLock.js\":\"f5c78fd13cbe0518\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealing.js\":\"42a9b063fa0ce133\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealingStage.js\":\"ab7910949d8c3a90\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/stage.js\":\"f0b2c93598d4ee8c\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/verifyReseal.js\":\"95ac1d2893c725a3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aad.js\":\"d6958c9d6d2d4d2e\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aead.js\":\"33a8f15418ba4698\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base32.js\":\"3e3bfd2216d21642\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base64url.js\":\"4ba43ebc037632d0\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/binaryEnvelope.js\":\"22aa6fed02da79a1\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/byteAead.js\":\"abcd09c71d64980b\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/canary.js\":\"45f9d88f3b2dbb9c\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentHash.js\":\"a566655157616b93\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentKey.js\":\"777483862657cea7\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/derivedIdNamespace.js\":\"240a385d81f789a6\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/envelope.js\":\"9198323524ae6d91\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/hex.js\":\"dba2fa7548525238\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/sha256Hex.js\":\"2886554d373fbefb\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/workspaceKey.js\":\"fd61843fb2b2eeba\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/conversionState.js\":\"2d574d5f97e82165\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2f8a87490766e0f4\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/pastedKey.js\":\"25110270e88fe8fe\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b0b170c9b546e091\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d7d5cc5257d5020a\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/keyStore.js\":\"9a1b2f81907395fc\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/mintWorkspaceKey.js\":\"0181cd57ab189782\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/modePin.js\":\"1d8e3512692fd059\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/openWorkspaceKeys.js\":\"d9da9fc665379529\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolveWorkspaceEntry.js\":\"c9df72d3fc47dd62\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolver.js\":\"f35577546a7b7f8e\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/workspaceAccess.js\":\"ee344c5f34daae61\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/transform.js\":\"81e70e609b990e72\",\"/knowledge-medium/pr-preview/pr-1855/src/themeBootDefaults.js\":\"8e9408efa11843d7\",\"/knowledge-medium/pr-preview/pr-1855/src/types.js\":\"b159ee27ea1b4c36\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/ClientLocalSettings.js\":\"248edfa37f43d7d6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/abortableSleep.js\":\"3197f9e68ecb198a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/array.js\":\"92ee10eb5c192be1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/backlinkAutocomplete.js\":\"7bf678f0a0ab2fbc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockCrumbs.js\":\"2c9e156126af03a4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockrefAutocomplete.js\":\"727f1a9d5d7b2d1b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/cadencedIdleJob.js\":\"f24a82c4c6d582ac\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/callbackSet.js\":\"3a1c51809c729403\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/clientId.js\":\"6bd270b0d34bf40b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirror.js\":\"0316dd4ab66f8add\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirrorCompletion.js\":\"06d920077e45bdb1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/copy.js\":\"73a6fa7f9f27ed73\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dailyPage.js\":\"f7355eb567cd506a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensics.js\":\"94def675b2aa462d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensicsHooks.js\":\"9f6b75e6a3fe562b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/deleteBlockThroughUi.js\":\"46e4d7aec01007be\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dialogs.js\":\"11aa5033c2815ccb\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dom.js\":\"dcf888a1b0303257\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/downloadBlob.js\":\"170d95bde6a6babd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/exportSqliteDb.js\":\"a51fa32eb17d1f5f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fileSystemAccess.js\":\"a6d4795cc14cd5e4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/flipSlide.js\":\"5e5d8c6646c2df8a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fnv1a.js\":\"94176ae7aeaebc06\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/formatBytes.js\":\"f0a2ad5bb7ce50ac\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fuzzyRank.js\":\"0f65ebc165f555a6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idbKeyedStore.js\":\"7ae99937a8d755ef\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idleCallbackPolyfill.js\":\"86c126190b911ca3\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardAwareScroll.js\":\"a05fb4df4aef9b9f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardViewport.js\":\"b17f6d6e76244e00\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/lastWorkspace.js\":\"6319e3335e560fba\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutColumns.js\":\"4654207c9c922fec\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionDom.js\":\"0e89c60240198b73\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionId.js\":\"63647b25d2bb3b83\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkClickGestures.js\":\"90e920bd2c099c86\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkTargetAutocomplete.js\":\"569009da5c757043\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbCorruption.js\":\"5a548f828e6d6c0a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbRecovery.js\":\"6c512b5758136700\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/markdownParser.js\":\"fd0c42def04116ed\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/memoize.js\":\"0a3db48c48d682b1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameFieldCommit.js\":\"e023edcf423468ec\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameList.js\":\"2de614f83c111c37\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/navigation.js\":\"217319439cf60a35\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/omnilinerNamespace.js\":\"7afbb9ff205bacc4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/opfsPageScan.js\":\"1c5018005b8c4e60\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelClearance.js\":\"c4820f95cb63222c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelHistory.js\":\"0db327c04601549b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLanes.js\":\"fb37ceb55cf21816\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLayoutProjection.js\":\"89d71a89a8c33c30\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelScrollAnchor.js\":\"17d28e4e1f47665a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelUrlFlags.js\":\"44c1cee8925c19e7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/platform.js\":\"1acec12299c628f9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/pluralize.js\":\"f1534a81c72799b3\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyCreation.js\":\"8e72b74976ba1c30\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyNavigation.js\":\"42afea1b1516c84e\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyValueContext.js\":\"f42610d16e1a2fa7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/react.js\":\"cbbcef03e23c7d6c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeDate.js\":\"97e6422184999c19\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeTime.js\":\"7b7103ea42624cf8\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/renderScope.js\":\"f22fd2d0cabcbaea\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/resolvedThenable.js\":\"19564b851ccd1c31\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/routing.js\":\"143e399a6d53c8eb\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/safeMode.js\":\"352fc46deddc575c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/scheduleIdle.js\":\"4dcabb9025941d10\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/screenWakeLock.js\":\"911bdccd0e5dcabb\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/selection.js\":\"663ff2d575bcefa5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/softKeyboardGrab.js\":\"d465479749426883\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/startupTimeline.js\":\"e66dc61fc1a4b027\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/state.js\":\"73bf3513dcf53327\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/string.js\":\"2f577453f3d61c90\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/surfaceZoom.js\":\"820d7bdc004cd1ce\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/time.js\":\"bb803411c0223422\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toast.js\":\"dd38aae87d409668\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toggleStore.js\":\"d51b3f7db538c908\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/untilStopped.js\":\"235b35a94a1178e5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/userActivity.js\":\"d0327b2c4bcc72c3\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewTransition.js\":\"a4ff67061cd2d371\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewport.js\":\"ffe0c2f07eabc3f9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/webLock.js\":\"5a2177e6df97c114\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceRecovery.js\":\"7375481090fc3355\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceSnapshotStore.js\":\"ad77e312c394e095\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-compiler-runtime.js\":\"4b43eec907699b2b\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-client.js\":\"f00ccc80de8542fc\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server-edge.js\":\"43ef6e883102f98e\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server.js\":\"f936a8e80f2d88d5\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static-edge.js\":\"ab956f40cafb7c19\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static.js\":\"f5e33892e3537b14\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-test-utils.js\":\"e0286c871cf46ff2\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom.js\":\"ab94d9cb7429644f\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-runtime.js\":\"023a853606036bd5\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react.js\":\"69945e8607dd056e\",\"/knowledge-medium/pr-preview/pr-1855/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
