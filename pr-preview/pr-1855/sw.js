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
		buildId: "04557182e73e-966b082c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/\":\"576c9299245a3f86\",\"/knowledge-medium/pr-preview/pr-1855/index.html\":\"576c9299245a3f86\",\"/knowledge-medium/pr-preview/pr-1855/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1855/assets/FacadeVFS-Bu1YjWDF.js\":\"8e1444f7af15783b\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSCoopSyncVFS-CSA8m7cM.js\":\"e45ae75fa125d0d2\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSWriteAheadVFS-Btf_B063.js\":\"dbba5f9bce1c5087\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-B0ISJw71.js\":\"5ebcc8a2224eef71\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-BMCXHq2c.js\":\"13e9dfd16ef80877\",\"/knowledge-medium/pr-preview/pr-1855/assets/worker-CqYrfOYn.js\":\"3960d3628264e5e6\",\"/knowledge-medium/pr-preview/pr-1855/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1855/chunks/app-DWgHJORi.js\":\"cb9ab37cae95560a\",\"/knowledge-medium/pr-preview/pr-1855/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1855/index.js\":\"973c4c250c554fc3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1855/assets/AccessHandlePoolVFS-Cin_mKV7.js\":\"70c864b059872b65\",\"/knowledge-medium/pr-preview/pr-1855/assets/IDBBatchAtomicVFS-BHUIinYu.js\":\"dfefd7d4bb5c010b\",\"/knowledge-medium/pr-preview/pr-1855/assets/MemoryVFS-Bn5_JK03.js\":\"13d8c8c64204af9b\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-C9-B-XoZ.js\":\"55d6363f64e5a535\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-CprHVz1C.js\":\"5508f5e11e7ec0ef\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1855/chunks/AccessHandlePoolVFS-QHtIisxd.js\":\"50cd6421eed7544f\",\"/knowledge-medium/pr-preview/pr-1855/chunks/FacadeVFS-CdCx7GRu.js\":\"e6c46b8b1446c9fa\",\"/knowledge-medium/pr-preview/pr-1855/chunks/IDBBatchAtomicVFS-dYKOuLhg.js\":\"0339f72cefe17f59\",\"/knowledge-medium/pr-preview/pr-1855/chunks/MemoryVFS-DKuilbrX.js\":\"b2584fb95160c353\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSCoopSyncVFS-BDO-eZTp.js\":\"f135a3f7b206fcb5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSWriteAheadVFS-MamvkWgP.js\":\"a7e72eb6f5e86ff2\",\"/knowledge-medium/pr-preview/pr-1855/chunks/Preview-Bm8LZX-n.js\":\"0588df749380f33e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/card-obAC6blX.js\":\"519d9328e685264f\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-B4kXrt_6.js\":\"6eb92d08210a9303\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1855/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-CJU1VvMQ.js\":\"4dea43806e4ca59b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-async-CVK4BPfn.js\":\"a833d89b81e39d72\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react--oqO6A_n.js\":\"c077d70e820cc6d5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-5L_9g4C4.js\":\"ae5e4c42a8e36fb6\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-C11Ska2A.js\":\"ed34aa6cdde60648\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CRKIupsF.js\":\"d69c24c7939d1de0\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CS7qyH7F.js\":\"5163eae5534169db\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DYHapz_X.js\":\"2a786a8e2877b1df\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DwYMW9WE.js\":\"a45b2c155d148699\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-_tBcERyv.js\":\"08585133bb5691f1\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server-legacy.browser.production-CSGeRpM4.js\":\"a2ccf7e19fd91a36\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.browser.production-DJI2MBkP.js\":\"8cf14c2864045ab2\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.edge.production-BejAvwRT.js\":\"312be966a42202af\",\"/knowledge-medium/pr-preview/pr-1855/chunks/server.browser-B3Mn_rts.js\":\"11bbb731d17f7cd9\",\"/knowledge-medium/pr-preview/pr-1855/chunks/textarea-B5UXz65t.js\":\"a3be370e9c4784c2\",\"/knowledge-medium/pr-preview/pr-1855/chunks/ui-Dqnl0Aqm.js\":\"ce7da3f678834f40\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-DPxMUF07.js\":\"3104a1c87d9a5202\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-async-DHDdnHGh.js\":\"65aa5a1bea4082b5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1855/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/src/App.js\":\"57092fcbe1f81942\",\"/knowledge-medium/pr-preview/pr-1855/src/appUpdate.js\":\"849cae88986bcec0\",\"/knowledge-medium/pr-preview/pr-1855/src/appVersion.js\":\"aac1ab6e52c91151\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/initialLayout.js\":\"486d1fb2005f0423\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/openWorkspaceData.js\":\"d35ae0ae4a97c29c\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/resolveWorkspace.js\":\"f8b32817d85a4ebc\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/workspaceBootstrap.js\":\"ba5366cf73a3e86c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockComponent.js\":\"8f704e614841d4fb\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockCrumbs.js\":\"9d09051b1a740e64\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockEditor.js\":\"9ad8e8d0926465a3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockLoadingPlaceholder.js\":\"a2a3582b231648de\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockProperties.js\":\"9b0a8d77cafbe8e4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockSearchPicker.js\":\"3c1ea49d10198da7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ConfirmBulkDeleteDialog.js\":\"d5963656ba86bc56\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DividerHandle.js\":\"96a7826f2a2d144e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DraftEditor.js\":\"ac0eab3589e276ae\",\"/knowledge-medium/pr-preview/pr-1855/src/components/GutterPill.js\":\"388045aa12ee03ef\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Header.js\":\"027b3d71f22cd753\",\"/knowledge-medium/pr-preview/pr-1855/src/components/LazyBlockComponent.js\":\"f00707292b8e98b7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Login.js\":\"0afade7a4ca9254b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ZoomableSurface.js\":\"5d0b4d22577e3c08\",\"/knowledge-medium/pr-preview/pr-1855/src/components/editModeKeepalive.js\":\"fa16ee20075a36c7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8115ed59107e8f45\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"78b43c7870c2fa5d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefPropertyEditor.js\":\"2aeaa0c8e9691aad\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefTargetTypePicker.js\":\"1a6dd188101704ea\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/SelectPropertyEditor.js\":\"8f1908a8b6685217\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/TypesPropertyEditor.js\":\"e01b0decc6e7bc9f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/defaults.js\":\"6c63888b8ef0a419\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/kernelValuePresets.js\":\"4dd0e8c4f8b768a8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/selectablePresets.js\":\"20c570ca85fda15f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/typesPropertyUi.js\":\"98a30c39c08c54c2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/AddPropertyForm.js\":\"d8476a4f6a86b380\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyPicker.js\":\"58192146a57a3f5f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyRow.js\":\"ab73b93084a299f4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/Rows.js\":\"fff2e37a60b84e61\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/actions.js\":\"5e59eac49b81ac8a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/declarationOnly.js\":\"43dac6e648654a53\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/layout.js\":\"c48ede26cba87675\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/model.js\":\"235e4c611243630f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapeUi.js\":\"cba61bd862275162\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapes.js\":\"85103129b5bda9e8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/usePropertyEditingActivation.js\":\"72d1745c75aa3add\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/visibility.js\":\"7d9e6ca8ce165436\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanelSections.js\":\"f3f96b353763074e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockEmbed.js\":\"e703f090d6219162\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockLink.js\":\"2d8e43c359ecbee9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockRef.js\":\"7623f05edd854506\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/ReferenceLink.js\":\"3b110c17e8909848\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuard.js\":\"54a1c735bda79d8c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuardContext.js\":\"eb647c7174e1faa6\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/linkInteraction.js\":\"2339874bfcc373fc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/referenceLayout.js\":\"1a63320be0ac1c6e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/useBlockRefAncestors.js\":\"578b8af3b9284433\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockGutter.js\":\"cf04db79191250a7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockInfoDialog.js\":\"1083947816b49423\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockTypeBlockRenderer.js\":\"755dee13da2be2b7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BulletHoverCard.js\":\"e57ec8b855875628\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorContentRenderer.js\":\"01200496629ab9ff\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0f23b1b79b9f0567\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ColumnResizeHandles.js\":\"fb87dfe280d6bdd3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e56fda73434d68a4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/DefaultBlockRenderer.js\":\"87db8204834acf98\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/LayoutRenderer.js\":\"29fb896675b17ed3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MarkdownContentRenderer.js\":\"ee13ca69d4afb684\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MissingDataRenderer.js\":\"39a6da84aa833d2d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PanelRenderer.js\":\"faee9bde4f8ea3f3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1e29a8c8bbea22cf\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/TopLevelRenderer.js\":\"aa6e6ca7531cd77a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockGutterMode.js\":\"c12322785dd97541\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockTitleText.js\":\"d0ecd91e3130b9af\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/fieldCreationKeydown.js\":\"9dfd41af93de3efa\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/layoutRootContext.js\":\"0d060be79fc500ab\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/TypeChip.js\":\"8a508af6a0f9bf34\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/chipStyle.js\":\"8f741a0a724ca64a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/anchored-floating.js\":\"6ef567d34b20169c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/button.js\":\"cd1b7ed8797beb57\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/card.js\":\"69c344879cad691e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/checkbox.js\":\"ca085f39be5801a3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/collapsible.js\":\"71e4aa0701b156bd\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/command.js\":\"dbe9a0dec5f3b7d0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/context-menu.js\":\"4d03a4c4a38109b4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dialog.js\":\"849e01389e0a98ba\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dropdown-menu.js\":\"52ea5c549b96ed1a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/floating-listbox.js\":\"fead93ff5b12e258\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/index.js\":\"59759021793153fb\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/input.js\":\"591c38ab36663dbe\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/kbd.js\":\"90e457e1f770db02\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/label.js\":\"96fe18868a457f85\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/textarea.js\":\"adac959684eae645\",\"/knowledge-medium/pr-preview/pr-1855/src/components/useEditModeYieldKeepalive.js\":\"428953b0b35e779c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/BootFallback.js\":\"8e5e20eb69022fd4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/FocusedRowLazyMount.js\":\"ef1c809db0f45ceb\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LazyViewportMount.js\":\"46a55b7008293a78\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LocalDbCorruptionFallback.js\":\"a8f193abb66fbb99\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/error.js\":\"17f74867e414c006\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/lazyMountRegistry.js\":\"fc7ef46f39e6b47d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/suspense.js\":\"1abececf79159e2f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/CreateWorkspaceDialog.js\":\"94a0bcd7c9d847c2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/PendingInvitations.js\":\"ef3b707b0480f148\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/SyncProgress.js\":\"381aee0653bb01ec\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/UnlockProgress.js\":\"3d5de0cfc221a8ad\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceKeyGate.js\":\"a0c369a825718233\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSettingsDialog.js\":\"cef0599feefc93f3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSwitcher.js\":\"4aec1257fbe6cf08\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSyncGate.js\":\"dd5277b5fde94766\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlow.js\":\"fc4ad5f42e1c35c2\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlowHost.js\":\"839009217814d9c9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/EncryptionSection.js\":\"089367236cfa9e68\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/attachmentPrompts.js\":\"aa50ebe25e331ef8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6fcf55e26f4ad484\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowDeps.js\":\"0b5d8fad2f5b94f5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowStore.js\":\"cf0818dfc43aa14e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/flowUi.js\":\"413c0165a0221e0b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/useConversionRun.js\":\"8e40d99cb4fdd916\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/keyUi.js\":\"fa8351bdaef0a1b7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnKeyLoss.js\":\"280e0b337d9a06bb\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnServerE2ee.js\":\"6c5322e88711f9a0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/workspaceUnlocked.js\":\"7f41cdbc6cddaddc\",\"/knowledge-medium/pr-preview/pr-1855/src/context/backgroundSubtree.js\":\"5fb2a00cb2d02a19\",\"/knowledge-medium/pr-preview/pr-1855/src/context/block.js\":\"9ef5163c4d86d4ef\",\"/knowledge-medium/pr-preview/pr-1855/src/context/layoutWsContext.js\":\"70e3ce8b68cba3ed\",\"/knowledge-medium/pr-preview/pr-1855/src/context/propertyDisplay.js\":\"05e373d6422bffba\",\"/knowledge-medium/pr-preview/pr-1855/src/context/repo.js\":\"bd02cfeeba20949b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasClaim.js\":\"5cb34f3ad461b01a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasSeatNamespace.js\":\"07df6ae30ddb286c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockData.js\":\"745ca77cfa7611a8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockType.js\":\"a9515682e8b96043\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/changeScope.js\":\"4310a89a8489fcd2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/codecs.js\":\"8c34277354cef371\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/derivedData.js\":\"27ae988262746dd4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/errors.js\":\"5d2d0414c1d16f5c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/events.js\":\"863ef4d0f4bbe00f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/handle.js\":\"b3c44560e67712d4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/index.js\":\"de8fdfa8e558a737\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/mutator.js\":\"917f2e0fda61d579\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/processor.js\":\"46eb54216fffde99\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/propertySchema.js\":\"b3225c790a8a20cd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/query.js\":\"b5beff7256009d27\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/sameTxProcessor.js\":\"3bf6da3d07dec5e6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/schema.js\":\"b3c44560e67712d4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/tx.js\":\"b3c44560e67712d4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/typedBlockQuery.js\":\"f8744028e1aa4c55\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/user.js\":\"2a94285bc99284ae\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresetCore.js\":\"889655d79ff1d60d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresets.js\":\"13ee09ec9ca61635\",\"/knowledge-medium/pr-preview/pr-1855/src/data/attachmentCleanerIOVerb.js\":\"7733ad5570cb580d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/block.js\":\"68172568b0571893\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockCache.js\":\"603514fd8bb1a14d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockId.js\":\"a8c726094d802f14\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockLiveness.js\":\"b5bd467ff67b3945\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockMerge.js\":\"aa88223f9118e6c0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockSchema.js\":\"18da6c484a125c95\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypeLookup.js\":\"27971f1b608858cb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypes.js\":\"628f483a9181095b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/childrenView.js\":\"a0a80db41d2498ee\",\"/knowledge-medium/pr-preview/pr-1855/src/data/clientContext.js\":\"4cc4e8c95f260e77\",\"/knowledge-medium/pr-preview/pr-1855/src/data/dbFileSiblings.js\":\"e95713b467f5b747\",\"/knowledge-medium/pr-preview/pr-1855/src/data/definitionSeeds.js\":\"91a393873485c827\",\"/knowledge-medium/pr-preview/pr-1855/src/data/derivedIds.js\":\"de7f893795f3f7d1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/drawnSubtree.js\":\"982634647b63e99b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facetBridge.js\":\"e92f192cddb8139f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facets.js\":\"791f8768b24e2042\",\"/knowledge-medium/pr-preview/pr-1855/src/data/globalState.js\":\"35710628a4306739\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/aliasClaimRederiveProcessor.js\":\"f19e9d26a91abd41\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/ancestorBatch.js\":\"ebfb3f1921bee7bd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/blockTypeTypeifyProcessor.js\":\"19bde72249d8a4b2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/clientSchema.js\":\"ae455eaf872ee575\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/commitPipeline.js\":\"a870eb9de3522f83\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/devAssertions.js\":\"13d3cb3b7fceafc0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/firstSync.js\":\"03889c3bfcbdb13b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/freshInitialLoad.js\":\"dde1c187bea1d672\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/graphBackfillClaim.js\":\"85ed2e4c8428f6c2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/handleStore.js\":\"77a7b4e5a43c1ded\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/idleMarkerJobs.js\":\"54b2da86349dfed8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initialDownload.js\":\"b98c0e7e1ec4c158\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initializeClientDatabase.js\":\"709bf20ab173422b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/jsonCanonical.js\":\"8262279cac9a3588\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelInvalidation.js\":\"85fa024a2032c801\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelProcessors.js\":\"c778bebbf41db930\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelQueries.js\":\"88a4077c6b10ac6a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/mergeTypeMembershipProcessor.js\":\"78c3e603e6b5da6a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/normalizeReferencesProcessor.js\":\"4c789f5c1661af4f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/poolInstrumentation.js\":\"0fd8b18975820626\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/processorRunner.js\":\"a813df7c355d917a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyCellBackfill.js\":\"7c921d7bb3029c2e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildMint.js\":\"7bd4fc50bd09dc95\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildrenProcessor.js\":\"4085b9ed7e05541f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b9cb17d295b420f0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionSynthesis.js\":\"6380da96ef3873fb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyKeyScan.js\":\"af1e283938ade85b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertySchemaResolution.js\":\"27b46bc6fc51e9ef\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyValueEdits.js\":\"8963192906b87bfd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/raiseProtocol.js\":\"a5977ce278d34464\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/readBatch.js\":\"d1dbfaf280563a44\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/refProjection.js\":\"67911ec33369281b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetLookups.js\":\"36d1816fd0508f0b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetProcessor.js\":\"e1ea5e196ca3cbff\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/replayMerge.js\":\"ea547db0512aadac\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/sqlBinds.js\":\"477e61eda75254a0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e1afaf0e5bfa4836\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/arrivalProcessors.js\":\"c7b05354ce7deef0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/invalidate.js\":\"016d5b4122291aa0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/materialize.js\":\"a340db6eb5b56324\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/observer.js\":\"d55a69dba354ef31\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/reconcile.js\":\"bf9169a7cb025f95\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/timingMetrics.js\":\"828edacaf9feaacd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/treeQueries.js\":\"090678451abebf1c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txEngine.js\":\"1662fcf6935ba304\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txSnapshots.js\":\"61970e130ff2839d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/typedBlockQuery.js\":\"0d65c2df09139f7a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/undoManager.js\":\"fb214634e1ca6911\",\"/knowledge-medium/pr-preview/pr-1855/src/data/invalidation.js\":\"d3c42b75e103877e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelDataExtension.js\":\"d0e1733eefa7f224\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelPage.js\":\"90f3df6c979b9d5d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelValuePresetCores.js\":\"ecb5b86fcebe82a9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbCorruptionSignal.js\":\"3074710c09d634f6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbStorage.js\":\"aeca49131d6ff412\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbVfs.js\":\"64df73fcc1298d57\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localSchema.js\":\"1656d7eb28f913b5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/maintenance.js\":\"0a8f60b98c981f8d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mergeProperties.js\":\"4f228df06f7864b8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/metricsConsoleHook.js\":\"58f1ab9024a46e36\",\"/knowledge-medium/pr-preview/pr-1855/src/data/migrationsPage.js\":\"b552d0c42e6c7117\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mutators.js\":\"fc9556e965a03c0e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKey.js\":\"47a907a14d02cc0f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKeyPlacement.js\":\"369c4c135f218c44\",\"/knowledge-medium/pr-preview/pr-1855/src/data/outlineSurface.js\":\"469800bc8c093607\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingEditorContent.js\":\"f87edfb7e9df0c42\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingUploadsSql.js\":\"735041f26f6d2ecc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pluginStateExtensions.js\":\"7f0789ad7cc4d9a2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/powerSyncLogger.js\":\"1598f937ebca4af8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/projectorRuntime.js\":\"4603ea6217b48baa\",\"/knowledge-medium/pr-preview/pr-1855/src/data/properties.js\":\"c7b04b5c1e5f1558\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertiesPage.js\":\"b8a4c46b633e0e4e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyChildren.js\":\"1479b98caf13ccbd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionFanout.js\":\"412daac71cd76508\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionMetadata.js\":\"7187b8a4d4947203\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionRegistry.js\":\"9e28f176de2ec899\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDisplayMode.js\":\"99175a5a13ec87b3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyRowCreation.js\":\"d505396d5bc6f2ae\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySchemaCreation.js\":\"ab14ca073ca9bc3d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySeeds.js\":\"a287798a2e66de70\",\"/knowledge-medium/pr-preview/pr-1855/src/data/recentsPage.js\":\"94adb776dae44288\",\"/knowledge-medium/pr-preview/pr-1855/src/data/referenceBlock.js\":\"936bf1172c939908\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rejectedUploads.js\":\"f58524335cec8c06\",\"/knowledge-medium/pr-preview/pr-1855/src/data/releasePowerSyncConnection.js\":\"3b104244e7e98645\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repo.js\":\"c4528d5696681820\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repoProvider.js\":\"5508c07172a99090\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rowProperty.js\":\"9074972f67c287b0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/searchFilter.js\":\"aff3fa33eb68d29c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/seedIdentityLedger.js\":\"48993c829b09f529\",\"/knowledge-medium/pr-preview/pr-1855/src/data/stateBlocks.js\":\"1d0ab1726cae828c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/structuralEditPolicy.js\":\"b59ffbf547026866\",\"/knowledge-medium/pr-preview/pr-1855/src/data/subtreeDelete.js\":\"750106eb1f8afc5c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncStreamLock.js\":\"435462867a352e5b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableSqlRecognizer.js\":\"52d7e0fcf74b1c5b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableWriteGuard.js\":\"9e0dd02c9e7c2fb5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/targets.js\":\"00e4453eaf0dcca4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeColors.js\":\"ad775cade04f7501\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionMetadata.js\":\"69b0f0b84123caf9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionRegistry.js\":\"722c4d4c32d75bb9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeExtraction.js\":\"58a2e8fa68174a03\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeInitialValues.js\":\"c3e3ce7739baab5d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typePropertyGroups.js\":\"537d4ade9e5b32e0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeSeeds.js\":\"9e3be8f68562c492\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeTagger.js\":\"4309a0174c29a0d7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typedRecords.js\":\"6e4799e060146193\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typesPage.js\":\"0956513bc30954f6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userPrefs.js\":\"e33ce0142dbef663\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userSchemasService.js\":\"5ae7e948afa66f6a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userTypesService.js\":\"5eb30c13d454bd17\",\"/knowledge-medium/pr-preview/pr-1855/src/data/valuePresetRegistry.js\":\"91cea0dd6784d659\",\"/knowledge-medium/pr-preview/pr-1855/src/data/visibleChildren.js\":\"9e73cb6fcf9a2f16\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceConversion.js\":\"769f30e7bca7d444\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceFirstSync.js\":\"1bc33dc6e4a2e7ad\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceIdNamespace.js\":\"5e13cf722fb4c4c4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceSchema.js\":\"6472317f84760ab3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaces.js\":\"3bef9b755996087e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadLog.js\":\"6b1114180a5bae4d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/BlockPasteShellDecorator.js\":\"b5fda34e35088f7f\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/atTrigger.js\":\"4e9f41c2b668c652\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/autocomplete.js\":\"2d215e67dffc299a\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/codeMirrorExtensions.js\":\"616854faf5f0c0c4\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/contentFlush.js\":\"12e13f79091c08e6\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/defaultInteractions.js\":\"53f0613d5f83db09\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/editSettleSignal.js\":\"9b4e7aaf95ed7951\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/insertImage.js\":\"266dd64e44cbfb88\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceCompletionRange.js\":\"3b1ea442c7f8ccef\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceTargetTypes.js\":\"75327f75ce378e3d\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/syntaxContext.js\":\"6c6927604c37a31f\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/triggerMatch.js\":\"f2d0cd15add287cf\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/AppRuntimeProvider.js\":\"2ef478fbd39d4434\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/BlockFocusShellDecorator.js\":\"b563b0b3b1e08f9a\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/ExtensionRenderBoundary.js\":\"a14068d35e9b3932\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/PanelContentRecovery.js\":\"1b22f5273ff93835\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/apiCatalog.js\":\"1798f357422777d4\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/approveExtensionHere.js\":\"65eef69cca4c465d\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/armedCutAppMount.js\":\"869f8031f80a8324\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/batchableKeyedStore.js\":\"3f1befcc8d9ed541\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockInteraction.js\":\"7e9af0b68e80b86a\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockSelectionAction.js\":\"bdd23f8dac430d9c\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compileExtensionModule.js\":\"298c5dec6e2f9ba5\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compiledModuleCache.js\":\"7e49ec07d2c32461\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/continuousGestures.js\":\"f16c021dcbd10aa6\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/core.js\":\"6c60fd338c28f1d9\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/defaultRenderers.js\":\"7c9ce369bea4ac3f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/definitionFanoutAppMount.js\":\"bb7971814eb55ac5\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dialogAppMount.js\":\"2c1505ef62927beb\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensionSeeds.js\":\"aadcbebf90ac4033\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensions.js\":\"2432883f4fc369e2\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/exampleExtensions.js\":\"da82eea9a0a538ff\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionApprovalStatus.js\":\"78e0fbeb80662092\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrorToast.js\":\"e6668981f394f2a0\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrors.js\":\"edb5f762cb2a8b99\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLookup.js\":\"c2c91b9b2ec72b09\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionToggles.js\":\"8d0649d70b638494\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionUtilitiesCss.js\":\"69f0e3785c54dd49\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/kernelPageDeletionGuard.js\":\"2d14cd6009881a3e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/liveRuntime.js\":\"c3f6995f551b3b15\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/openExtensionsSettings.js\":\"3ca099116199e53e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/overridesCache.js\":\"dbc8a078ab9a3bf2\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/pluginIds.js\":\"ccf300b3827891bb\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/processorRejectionToast.js\":\"80167919899f0c8e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeActions.js\":\"301557e6d798c099\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeContext.js\":\"dacf093867c72b13\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticAppExtensions.js\":\"166970fbdaa7ceeb\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticDataExtensions.js\":\"a7294f917e89f2c2\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/toastAppMount.js\":\"e732226dc1420902\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useOverrides.js\":\"a9bb9dab52b40ebb\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useShortcutSurfaceActivations.js\":\"f457d134dceba64d\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/discoverToggleTree.js\":\"c1f654e231b6961a\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/facet.js\":\"60d8555df78cd2c6\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/resolveAppRuntime.js\":\"a1761f467f82a818\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/runtimeEvents.js\":\"f72d603686753c8e\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/togglable.js\":\"3857c45c8d20d2fd\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/variantFacet.js\":\"c3d537aade42730d\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/verbFacet.js\":\"93d99b207ae77df7\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/block.js\":\"3fc61aa5b50181e8\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/focusedChild.js\":\"6908e67c71d74d9a\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/propertySchemas.js\":\"e8d0e09eea06fde1\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/typeRegistry.js\":\"78e938bfa69eee01\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAncestorCrumbs.js\":\"e0c6aba7d652b14c\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAutocompleteListbox.js\":\"500b42cd2d3640d6\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedSearch.js\":\"4b986700cf69ec2a\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedValue.js\":\"34485828c1e7246c\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsFocalRender.js\":\"4a708528049da909\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsReadOnly.js\":\"f339bd10f875f015\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMaterializeBacklog.js\":\"e2c179948571dbd7\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMinuteClock.js\":\"f92fb1256d8c45be\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePanelLayoutProjection.js\":\"39a1be9ef53b3962\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePendingInvitations.js\":\"6f9d3165a0d38110\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRendererRegistry.js\":\"77460bafbcb114da\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRetainedFieldRows.js\":\"38c14967e1a849ff\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useWorkspaces.js\":\"cb3269db7ee12292\",\"/knowledge-medium/pr-preview/pr-1855/src/lib/utils.js\":\"18e7a65bae2a0bf5\",\"/knowledge-medium/pr-preview/pr-1855/src/main.js\":\"ed23c774e0a6b987\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/MarkdownImage.js\":\"526c4c3e1dc82912\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/blockSeparators.js\":\"467906b57f3db86c\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/context.js\":\"0b91b68a5825d84c\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/defaultMarkdownExtension.js\":\"bea8d3547d086210\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/extensions.js\":\"3c32b47892892d82\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/renderMarkdownHtml.js\":\"93f4fe6140712285\",\"/knowledge-medium/pr-preview/pr-1855/src/minimal-editor.js\":\"7f8e15f9a81665d9\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/armedCut.js\":\"804cab4359c81e0f\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/captureMediaVerb.js\":\"1da64fe4f0a2346f\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/clipboard.js\":\"8d22669b19a29fdb\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/decision.js\":\"e48c4eedfc8a7f7e\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/operations.js\":\"5dc57dbd929dd2fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/AccountHeaderItem.js\":\"768bd12e19ece10b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/index.js\":\"4a29e600a0d1a22e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c04ec29b65b9609c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askAgent.js\":\"574cec2e99be2af4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askedStore.js\":\"b97c2aa77450e22c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a87cf6bd37e71265\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/chipState.js\":\"a0e67b24e71c2f44\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/dataExtension.js\":\"be4e06dcb3c955f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/index.js\":\"74e6b9083ff3225e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"826395c817828e97\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/schema.js\":\"90a410c6e1d20042\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d3c06f208f051a20\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0fe40b728bae9dca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/addMedia.js\":\"bc70ef8e78b781bb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1b0041a362a49cd6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/block.js\":\"ad7ca43f7eb1266f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/context.js\":\"a52a39a4bc1dd5d8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a9b12dd2337dfc39\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/index.js\":\"336c856083780258\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/outline.js\":\"a06eab3dc391b637\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/properties.js\":\"143d5364b715a925\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/refs.js\":\"639dd7728a32fa37\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c02292ea8602980c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/search.js\":\"abc67e3cd94b60c8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/shared.js\":\"cc2e5fb8ed112dcb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ec2f15d95fee0117\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/text.js\":\"5fe376f2d9a927f0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentWrites.js\":\"aec1504cf1806356\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/authoringCatalog.js\":\"9ae94ff35c508e6a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/blockRefTargets.js\":\"9cb578609903ace0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridge.js\":\"a7909735280c3f6e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridgeLoop.js\":\"314601b46b6d88fa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/changeHistory.js\":\"53a25458928f1eee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commands.js\":\"072509b5acd68e54\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commentsCommands.js\":\"27d831816b65c795\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataExtension.js\":\"d4f3aaedb26cc111\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataModelGuide.js\":\"04571d49063ce5b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/describeRuntime.js\":\"b6394a07598e6e6d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/extensionLint.js\":\"a357c8e3e0069144\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/grainAudit.js\":\"1f51c398849d9b63\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/healthCommand.js\":\"7ee72494134b36b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/index.js\":\"f56e4e984267e36c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/presetIdentity.js\":\"bb94e5950f486fd3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"976a4d9f80246826\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/readMedia.js\":\"f34963d14d9d0132\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/schema.js\":\"25b9be7631e0c2e9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/serialization.js\":\"18a42c7d9ef86221\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/targets.js\":\"312c94bfb344e772\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/tokens.js\":\"e692e962a0abd5e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/watchEvents.js\":\"c6715047d333b332\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/workspaceGuard.js\":\"c2585621b7739745\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/writeCommands.js\":\"d6d339f0b1439221\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/AliasCollisionToast.js\":\"f89a8981ee5dee55\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/DuplicateNameBanner.js\":\"dfe3f17a551fcec4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/collisionMerge.js\":\"24ce54c1cfeabbfb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/dataExtension.js\":\"9294fa621791fe27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/index.js\":\"8897c7062f33fdb3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/mergeCollisionAction.js\":\"65d7ddf42a2468ed\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/pageStyling.js\":\"6e227d289b4d9b0f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/rejectionToast.js\":\"50144cc690af58e9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/syncProcessor.js\":\"77d21898b83fc68e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/actions.js\":\"c6a2dc1756ae2a3c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/addComment.js\":\"281cf90ef1022fd9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchor.js\":\"b05743085c30b804\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchorState.js\":\"a456791d24551ebf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/commentLinks.js\":\"0d65f5c4bb875f08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/confirmThreadDeletion.js\":\"cfc18a085397d3bb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/container.js\":\"ddb6b7c00f8112ae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/dataExtension.js\":\"17e78c84087dbbb7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/deleteComment.js\":\"2134ef908601effe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/highlights.js\":\"395d54ccbca314b9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/index.js\":\"885a65b89702cded\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/linkedCommentsPill.js\":\"1e605b516065a757\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/margin.js\":\"fe75b2e835d6cf0d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/marginSchema.js\":\"97b38616f0c612b6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/newComment.js\":\"3bc36315c4da4151\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ownThreadPicker.js\":\"ede2d9fd93d816c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/placement.js\":\"d08c6c55a9eeec75\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/queries.js\":\"22cd00f635ff6a8a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotePosition.js\":\"0ce9235292810079\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedIn.js\":\"cfd133f807e9f653\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedRange.js\":\"3c516dfb9ca90987\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/rangeRefs.js\":\"8639e2dfc1da13eb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readHighlights.js\":\"b69979f355a92dd0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelection.js\":\"4690eaf00fdaa6e3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelectionUi.js\":\"d15980759645de8c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/reanchor.js\":\"d5b1eb4fb11bfb0c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/schema.js\":\"ad34f5e8363283a9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scope.js\":\"d45afdf313005f52\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scopeThreads.js\":\"32c1bfc66871cdf7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/splitRetarget.js\":\"7fe363bade7bca87\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestionCard.js\":\"cd2fe14804260787\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestions.js\":\"0e34b2d05f3b9c59\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaries.js\":\"b31e8ddde43953ca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaryBatch.js\":\"384e2178a03cf95f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/surface.js\":\"a7b676913d57b608\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threadNavigation.js\":\"8b21f41846dd6a53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threads.js\":\"803ae4600e087f8c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ui.js\":\"37db707a02474f0f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/uiStore.js\":\"3abdb356a54943b6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/appIntents.js\":\"5631ee4769bf02b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/index.js\":\"02cab35f15093e80\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/index.js\":\"a996ce850052aaf1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/status.js\":\"b41b81f1054d68c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"def2f6e927a8a8ca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaBlockRenderer.js\":\"767fbd9e4f2daca7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5ff8e00026740017\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaUploadReconciler.js\":\"baa17ba54aa19948\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetDownLane.js\":\"0b48ec2f420c85f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetResolver.js\":\"4ce9a3de20474d95\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetUpload.js\":\"705191b04ae5f206\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/attachmentCleanerIO.js\":\"253de2a7e079b88a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7a5055f2f3d8b406\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/blobStore.js\":\"65546c331ddfc132\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/byteStore.js\":\"cd9fbcff23da8216\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanerIO.js\":\"1ea51c31b3754d0f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanupAttachments.js\":\"09486db5f8478189\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/dataExtension.js\":\"47b5ec291e4c2600\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/downLane.js\":\"354f89b0202cd747\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/index.js\":\"0281512b98e62547\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/insertImageContribution.js\":\"6483ebd8edca05de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneArming.js\":\"f634c243b0c8bc37\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneLock.js\":\"0bae5a45542b5627\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaBlock.js\":\"6071f25aada8478b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaCapture.js\":\"455da786b8f34492\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewers.js\":\"40678e1325cdb6ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewersFacet.js\":\"605c5bf41c311255\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/pasteCapture.js\":\"3c8685a401affe8b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/resolver.js\":\"5b0889f392a7bef8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/retryUploadsAction.js\":\"0bb8c17900289901\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/storagePaths.js\":\"f68d1f50eb318df6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadDrain.js\":\"afacc9a836e98f69\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadLaneStatus.js\":\"a3bf5a1b1f8f1cb4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadReconcile.js\":\"249da1ad504dd82b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadRecovery.js\":\"868541d9c9fb4d12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadStore.js\":\"ec849537411c04e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/useAssetObjectUrl.js\":\"910a5fa32cf8f345\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"219acfa41d9cec6d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fc997f4cc4dbd30a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/facet.js\":\"4d233eab59ff8c54\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/index.js\":\"95107598336e0bb8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/prop.js\":\"015059292f15ac21\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinkFilters.js\":\"99cf700f8773f848\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"be402e62863359e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BlockEntry.js\":\"25987204a0f2231c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/LinkedReferences.js\":\"4c194e223d04483e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"46a59c5ceda14a85\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dailyNoteDefaults.js\":\"198726367065a931\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dataExtension.js\":\"c57c22f3737561f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/edgeExclusions.js\":\"82c3a7285a22eb3b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/filterProperty.js\":\"ee9f943e0f245880\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/index.js\":\"fc8f5aa53022e7a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"87d5e72da8293f91\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/applies.js\":\"d4c27ce1a65b2aa2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/countQuery.js\":\"c80a4f671197f146\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/expansionStore.js\":\"936ebacf83b308e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/index.js\":\"7d4cd5dc49e2eb25\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2c735c17b45795ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/presentationInvalidation.js\":\"c23b07cf07069973\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyEditorOverride.js\":\"04dc652b6e66d7d3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyFilter.js\":\"6197cc265d3dff90\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/query.js\":\"379c516665759583\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/resolveFilter.js\":\"435db4b816ea78a1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sourceBatch.js\":\"d543307bc74ef58f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sources.js\":\"78d0374ec70a13b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useBacklinks.js\":\"541a44f34af8f278\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"eb1fae777e06f4ae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayCelebration.js\":\"e52ab0f4b56f5851\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayOverlay.js\":\"2da334a23ff8d0f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/gate.js\":\"75751a9bd9d9785a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/index.js\":\"ed4a9cfb8afcf65e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/wolfTheme.js\":\"327687b367a70388\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/BlockDragLayer.js\":\"36cd6e4ee3430328\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dragController.js\":\"84e8e8908c7511cb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dropTarget.js\":\"0053d41c37d7c65c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/index.js\":\"73750b7160018d73\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/projection.js\":\"709d02e80e0f0407\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/BlockMetaCard.js\":\"ca2cc8ae4a2f3f8a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/index.js\":\"d611f60a91471dcb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/AddTagDialog.js\":\"1f085e17260f8f87\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b6515dd487b78442\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/TagNameIssueHint.js\":\"07a7110582b6447b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/addTagAction.js\":\"fb0a8c983c7e4554\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/appendTag.js\":\"2cd060243b577bc6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/config.js\":\"a7f9fe8e184cd3e5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/dataExtension.js\":\"2dc82a5bcc6ea95e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/index.js\":\"5965672b7c64a67d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/propertyEditorOverride.js\":\"ed3fd8dac33af16a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ed4c69e137a6c061\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"815ff11f98e67f2d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f1e503dc0b06b05b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ccce4a27fce08733\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8141be7f8576e166\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/index.js\":\"44e9b4e6c16fc687\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f2d57df5e7012d27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/CharacterCountItem.js\":\"41fba844cf2aaebc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/ProfilePropertyEditor.js\":\"455bc9e240ea77e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/actions.js\":\"b1dec4b81d665982\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/blockType.js\":\"531f9140df0fac22\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/charCount.js\":\"d298a381acf9020e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/dataExtension.js\":\"c2f80b931a578a74\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/index.js\":\"611d3385c1c2871e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/profiles.js\":\"2ceead39fc7f1a39\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/properties.js\":\"857650859511fd63\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/textCounts.js\":\"048d19e3c199e4a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/colemak-keybindings/index.js\":\"2662a02bd930e173\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/CommandPalette.js\":\"227adae9c5d7d432\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/HeaderItem.js\":\"415a8414c0f7e147\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/context.js\":\"68fadffedb7cb516\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/index.js\":\"d41f49819de183b3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/selection.js\":\"2141271873ba82c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/toggleStore.js\":\"00bde28552e039cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/useCommandPaletteActions.js\":\"52c43244d5c99007\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/ContributorBadges.js\":\"77c623cbccf13610\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/author.js\":\"edde8cbcb663eaaf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/codeMirrorExtensions.js\":\"8d6393d3dd0d7f47\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/dataExtension.js\":\"0e60fb953a54042a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/index.js\":\"5031b9c0e2a8ba03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/mentionAutocomplete.js\":\"91a2930eb8221e08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/processor.js\":\"6b000da2e56f7450\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/profiles.js\":\"39e4012b0c033225\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/queries.js\":\"f584c06a0e4c4f22\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/schema.js\":\"ae6c5b7fcc1e97b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"80a78f45a104adc2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/followOrigin.js\":\"bb9a81cd18d4aff8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/index.js\":\"c92cd6bb0922f0c4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"455ce71c07d1d0c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2816f078226c45c6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/CalendarGrid.js\":\"4f4995c8796304a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DailyNotePicker.js\":\"f1e9eb3e7d5cbcbb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4cbdcf82bb64a26c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateNavDecorator.js\":\"5b7d87cfcbd1b728\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateScrubOverlay.js\":\"1b6fc547576b0072\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/HeaderItem.js\":\"47f396c53ef75b41\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/ReschedulePicker.js\":\"837ff9b6fd63afa5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4934709421547151\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/actions.js\":\"0aff35dac3a81a8c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/blockDateAdapter.js\":\"b60415a6a208bd14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/calendar.js\":\"bb0f6040be2560aa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dailyNotes.js\":\"d901fb34f9bbc615\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dataExtension.js\":\"372b9c3aa29a9852\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubActions.js\":\"c1bcd3d00c34428f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGesture.js\":\"34467f05fc6d601c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d7855b6ae2ea2ab2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e866a13de8666013\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/deletionGuard.js\":\"9dfe9cdccfd78c06\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dueQuery.js\":\"8f9e1eff581d043f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/index.js\":\"e1ba35bcd1152411\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/landing.js\":\"243b6b8c7e3dd88d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/localSchema.js\":\"495558428235401a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/referenceDateAdapter.js\":\"8e4bd7b65cfc075f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/rescheduleAction.js\":\"6d3d52ae92ee5eff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/schema.js\":\"e9e0febe5734ec2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadBlockDates.js\":\"5460eeadbb959d56\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadDatesAction.js\":\"ebab14270287ed82\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/today.js\":\"bfaf6f5568bada7e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d9e651ebe12ce9f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"521d3c6c3d9189e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/audit.js\":\"1c53c2bd7103ff63\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditAction.js\":\"c91371fb393a9cbe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditRanges.js\":\"b5cc63200d241072\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/diagnosticsSource.js\":\"af4c717a8e1f4fc3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/divergenceScan.js\":\"888b97fd4b0b3dda\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/index.js\":\"cd0950c2f567f541\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e55961c03ec55ad2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/referencesMirror.js\":\"304db52079456047\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/rowJson.js\":\"522afca00b4d0673\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/schedule.js\":\"cb3f321f2350ccff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/store.js\":\"386729a904f9c41e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/action.js\":\"1153a45216607ada\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/index.js\":\"e7b91970aa0ff525\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/plugin.js\":\"9efaa1be6def4ba7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3e836fe6936bec41\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/actions.js\":\"98e6bf60938d2dc6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/changeMarker.js\":\"522611762683e2c6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/diagnostics.js\":\"26362e31dbd46e4d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/fileSystemAccess.js\":\"6430854b9b63da08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/filenames.js\":\"fea71492460a65ba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/index.js\":\"0caf8f809acd57bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/mirror.js\":\"6f68292839c52e69\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runLock.js\":\"cc0b8689ed67b5ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runtimeHealth.js\":\"2e442c8515aa7ea8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/schedule.js\":\"6d5713184bbcecee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/store.js\":\"02619801cb32c46a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/index.js\":\"e11a414e3b67c404\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/themes.js\":\"002d3c56eaf3d884\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/facet.js\":\"9527dbf1a682a4b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/useDiagnostics.js\":\"ccefe1f9aa442eb0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/dismissals.js\":\"b4ee14da34c130af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/index.js\":\"244c33c704bd0b7d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/status.js\":\"28051191eab98658\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/store.js\":\"b563219008e6c0c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3660371632f4ef03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c5ed19429256382e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/actions.js\":\"bb0f7880dd6917c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/config.js\":\"3cb78f23a079f6c8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/dataExtension.js\":\"623b5a647f75f730\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/effect.js\":\"0d606a9bf0a2828f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/index.js\":\"fd6ea3eef29be95a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9b7d8594f11c7967\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/useToggleTree.js\":\"4529a32fe4a0fc0c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/ExtractTypeDialog.js\":\"acea17227b528966\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"71e174936063e2ea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/PropertyShapePicker.js\":\"6d50ac546a10f770\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/action.js\":\"35591e48d210685a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/index.js\":\"7e70f76baad2d482\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/FindReplaceDialog.js\":\"1b0cc4d887d84d0b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/HeaderItem.js\":\"c08a5d1c7935d537\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/dataExtension.js\":\"d206e1fdf4d6db49\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/index.js\":\"5339bfc3f23e093e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/search.js\":\"ba7484afe65890f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/toggleStore.js\":\"586002f806ca8f53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/LocationPropertyEditor.js\":\"b4efda5adb512ae8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/MapView.js\":\"58a87022a0da3f53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/blockTypes.js\":\"758d0a3a7675b464\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/codeMirrorExtensions.js\":\"626521649e6d8e87\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/createOrFindPlace.js\":\"66ee269b69f532d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/currentLocation.js\":\"149a654d2ac48dd0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/dataExtension.js\":\"0c9180528d490aec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/geoContentDecorator.js\":\"760afc6cb014aa04\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/googlePlacesClient.js\":\"14b180dcf70ef3af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/index.js\":\"d48661df0e57295c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/locationsPage.js\":\"01f6147a7bc61aa4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/mapViewport.js\":\"9b0a3863231b1b34\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/pickCurrentLocation.js\":\"4f03a54309974974\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeAutocomplete.js\":\"8f6e579748084dd1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeNameCollision.js\":\"7a8884575bcd6e9d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/properties.js\":\"2c9586ae2427e20c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/propertyEditorOverrides.js\":\"10a54439053b8741\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/query.js\":\"3a3d83bdd13448db\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/usePlaceSearch.js\":\"62be2e2a186172b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e17c75086a95d735\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1c5e77855aaa43b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9a9ca5d61a72f47d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/config.js\":\"ed8b9b4d42a8e54f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/dataExtension.js\":\"63906a9add86d8af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/facet.js\":\"d4dd8e5cc4e30e9a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/grouping.js\":\"d0eef430c78f6ec2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/index.js\":\"36593e5dce4768a0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bd48919bc9ba81d0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/query.js\":\"f4088fa57ecdc458\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/resolveConfig.js\":\"31f9779e3be9655d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"82e5dc0dab4ab778\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5bdc9c56c90041f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlDocumentContent.js\":\"5383d9ca0d90ce5e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlFrame.js\":\"0cbace7937b276f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/actions.js\":\"5e2334e6871c6fba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/blockType.js\":\"6f8069023bea480c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/confirmRunScripts.js\":\"9c5545a559f25f9a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/dataExtension.js\":\"707365061156ac0a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameAnnotations.js\":\"cc1bd89138c8dd32\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameDocument.js\":\"35ff250bf2049268\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameTheme.js\":\"ac1079199c0e23cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/index.js\":\"4969a90c26308e35\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/scriptConsent.js\":\"ca17ee910cff41bf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/sourceMap.js\":\"69145baaa39894cd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/useDocumentScripts.js\":\"1d629534602047c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/index.js\":\"bebab377a0e4566c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/record.js\":\"fa7a98e3036d9ca3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/recordStore.js\":\"f2bdbef53781f0c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/responsiveness.js\":\"5f226ea5368d3bbf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/schedule.js\":\"09b71577397afdde\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/sessionContext.js\":\"dd47f65444f173f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7056048b2f13832e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"26efe9ed98fc4ed4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/actions.js\":\"f53d3c2b411751c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/config.js\":\"647a23892ec8dcdb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/dataExtension.js\":\"de470ad1c2b16a2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/effect.js\":\"8e2b61a51784536b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/index.js\":\"21821270a73c7be5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/keyCapture.js\":\"7ad77451180690e0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/overrideStore.js\":\"a516ab9b13cae86e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e21c1ee078525dc6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/HeaderItem.js\":\"3d691c2864988659\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/LeftSidebar.js\":\"9987628ca1bb9a6b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/actions.js\":\"f10a4d2ec4ba5568\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/facet.js\":\"a791b9c6a1d0b0c7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/index.js\":\"9af8a5e09580583c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/shortcuts.js\":\"6024d9835ebdddfd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/toggleStore.js\":\"f2ab6e5171f34a5f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/MergePicker.js\":\"8f595e263b9da301\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/index.js\":\"017083422fd79f91\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/mergeAction.js\":\"7dbec18459400b7f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/strategy.js\":\"2b573b00b0199ff3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/Button.js\":\"e29da53f63f73658\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7d1533decd102174\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8ddf636364e809e5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/facet.js\":\"7e0adfbbb001acb2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/index.js\":\"ab8ffb71bc23a1e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2dee70e7f386e716\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2266b3d7f407d333\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ef836c61d6619a86\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/facet.js\":\"39656694be418dce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/index.js\":\"617f769d2ae5d95b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2cc99cb9cfd31969\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4a14a30055b1c7b3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/contextMenuItem.js\":\"1dbd7d867becc47d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/index.js\":\"13eaef0cd973ef3d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveAction.js\":\"e507195742404785\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveBlocks.js\":\"c6fdc7b9c7906b18\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/selectionAfterMove.js\":\"a47cf2365fa019e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/TutorialBanner.js\":\"6e4fbb0f28244aae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/action.js\":\"75f167a81fce7759\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/bannerDismissal.js\":\"8fc77ec7d075ccdd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/documents/cheatSheet.js\":\"c4b609f7187693da\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/index.js\":\"f9c1ada75ced239f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/keys.js\":\"71aab10f378da1f9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/landing.js\":\"2d197171646a0901\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/outline.js\":\"9e9b5cf139aee144\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/seed.js\":\"5f2bbeb85db473b6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b82b1a3eb3562c2e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/analyze.js\":\"2b7a934cf145a73f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/diagnosticsSource.js\":\"2136c2ddfb98e037\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/index.js\":\"220647b3996e9921\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/load.js\":\"43be9af285614598\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/monitorRun.js\":\"91b5869f210e1079\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/schedule.js\":\"4ba3ba1780c23f89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/series.js\":\"76c8a5d2f157f0cd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/store.js\":\"7f2ce68dbd0aed38\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/trendAction.js\":\"03ceb5cdaddc9b40\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/verdict.js\":\"066c54e77856ec2d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/clickToEditAction.js\":\"f0875b406f019150\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/index.js\":\"630d5a1cca459f59\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/interactions.js\":\"6a55cd18fab6c01a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c0522380cbefa249\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGate.js\":\"656c2c8e62213fa2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGateDialog.js\":\"ed0573b4d6275db0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/action.js\":\"8a34b072d997f45a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/index.js\":\"55d0eef2e57a2e58\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/localRunMessage.js\":\"38c055ec4bf9618f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/plugin.js\":\"af8cd9a59ce604b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/progressReport.js\":\"78511a85a4a3f32f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/sweepProgress.js\":\"b36aade1c904852e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/FieldRowRenderer.js\":\"391ca236bfee9ef7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/ValueRowRenderer.js\":\"1c484d938cc88ed1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/actions.js\":\"e5b9c0fe583b4888\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/autocomplete.js\":\"521ef6bf02dc3972\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/fieldRow.js\":\"e0b8aff60df26f53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/index.js\":\"82ecb709b4280b7c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/referenceWarning.js\":\"af6375437906466b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueAutocomplete.js\":\"ae887f42b8177a23\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueSchema.js\":\"de891ed90387b9b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/HeaderItem.js\":\"11b7cc7322201494\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/QuickFind.js\":\"340cca7514c044cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/index.js\":\"d925c19096b4299e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/recents.js\":\"127d9443df893a99\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/resultItems.js\":\"9f7cd59660efd316\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/selection.js\":\"fb39e902706bb7b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/toggleStore.js\":\"d221f08991e21022\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/HeaderItem.js\":\"0620c41d43c33884\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/RecentsPageBlockRenderer.js\":\"13605fbf6a758f3f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/grouping.js\":\"31397a79157d5797\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/index.js\":\"d690935288654efb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/target.js\":\"d8ef2253e71cf882\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/codeMirrorExtensions.js\":\"35ad6125b47e0826\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/contentPrefill.js\":\"f408dc9612a2e576\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/dataExtension.js\":\"37de29e2fe3be153\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/index.js\":\"4029acf4897e1923\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5755b71ed25f309f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/invalidation.js\":\"13f76cfa0bf323f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/localSchema.js\":\"db8de489896759dc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/index.js\":\"979fa7aac09a1700\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"494e6932e50af3c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/index.js\":\"e7339e23a7b18570\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/referenceNode.js\":\"730409aa41094717\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f025b498445f26fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6d44725f900411cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/index.js\":\"28bd299c2e04c3ee\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7b1823bddd1afbea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"17d7a490919a779d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/mergeRetargetProcessor.js\":\"059fc8e5d94b2c61\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/parseFence.js\":\"0908810cfcf1065a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceParser.js\":\"1fab4d75632d581b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceProjection.js\":\"ebf20b90de1bfa53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referencesProcessor.js\":\"555145ad232a213b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/renameProcessor.js\":\"bd702ee64e26892e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/spanReplacement.js\":\"5d373b7ed61aabc4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/htmlToOutline.js\":\"8dde221ba1a1512e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/index.js\":\"afffdd07f20c2111\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0ba4dd8cde3d7581\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/pasteDecision.js\":\"6cf726543b919bd8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/action.js\":\"b6c4287445ba1995\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/blockIds.js\":\"0dfb1118c7ff2629\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/content.js\":\"98e3f0103249b7cb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/effect.js\":\"5fd918de9d14ee63\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/ids.js\":\"704b3eb7761b6f11\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/import.js\":\"6825591d1344c858\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/index.js\":\"932fcc268fe9fd6f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plan.js\":\"e291aa4363b08c03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plugin.js\":\"cda21e63cf5d6ede\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/promotion.js\":\"f5c0acd9a1f45e5b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/properties.js\":\"ade528f75bd3bb2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/references.js\":\"4db392bc1bca7ebe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/report.js\":\"344c73c617ee6180\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/roamMemo.js\":\"d0436ca21d0fdfcc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/runtime.js\":\"135ad8ce4f37d123\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/schemaReconciliation.js\":\"3454b3141ff46c45\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/srsMarkers.js\":\"eccc36cf7f2a451d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/todo.js\":\"cedd32cdf18a53f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/typeCandidates.js\":\"e425e36959c909d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/types.js\":\"6e1eaa8d256eade2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/index.js\":\"7001139cd53e1c5e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/store.js\":\"25fafc0d08c862a2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/HeaderItem.js\":\"4bc3b34ba727a3b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"08a9f2024efacbad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/index.js\":\"34b76aa7d8e2c51d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/model.js\":\"13fdc30b81795c39\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/toggleStore.js\":\"753493f4abadc17a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/useKeyInspector.js\":\"7c99a2e0f051c774\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5dd63436fba464cc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/ShellDecorator.js\":\"7f05cff7b2264bf0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/actions.js\":\"d6e642fd05a51c5c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3d2c6e386a814f83\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/index.js\":\"f2d9f97940911cb7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/shell.js\":\"0220b3214b351dd5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/surface.js\":\"0c67de3a3fbbc36c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/walker.js\":\"b06f91a1f7484b65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1e1762406a519a2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/dataExtension.js\":\"bb14e07956fd8b70\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/index.js\":\"d69688d1dd691956\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/indicator.js\":\"8d40043b956d9896\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/moveSrsState.js\":\"09b687c5dcc9e5a5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"cf652aed2f09706c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/scheduler.js\":\"b088551c9ade81ab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/schema.js\":\"b61d1909afda8b1c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6b36f66198ffdf6c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsClipboard.js\":\"e4c2b712c38df818\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e091cae4af049b77\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DailyNoteReviewHint.js\":\"65b914f12871e534\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DeckPicker.js\":\"7fc0d29f19d3f6ca\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewControls.js\":\"b0f2b0b146c0511f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f9d7f35d1fcbe0af\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewSession.js\":\"f5b49ab3d7508005\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/actions.js\":\"93380fb90dd45634\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/archive.js\":\"aa57ae86c9495455\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dataExtension.js\":\"05d1c606ff7ee90c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/deck.js\":\"18cdae1962f8ddae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dueQuery.js\":\"69407758512a2efa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/gradeDecision.js\":\"407e1d4a1ab2cdd4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/index.js\":\"12a30483b52a8493\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/keyHints.js\":\"292b62ab4ea75f24\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewCardLayout.js\":\"d4300bc5181b9c43\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewProgress.js\":\"e2b87ac3b1a70b12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/schema.js\":\"0779319daa232111\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/useDueCards.js\":\"9616e3893266f04a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/index.js\":\"6bf813604cb06c99\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/record.js\":\"56a4f53dcf5afc33\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/index.js\":\"87d407c9b288b42a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/persistenceStatus.js\":\"7bdb4569e2c3f888\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/requestAction.js\":\"d5698cee95ac61d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/TypeChipsDecorator.js\":\"519142184b2e07bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/codeMirrorExtensions.js\":\"625c10217b9fdf5a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/index.js\":\"3d523b7358d68d4c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/typeAutocomplete.js\":\"78063aef1704f872\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0e24217445444886\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/actions.js\":\"0f74a98321e8e0a4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/anchor.js\":\"0d5f2fad246911f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/events.js\":\"06a02db9958f6a10\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/gestureActions.js\":\"0635110dd02b3ed8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/index.js\":\"edfa70de726515c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d0296ee7192d852b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/collect.js\":\"d322ba387635e58e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/index.js\":\"255c87d55d604f9c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/record.js\":\"62a8c22273ba2a72\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/RejectionDialog.js\":\"a5fe58f87bd59342\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ed079d04568af306\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/index.js\":\"f8ec427238a59359\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/model.js\":\"7849abd8f58fca60\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/queueCounts.js\":\"b2c6bc0cb0a1da9b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rejectedHelpers.js\":\"3d8487d556a1c5c4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rematerializeAction.js\":\"33bd3f9b4ae9cf01\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/useHysteresis.js\":\"f5d85fee9f4c1934\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/ColumnHeaders.js\":\"cecdf370412221ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/QueryUi.js\":\"f4c1f27dad57544a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/TableLayout.js\":\"84b0bd3161177d82\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/actions.js\":\"56d2d594c9293ba6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/cellEdits.js\":\"cfa8ae32abcb40ec\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/columns.js\":\"6553b6c73e39710c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/controller.js\":\"66579a1ae96c4ba2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/convert.js\":\"29d136f28ed85ead\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/dataExtension.js\":\"524901937064a7f5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/index.js\":\"dd87714fbe88fda6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/keys.js\":\"3db024bbb3773da2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/model.js\":\"e7f685441fe6403a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/navigation.js\":\"8c432c0677a65b18\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/backfill.js\":\"8848d5e0995a4a07\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/completion.js\":\"f1a868dcddd7a36d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/format.js\":\"48b161223923f447\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/parse.js\":\"4f2bee046badbc83\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/queryValue.js\":\"dd0c3cdbde1647e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/source.js\":\"a64ddb3c31ab5b07\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/registry.js\":\"768429f62ee1e810\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowGutter.js\":\"40e897f7f10eb47b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowVerbs.js\":\"215722156958c610\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/schema.js\":\"9cbe3b10822e8b17\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/sort.js\":\"967919120f21de44\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/effect.js\":\"5810181702ba9a3c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/index.js\":\"a3e2cb5baca799d5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/theme.js\":\"25128f14d3dfa83c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/actions.js\":\"9b13193998e3a7a7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/dataExtension.js\":\"ebd42674687fa86d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/index.js\":\"0185de94f94bbb14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/schema.js\":\"81a6718f7e26d12c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0c3b4cc35e60cce5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/actions.js\":\"20a346dc0bf662fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/defaultItems.js\":\"3ea1f055f4c1d44c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/facet.js\":\"e615f4fcdb782143\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/holdRecognizer.js\":\"63b7b9245b86f588\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/index.js\":\"d996a4ab9255310c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/UpdateIndicator.js\":\"35294bc46ea09bc1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/index.js\":\"a9ff69fe070eccc2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/loadTimes.js\":\"a6e4c93f31d030de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoNotesRenderer.js\":\"6c7ed839b6d56d82\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoPlayerRenderer.js\":\"80517f43aaa82295\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoTimeStamp.js\":\"97cdea77dbd22e81\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/actions.js\":\"8f827c3d17a5d1c8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/index.js\":\"456c114bee22e1ab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/markdown.js\":\"f6c2ecb8c08b7633\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/notes.js\":\"aa29754602d617d7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/registry.js\":\"a6254bd4e79e6d91\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/remark-timestamps.js\":\"012565c41ddcf531\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/view.js\":\"2db0e2a32fe0b556\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/LinkHints.js\":\"12ec946bf94a91dc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/index.js\":\"4ab8b7e33a4250f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/model.js\":\"c15678699bb7211b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/settings.js\":\"019ea5141be43951\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/actions.js\":\"822ee3e6cbafe55e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/index.js\":\"508f0a8ea044874a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/interactions.js\":\"6d856f1d2b05244e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/workspace-header/index.js\":\"b8043370c64fe196\",\"/knowledge-medium/pr-preview/pr-1855/src/registerServiceWorker.js\":\"e9c1764a35701f8f\",\"/knowledge-medium/pr-preview/pr-1855/src/requestPersistentStorage.js\":\"836920c4b7deef1e\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authRequestDeadline.js\":\"b81cceb1d925c9d4\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authStorage.js\":\"adf43f0fa94939c8\",\"/knowledge-medium/pr-preview/pr-1855/src/services/powersync.js\":\"5022cbca1648d89d\",\"/knowledge-medium/pr-preview/pr-1855/src/services/supabase.js\":\"53cc05fdfecda118\",\"/knowledge-medium/pr-preview/pr-1855/src/services/uploadErrorClassifier.js\":\"2df889077ee76ab4\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/ActiveContexts.js\":\"55e3f4e65ccba2d3\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/HotkeyReconciler.js\":\"391f22ffadf33315\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/WipeLocalDataDialog.js\":\"54c01236c1894320\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionDispatch.js\":\"1dbb0b0ea5b683de\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionRefItems.js\":\"1ae881d88ee5e68b\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/applyKeybindingOverrides.js\":\"cb77a99ae3849f91\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockActions.js\":\"fda8c9ea12c249f6\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockMergeGesture.js\":\"f3f5f4e88eaa1576\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/canonicalizeChord.js\":\"b69b3e19674c273e\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultContexts.js\":\"a0ee849b97340222\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultShortcuts.js\":\"32db1e6ca2558028\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/effectiveActions.js\":\"00cd7e3d78f839b9\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureAction.js\":\"2f725c13edf7b8cd\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureBinding.js\":\"52dc1e6058cd8ed7\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/holdRegistry.js\":\"01bbd8f1c9689ad3\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingConflicts.js\":\"be0fafb99a0c42ff\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingOverrides.js\":\"0662e2c831752f13\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/pointerAction.js\":\"4e704596cea57ab4\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/resolve.js\":\"556ca71967f89ab5\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/runAction.js\":\"5a4dece1ed6f89f2\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/sequenceMatcher.js\":\"7c7a2610d85e24f3\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/types.js\":\"849fce2bcaa68ea7\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionContext.js\":\"b0d975a10e58fe0d\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionDiscovery.js\":\"e423f581f796a18b\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/utils.js\":\"36d974673ff14143\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/bootStore.js\":\"29f98d465442da0b\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/previewDatabases.js\":\"469c03b4f37c88e5\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/byteTransform.js\":\"acce8ef3bc06fdf3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/attachmentCleaner.js\":\"a4cfcbdc5ea8a861\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/attachmentParts.js\":\"dc0dde16bcedd714\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleParts.js\":\"7f23de7dc14a3183\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleRecord.js\":\"90e7d986ca019d9c\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/manifest.js\":\"599bd9181d06a490\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/takeBundle.js\":\"9fb498dfa0ad65e0\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/verifyBundle.js\":\"f16dc0f328e0fd25\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/cleaningStage.js\":\"52108c0c4b85a013\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionKey.js\":\"6b9ecd9a1a5686a3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionServer.js\":\"911bdbafeb5419da\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flip.js\":\"d06f294f18c62549\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flipAttempts.js\":\"dacfe572791850e3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/pages.js\":\"734b6f88eb905f08\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/preflight.js\":\"ca34002223c97f91\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/reseal.js\":\"932b062e8149c972\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runConversion.js\":\"14908085f1cfe3d7\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runLock.js\":\"335e3ee5b1442915\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealing.js\":\"85fbeb7d305f0066\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealingStage.js\":\"60bee76c6fb58b88\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/stage.js\":\"f1b0f77d3218a7f8\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/verifyReseal.js\":\"23b4bc4ff6228441\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aad.js\":\"1e83129779fcc439\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aead.js\":\"b577adc793bcec21\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base32.js\":\"743ddea26ec34a97\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base64url.js\":\"675bacab070603ed\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/binaryEnvelope.js\":\"58798936d821f7e8\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/byteAead.js\":\"54e9978de4247d53\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/canary.js\":\"05cb91b7aab6f4f9\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentHash.js\":\"fb1bca9dcd4faba5\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentKey.js\":\"4f5b9e86255b3905\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/derivedIdNamespace.js\":\"bbee3c95c5bfc72d\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/envelope.js\":\"8610708c62a20dcc\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/hex.js\":\"65a5d31502b4f9aa\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/sha256Hex.js\":\"44a0a3ebb9b26841\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/workspaceKey.js\":\"dfd94c086084b035\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/conversionState.js\":\"b5732caf9a1fb626\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ada534f9c530d834\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/pastedKey.js\":\"3d55b080a2d3d67d\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d50ceb3cf71ee360\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3a9a5f204fa2cb95\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/keyStore.js\":\"66bd44ac6ef65dd6\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/mintWorkspaceKey.js\":\"584a90f7111e12fd\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/modePin.js\":\"4ecec2b4b7fab96f\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/openWorkspaceKeys.js\":\"84f2f3296bf72711\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolveWorkspaceEntry.js\":\"c19ec2caff75cb4d\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolver.js\":\"1b87b523fa708372\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/workspaceAccess.js\":\"030feddbde1fd4eb\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/transform.js\":\"25129e7f3fe8e5d7\",\"/knowledge-medium/pr-preview/pr-1855/src/themeBootDefaults.js\":\"cc3f817919794030\",\"/knowledge-medium/pr-preview/pr-1855/src/types.js\":\"924c51da76fbe2d7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/ClientLocalSettings.js\":\"106576bae1183e07\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/abortableSleep.js\":\"733b070ab9bb78c3\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/array.js\":\"c6e65faf3352ad45\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/backlinkAutocomplete.js\":\"81b2037c54037fa7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockCrumbs.js\":\"77ed80c969b8845f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockrefAutocomplete.js\":\"1f46140e86bc127e\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/cadencedIdleJob.js\":\"7e414b2f795cb602\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/callbackSet.js\":\"46d33a74e0728f22\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/clientId.js\":\"1089567bc5a5e9ae\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirror.js\":\"7eed146475d767e4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirrorCompletion.js\":\"ad93babfeac9ea2b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/copy.js\":\"36be28f388660905\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dailyPage.js\":\"be22a8892d27f1db\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensics.js\":\"7eea1f35aa9ca592\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensicsHooks.js\":\"06f5b248f583b934\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/deleteBlockThroughUi.js\":\"954861749636b4fc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dialogs.js\":\"54da81cdf1e3a2d6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dom.js\":\"77def436d933ebcd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/downloadBlob.js\":\"10f1008337d08857\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/exportSqliteDb.js\":\"c3bdbe9ff9d914dc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fileSystemAccess.js\":\"096096ea2cc98153\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/flipSlide.js\":\"5d6695481dbdd266\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fnv1a.js\":\"2890e99e617b0c6a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/formatBytes.js\":\"22a6c1e909d2c093\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fuzzyRank.js\":\"14af7324954d72b0\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idbKeyedStore.js\":\"56ab114c0191f514\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idleCallbackPolyfill.js\":\"ca3b270f4f0d1e9d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardAwareScroll.js\":\"707f9e43252767dd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardViewport.js\":\"fd825fc5b383cd05\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/lastWorkspace.js\":\"18ad714aa9a43c65\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutColumns.js\":\"5173913c5a58233c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionDom.js\":\"8502a691c25ccae2\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionId.js\":\"ab1a8404c68eca3c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkClickGestures.js\":\"8c786ab4b4c89ce5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkTargetAutocomplete.js\":\"661a46b83b521189\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbCorruption.js\":\"04f49047b1010ff5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbRecovery.js\":\"dfbe07eaf577f1a6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/markdownParser.js\":\"776b6172f939ce3d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/memoize.js\":\"207c98e02e559b15\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameFieldCommit.js\":\"7c97461050000af0\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameList.js\":\"dc36987af68f3c3f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/navigation.js\":\"51101a25db86097a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/omnilinerNamespace.js\":\"5fae598c528b0590\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/opfsPageScan.js\":\"ec60210d0377fdcc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelClearance.js\":\"5acfc597f0d41bab\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelHistory.js\":\"99a781d814f78013\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLanes.js\":\"5a38962ab8f01dc5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLayoutProjection.js\":\"fc4ab55b6daad410\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelScrollAnchor.js\":\"da43a96929abd5b1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelUrlFlags.js\":\"1daf34a8ee731245\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/platform.js\":\"9b829d72a654caa0\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/pluralize.js\":\"bc66f0387be47b1c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyCreation.js\":\"812e78f3ee1236ae\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyNavigation.js\":\"5a8b187745a754e5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyValueContext.js\":\"80897f7967cacd32\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/react.js\":\"8f0dcbab5be5511c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeDate.js\":\"cfd1c24657e5cc18\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeTime.js\":\"730adb1ce745ae93\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/renderScope.js\":\"22386b42a34907cd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/resolvedThenable.js\":\"88ce17468031a28f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/routing.js\":\"5c0c91df9f8e8e4f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/safeMode.js\":\"ba49a4d09bb9f3cb\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/scheduleIdle.js\":\"b5519ea4c3d416ca\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/screenWakeLock.js\":\"4b0a4655c82d2068\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/selection.js\":\"72566e3f9e0c3bc1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/softKeyboardGrab.js\":\"47f192d48d7e5fb9\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/startupTimeline.js\":\"f5371c6b074e7fb2\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/state.js\":\"6a67cacc4ab94d20\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/string.js\":\"12bcfdd600e9169f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/surfaceZoom.js\":\"9bd7b98d502ae00f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/time.js\":\"ffe94223a1b28c96\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toast.js\":\"363ad6700da47111\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toggleStore.js\":\"11b1cf78f64ce019\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/untilStopped.js\":\"153547c38c1370cc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/userActivity.js\":\"15367c592e7c7d2f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewTransition.js\":\"0af4634ba986f6cc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewport.js\":\"eac5814117f19db2\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/webLock.js\":\"9419cc36df558c16\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceRecovery.js\":\"38dabbbfeafab25b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceSnapshotStore.js\":\"05f7d06bf1558f99\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-compiler-runtime.js\":\"ecd5fbe9820dcc42\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-client.js\":\"443cad4086ec6f70\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server-edge.js\":\"1c1c3c9a2ee4d810\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server.js\":\"3e70eb7fee30f2e0\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static-edge.js\":\"506d3d1197440834\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static.js\":\"4af57ff961870aaf\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-test-utils.js\":\"68dc35859197d1c0\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom.js\":\"d244abe332ea73a8\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-runtime.js\":\"7b31376d9c10be66\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react.js\":\"121c4723a844a6ef\",\"/knowledge-medium/pr-preview/pr-1855/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
