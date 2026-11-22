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
		buildId: "b72424339dce-cb41b241",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/\":\"5ae256d77edc622e\",\"/knowledge-medium/pr-preview/pr-1855/index.html\":\"5ae256d77edc622e\",\"/knowledge-medium/pr-preview/pr-1855/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1855/assets/FacadeVFS-Bu1YjWDF.js\":\"8e1444f7af15783b\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSCoopSyncVFS-CSA8m7cM.js\":\"e45ae75fa125d0d2\",\"/knowledge-medium/pr-preview/pr-1855/assets/OPFSWriteAheadVFS-Btf_B063.js\":\"dbba5f9bce1c5087\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-B0ISJw71.js\":\"5ebcc8a2224eef71\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/assets/wa-sqlite-async-BMCXHq2c.js\":\"13e9dfd16ef80877\",\"/knowledge-medium/pr-preview/pr-1855/assets/worker-CqYrfOYn.js\":\"3960d3628264e5e6\",\"/knowledge-medium/pr-preview/pr-1855/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1855/chunks/app-CClycd_4.js\":\"6ef3e1415233b6ad\",\"/knowledge-medium/pr-preview/pr-1855/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1855/index.js\":\"e9e1f6cf50db6dd4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1855/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1855/assets/AccessHandlePoolVFS-Cin_mKV7.js\":\"70c864b059872b65\",\"/knowledge-medium/pr-preview/pr-1855/assets/IDBBatchAtomicVFS-BHUIinYu.js\":\"dfefd7d4bb5c010b\",\"/knowledge-medium/pr-preview/pr-1855/assets/MemoryVFS-Bn5_JK03.js\":\"13d8c8c64204af9b\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-C9-B-XoZ.js\":\"55d6363f64e5a535\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-CprHVz1C.js\":\"5508f5e11e7ec0ef\",\"/knowledge-medium/pr-preview/pr-1855/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1855/chunks/AccessHandlePoolVFS-BsX8fJat.js\":\"4430b3bcedc857c2\",\"/knowledge-medium/pr-preview/pr-1855/chunks/FacadeVFS-leo5JapW.js\":\"26fe4f1dcace5635\",\"/knowledge-medium/pr-preview/pr-1855/chunks/IDBBatchAtomicVFS-CIf7eKfx.js\":\"bac3920345c5d35d\",\"/knowledge-medium/pr-preview/pr-1855/chunks/MemoryVFS-CF4smU1C.js\":\"72a4ca468c07410e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSCoopSyncVFS-B-WjLk0C.js\":\"8ae81801781774b5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/OPFSWriteAheadVFS-wfMEbe8U.js\":\"8c64476959ad4075\",\"/knowledge-medium/pr-preview/pr-1855/chunks/Preview-tPvRA52w.js\":\"b282a56682012969\",\"/knowledge-medium/pr-preview/pr-1855/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/card-FhnEyIU9.js\":\"b53e5f94b1d80959\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1855/chunks/dist-CoO9LVYy.js\":\"1f5d58375d5d35f6\",\"/knowledge-medium/pr-preview/pr-1855/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-CJU1VvMQ.js\":\"4dea43806e4ca59b\",\"/knowledge-medium/pr-preview/pr-1855/chunks/mc-wa-sqlite-async-CVK4BPfn.js\":\"a833d89b81e39d72\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-BWZHIAWb.js\":\"0110a064347d38f7\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CJQktjf6.js\":\"0559efcef5905f3d\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CPKfPSyd.js\":\"eb87bad19de19ace\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CQZx6PXO.js\":\"44f2483a658b16a9\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CRX8ydNv.js\":\"2c3e8d854ceee7d5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-CuogNP2P.js\":\"f79c1f2b828ec326\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DBksDk86.js\":\"c78435b665c16dab\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-DQiYiIHn.js\":\"8030af5894b2e1cf\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server-legacy.browser.production-CPoFU3n0.js\":\"bb256a55d327dd95\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.browser.production-Dcyzd9Op.js\":\"f0e801fdceb2359d\",\"/knowledge-medium/pr-preview/pr-1855/chunks/react-dom-server.edge.production-CgTpt8_-.js\":\"d54d98c691c03923\",\"/knowledge-medium/pr-preview/pr-1855/chunks/server.browser-CWkz1-ES.js\":\"67719b3d30825d5c\",\"/knowledge-medium/pr-preview/pr-1855/chunks/textarea-DFKgsY3w.js\":\"3a737c044482af14\",\"/knowledge-medium/pr-preview/pr-1855/chunks/ui-CSPJzfok.js\":\"a7cbd58074b926d4\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-DPxMUF07.js\":\"3104a1c87d9a5202\",\"/knowledge-medium/pr-preview/pr-1855/chunks/wa-sqlite-async-DHDdnHGh.js\":\"65aa5a1bea4082b5\",\"/knowledge-medium/pr-preview/pr-1855/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1855/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1855/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1855/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1855/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1855/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1855/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1855/src/App.js\":\"f7863a00fad92a8b\",\"/knowledge-medium/pr-preview/pr-1855/src/appUpdate.js\":\"6d94ae5456f28464\",\"/knowledge-medium/pr-preview/pr-1855/src/appVersion.js\":\"5254d43d0e2657dd\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/initialLayout.js\":\"fb05cb58d8e6d8fe\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/openWorkspaceData.js\":\"99e4ac6c9c64a46b\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/resolveWorkspace.js\":\"215ea069ceba69b8\",\"/knowledge-medium/pr-preview/pr-1855/src/bootstrap/workspaceBootstrap.js\":\"62b34c06f095fa18\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockComponent.js\":\"c9471c7026d2cd19\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockCrumbs.js\":\"8cdd242706663e58\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockEditor.js\":\"8fff122382595618\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockLoadingPlaceholder.js\":\"f04d89dc19dc9beb\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockProperties.js\":\"4c69f06001d7cf41\",\"/knowledge-medium/pr-preview/pr-1855/src/components/BlockSearchPicker.js\":\"53084c24262aea3e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ConfirmBulkDeleteDialog.js\":\"f030b7c7d1071a45\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DividerHandle.js\":\"0e0730c733b891d5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/DraftEditor.js\":\"dbcc2f822788b4e1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/GutterPill.js\":\"e16a40d1d6963679\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Header.js\":\"213cb2a131162571\",\"/knowledge-medium/pr-preview/pr-1855/src/components/LazyBlockComponent.js\":\"85820904114556ff\",\"/knowledge-medium/pr-preview/pr-1855/src/components/Login.js\":\"1452e626700f8439\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ZoomableSurface.js\":\"186fb7141fa5f1ed\",\"/knowledge-medium/pr-preview/pr-1855/src/components/editModeKeepalive.js\":\"3cfdff0641c15ba1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyDisplay/PropertyDisplayScope.js\":\"45b540481cecf7d5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a480de19bd9bc72c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefPropertyEditor.js\":\"4dbbdaffe8eb7a39\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/RefTargetTypePicker.js\":\"b8cbe29dc6a4d7c9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/SelectPropertyEditor.js\":\"96c56e8b95fe3aa5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/TypesPropertyEditor.js\":\"f673c91a318cf759\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/defaults.js\":\"63ab4427b805b035\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/kernelValuePresets.js\":\"15b1c31064e8fbcd\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/selectablePresets.js\":\"c62b4d26d4d9e7e0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyEditors/typesPropertyUi.js\":\"443dc9f6f43e23f0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/AddPropertyForm.js\":\"cc4073f0703ea576\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyPicker.js\":\"568e73d7928369d4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/PropertyRow.js\":\"31d4014025108078\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/Rows.js\":\"2853ff6e93944f9d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/actions.js\":\"99898b158c5fc30b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/declarationOnly.js\":\"6f1bef9a4a7f0eec\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/layout.js\":\"a3794dae09c24a1e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/model.js\":\"173fc8e08cb3e7ce\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapeUi.js\":\"d82c08213912619c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/shapes.js\":\"e801b73b59167860\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7672f2a1118363ee\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanel/visibility.js\":\"38a16fbf0cf960b5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/propertyPanelSections.js\":\"45a3c3dafd8acf5e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockEmbed.js\":\"034a00f5344ae1ba\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockLink.js\":\"eb74846d65a3e97a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/BlockRef.js\":\"1c016d03a0a50840\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/ReferenceLink.js\":\"a102f83e47d589f1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuard.js\":\"b75576a3d5d9cc60\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/cycleGuardContext.js\":\"e5d8f2f512a1b961\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/linkInteraction.js\":\"7571587df4766b74\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/referenceLayout.js\":\"4cba5bb0b9b8c388\",\"/knowledge-medium/pr-preview/pr-1855/src/components/references/useBlockRefAncestors.js\":\"4248e2019d938370\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockGutter.js\":\"4a9828c0de46c91b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockInfoDialog.js\":\"ef2887a7c2037858\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BlockTypeBlockRenderer.js\":\"4696a926577690c5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/BulletHoverCard.js\":\"6d133bcd5ed43889\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorContentRenderer.js\":\"54d55fca88e3e626\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e0313b7fd31059f0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ColumnResizeHandles.js\":\"f60b2f5e389b19a3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c05029bc15151e8e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/DefaultBlockRenderer.js\":\"864ffbdbf4b2844e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/LayoutRenderer.js\":\"7a862963e7ff8cb3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MarkdownContentRenderer.js\":\"e06437ee303c7236\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/MissingDataRenderer.js\":\"68e3202ec131f66a\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PanelRenderer.js\":\"40899fcc796bf154\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/PropertySchemaBlockRenderer.js\":\"269e511f4d4009cc\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/TopLevelRenderer.js\":\"6748b6bfc2b50cf8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockGutterMode.js\":\"404d6cfba6001d5d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/blockTitleText.js\":\"904d224137f47819\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/fieldCreationKeydown.js\":\"6d7ce8c9bb33d032\",\"/knowledge-medium/pr-preview/pr-1855/src/components/renderer/layoutRootContext.js\":\"a09a981407182aa3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/TypeChip.js\":\"6339660252ab4e4b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/typeChip/chipStyle.js\":\"071dc3e02bb762d1\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/anchored-floating.js\":\"ec7a18f9de6a6582\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/button.js\":\"8f2e090d520b7b65\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/card.js\":\"e294fccb12428311\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/checkbox.js\":\"f558f35d3b70da8d\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/collapsible.js\":\"b38fcbd6600af1db\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/command.js\":\"6c2a844dfc9ac552\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/context-menu.js\":\"c96e68af7bbd1c96\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dialog.js\":\"7ddbced0379d2dd3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/dropdown-menu.js\":\"b430526c81e3c65c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/floating-listbox.js\":\"7cf93b50f8c17d5e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/index.js\":\"54e716daa3168f42\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/input.js\":\"ba5a6fca79ce11a4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/kbd.js\":\"2182622aa6b1f6b0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/label.js\":\"47285e99bf8690eb\",\"/knowledge-medium/pr-preview/pr-1855/src/components/ui/textarea.js\":\"c8f9e1403c5896a4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/useEditModeYieldKeepalive.js\":\"698d343f7db25579\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/BootFallback.js\":\"6353dd08526ff51b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/FocusedRowLazyMount.js\":\"919af6c9a28a1bf5\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LazyViewportMount.js\":\"848e3286be356938\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/LocalDbCorruptionFallback.js\":\"bf87a27462134b8b\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/error.js\":\"68795c185a146d83\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/lazyMountRegistry.js\":\"a8b6586d2a8063c7\",\"/knowledge-medium/pr-preview/pr-1855/src/components/util/suspense.js\":\"567a7502b3bae554\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/CreateWorkspaceDialog.js\":\"47c5abab6dbecadd\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/PendingInvitations.js\":\"6d04102bcad6f77c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/SyncProgress.js\":\"ecf5cfbb308732d0\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/UnlockProgress.js\":\"94dbc133ec0e6636\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceKeyGate.js\":\"24e9ddb70c344e74\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSettingsDialog.js\":\"744eb9cdb046e8f8\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSwitcher.js\":\"d542ef65ef6410cf\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/WorkspaceSyncGate.js\":\"53004e44b68ceb10\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlow.js\":\"a60363a762ee128c\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/ConversionFlowHost.js\":\"1898201b1b3cef3e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/EncryptionSection.js\":\"0e533ad4a5c4fd0f\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/attachmentPrompts.js\":\"29f3a7cf342b7cb3\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5d6453fa3b851a42\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowDeps.js\":\"571b0f446cb85ae4\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/conversionFlowStore.js\":\"5b2d25b1cb9b5f6e\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/flowUi.js\":\"0ed5a8268db897b9\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/conversion/useConversionRun.js\":\"0f27d5e0718fa254\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/keyUi.js\":\"eb16f39a72b89b43\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnKeyLoss.js\":\"13d58ea43a95f005\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/useCloseOnServerE2ee.js\":\"40c9b465e551e683\",\"/knowledge-medium/pr-preview/pr-1855/src/components/workspace/workspaceUnlocked.js\":\"cc39f0f39d7f4a86\",\"/knowledge-medium/pr-preview/pr-1855/src/context/backgroundSubtree.js\":\"1b334880ddf66721\",\"/knowledge-medium/pr-preview/pr-1855/src/context/block.js\":\"57f90b49320ec1f8\",\"/knowledge-medium/pr-preview/pr-1855/src/context/layoutWsContext.js\":\"93beccf48b4e8637\",\"/knowledge-medium/pr-preview/pr-1855/src/context/propertyDisplay.js\":\"15c7330a2f7ab97f\",\"/knowledge-medium/pr-preview/pr-1855/src/context/repo.js\":\"a306cd369889385b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasClaim.js\":\"2cdd6c53dd957f15\",\"/knowledge-medium/pr-preview/pr-1855/src/data/aliasSeatNamespace.js\":\"93dba424bac0c6c9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockData.js\":\"3c941c300ee9d547\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/blockType.js\":\"79bb4fbaa9219a64\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/changeScope.js\":\"5efa39909ac31328\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/codecs.js\":\"f8725a127f392162\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/derivedData.js\":\"3e67b1d97406c029\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/errors.js\":\"e6584b091b9f624d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/events.js\":\"850d8c38fc26b58c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/handle.js\":\"fcdae692a52081fe\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/index.js\":\"5760b7349dcee901\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/mutator.js\":\"4b1eaba99e68e59b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/processor.js\":\"a7fc1dd0776d60f7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/propertySchema.js\":\"8a501e159128a6d0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/query.js\":\"277603bc5c835c34\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/sameTxProcessor.js\":\"c7843c2f77477e37\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/schema.js\":\"fcdae692a52081fe\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/tx.js\":\"fcdae692a52081fe\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/typedBlockQuery.js\":\"d1de12169c770df6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/user.js\":\"a6264a1245c727e4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresetCore.js\":\"812f4be9f80db242\",\"/knowledge-medium/pr-preview/pr-1855/src/data/api/valuePresets.js\":\"101d0d2c1e9d4044\",\"/knowledge-medium/pr-preview/pr-1855/src/data/attachmentCleanerIOVerb.js\":\"06b6e1fbbf5a487b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/block.js\":\"040b8df78e9124b1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockCache.js\":\"a173719554c770d2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockId.js\":\"0113a24b908ea736\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockLiveness.js\":\"e7fb2c9149fa4124\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockMerge.js\":\"6fbedbc7a11d14b9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockSchema.js\":\"7136cc1c1f1998cf\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypeLookup.js\":\"36f225b2f9191db1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/blockTypes.js\":\"0a46a848dee80bdd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/childrenView.js\":\"b00a9bfcb25e4684\",\"/knowledge-medium/pr-preview/pr-1855/src/data/clientContext.js\":\"4acc46537002ff49\",\"/knowledge-medium/pr-preview/pr-1855/src/data/dbFileSiblings.js\":\"912ee81ba55a287b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/definitionSeeds.js\":\"880beb029e42a69e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/derivedIds.js\":\"cf895ba5c59562e3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/drawnSubtree.js\":\"0d12e11db32b50c6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facetBridge.js\":\"e508eef288f69a75\",\"/knowledge-medium/pr-preview/pr-1855/src/data/facets.js\":\"a6a8f12066effefd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/globalState.js\":\"e84edc435f26d42a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/aliasClaimRederiveProcessor.js\":\"164640905a739bc0\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/ancestorBatch.js\":\"0ad2a3c3b45e9cdd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/blockTypeTypeifyProcessor.js\":\"9604a3d1b3369824\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/clientSchema.js\":\"aff1295b401f61ac\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/commitPipeline.js\":\"0373e6d27a26f154\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/devAssertions.js\":\"365dc11e7785a36c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/firstSync.js\":\"279b29383986d74b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/freshInitialLoad.js\":\"822323813db74e98\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/graphBackfillClaim.js\":\"eeec17162b8192fe\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/handleStore.js\":\"47c202b952812fa6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/idleMarkerJobs.js\":\"8fd8bdbd3383cd82\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initialDownload.js\":\"31a358e0eca94925\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/initializeClientDatabase.js\":\"c736256e68c665c2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/jsonCanonical.js\":\"f503485484cabddc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelInvalidation.js\":\"e4cbd40def693db7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelProcessors.js\":\"e0a73b2e4fbbe636\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/kernelQueries.js\":\"403ea0fcc538f098\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/mergeTypeMembershipProcessor.js\":\"500018e3bb888396\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/normalizeReferencesProcessor.js\":\"0babebd933641e9c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/poolInstrumentation.js\":\"33deb6489ad62d32\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/processorRunner.js\":\"d9d887e8dea3469f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyCellBackfill.js\":\"aaf1bf0b8fec99db\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildMint.js\":\"5a8d2c2a40a7ff92\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyChildrenProcessor.js\":\"2dfc82f3aa3defe8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a221473ed36bd802\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyDefinitionSynthesis.js\":\"ebeac1ea6c8410ff\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyKeyScan.js\":\"bece9fae2f939028\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertySchemaResolution.js\":\"62a90b125bc2bd29\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/propertyValueEdits.js\":\"47978d4bd797a1d4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/raiseProtocol.js\":\"b71f683a48699a70\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/readBatch.js\":\"cbf7befdab5a7264\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/refProjection.js\":\"22b2cf1c85039b45\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetLookups.js\":\"8a1ce3dfd90e30ef\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/referenceTargetProcessor.js\":\"e68b2e097513f00c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/replayMerge.js\":\"264fd1181daabfcd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/sqlBinds.js\":\"ed2dd709777b3ec2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"40d3209fc8821a6a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/arrivalProcessors.js\":\"08ba859a42fbfecc\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/invalidate.js\":\"2adc2ca647df54e3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/materialize.js\":\"bf68a3c016a487c3\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/observer.js\":\"71bbd3f490120a4d\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/syncObserver/reconcile.js\":\"ea5c6c4a5f77009e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/timingMetrics.js\":\"1ae42a8b4ad34f12\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/treeQueries.js\":\"7e59effc741c23e2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txEngine.js\":\"05ffa5694563f07a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/txSnapshots.js\":\"9369644094ac13dd\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/typedBlockQuery.js\":\"7e682b86e5a82492\",\"/knowledge-medium/pr-preview/pr-1855/src/data/internals/undoManager.js\":\"c1700dde321c7afb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/invalidation.js\":\"af8ba8f60dbfcff1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelDataExtension.js\":\"2444fa1d26579b75\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelPage.js\":\"dab10e26d36b81c8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/kernelValuePresetCores.js\":\"f673f5f672b484f7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbCorruptionSignal.js\":\"ba49fc71b6685b11\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbStorage.js\":\"c273f36c885ee705\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localDbVfs.js\":\"be7b48124d82a477\",\"/knowledge-medium/pr-preview/pr-1855/src/data/localSchema.js\":\"0a0fc69a601c0a3c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/maintenance.js\":\"7178f5ae63e492ab\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mergeProperties.js\":\"2fcd18cacae3b9b9\",\"/knowledge-medium/pr-preview/pr-1855/src/data/metricsConsoleHook.js\":\"87e26f4b28cbbd71\",\"/knowledge-medium/pr-preview/pr-1855/src/data/migrationsPage.js\":\"758c76ea4fe51e02\",\"/knowledge-medium/pr-preview/pr-1855/src/data/mutators.js\":\"9b68c158cb1665ba\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKey.js\":\"423802e315b00545\",\"/knowledge-medium/pr-preview/pr-1855/src/data/orderKeyPlacement.js\":\"a0dfe8423d0cb071\",\"/knowledge-medium/pr-preview/pr-1855/src/data/outlineSurface.js\":\"8820b1c65ecf1f26\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingEditorContent.js\":\"6c72a961a7502618\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pendingUploadsSql.js\":\"af88058de037102a\",\"/knowledge-medium/pr-preview/pr-1855/src/data/pluginStateExtensions.js\":\"5f55a6c7a41af10e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/powerSyncLogger.js\":\"097d99eae5238e24\",\"/knowledge-medium/pr-preview/pr-1855/src/data/projectorRuntime.js\":\"11fde8c7019d1f56\",\"/knowledge-medium/pr-preview/pr-1855/src/data/properties.js\":\"6b872daa9ae083f4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertiesPage.js\":\"886ef7da8675896e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyChildren.js\":\"e852e94675058058\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionFanout.js\":\"6dca700296cb44d5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionMetadata.js\":\"86db03ef3107ab24\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDefinitionRegistry.js\":\"6e24afc8a68df669\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyDisplayMode.js\":\"001f1f18bc390120\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertyRowCreation.js\":\"f82febdf667e8897\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySchemaCreation.js\":\"e17355c7b989acae\",\"/knowledge-medium/pr-preview/pr-1855/src/data/propertySeeds.js\":\"370fae15a3ff11c2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/recentsPage.js\":\"64deabe118c0cdff\",\"/knowledge-medium/pr-preview/pr-1855/src/data/referenceBlock.js\":\"15dd850e993cc66e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rejectedUploads.js\":\"333c4a5d5a53aed8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/releasePowerSyncConnection.js\":\"15939c4ccc47cbb4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repo.js\":\"30cbec06de77c926\",\"/knowledge-medium/pr-preview/pr-1855/src/data/repoProvider.js\":\"b3ecec98eb2140ca\",\"/knowledge-medium/pr-preview/pr-1855/src/data/rowProperty.js\":\"9dfb2c74bd1b5e77\",\"/knowledge-medium/pr-preview/pr-1855/src/data/searchFilter.js\":\"50411ba60cc437e6\",\"/knowledge-medium/pr-preview/pr-1855/src/data/seedIdentityLedger.js\":\"a7f02113b7c60d2c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/stateBlocks.js\":\"24d53afe4e8acb7b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/structuralEditPolicy.js\":\"2ea6bdf5915697a1\",\"/knowledge-medium/pr-preview/pr-1855/src/data/subtreeDelete.js\":\"245d587b5c6cdffb\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncStreamLock.js\":\"dda88a46154f6e55\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableSqlRecognizer.js\":\"263ad203538ff12b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/syncedTableWriteGuard.js\":\"88e749a4f07a12a7\",\"/knowledge-medium/pr-preview/pr-1855/src/data/targets.js\":\"0f148e1ca279af6b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeColors.js\":\"64d4393c961bf8e8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionMetadata.js\":\"5e451209fa16b05f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeDefinitionRegistry.js\":\"b453e612672e74a2\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeExtraction.js\":\"e27a69ff57d4548f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeInitialValues.js\":\"dc4a1dfe962165f4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typePropertyGroups.js\":\"b5c91edb33691c8f\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeSeeds.js\":\"110ea1eabf77f9ba\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typeTagger.js\":\"2eefbc3566ac6b1c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typedRecords.js\":\"cd086e5453cd54da\",\"/knowledge-medium/pr-preview/pr-1855/src/data/typesPage.js\":\"d2f37b322f56a4d8\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userPrefs.js\":\"81d4457e5e4e4763\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userSchemasService.js\":\"5666f7b1a923be3b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/userTypesService.js\":\"a7949e197bd76be4\",\"/knowledge-medium/pr-preview/pr-1855/src/data/valuePresetRegistry.js\":\"5a6f72bbbb627636\",\"/knowledge-medium/pr-preview/pr-1855/src/data/visibleChildren.js\":\"a27fa50f787a8f39\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceConversion.js\":\"6b703fed875fee0b\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceFirstSync.js\":\"80515fda4d54ef7c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceIdNamespace.js\":\"af7f89f7ec7137b5\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaceSchema.js\":\"479b5f3b6ab6938e\",\"/knowledge-medium/pr-preview/pr-1855/src/data/workspaces.js\":\"6a7d1adb20fa700c\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadLog.js\":\"7321fd273b41d419\",\"/knowledge-medium/pr-preview/pr-1855/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/BlockPasteShellDecorator.js\":\"95eb6911f98c1f8d\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/atTrigger.js\":\"ad43becf1f396204\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/autocomplete.js\":\"323fd04e2bd6c10e\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/codeMirrorExtensions.js\":\"f030747a3a468674\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/contentFlush.js\":\"2c280334ea908e89\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/defaultInteractions.js\":\"8ab999a2a5f86a15\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/editSettleSignal.js\":\"0dfd28cca84b6ed7\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/insertImage.js\":\"599af58638d1bf4e\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceCompletionRange.js\":\"3de068acb392d9bc\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/referenceTargetTypes.js\":\"0faabe85ec8526ca\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/syntaxContext.js\":\"72f06ee5162384bd\",\"/knowledge-medium/pr-preview/pr-1855/src/editor/triggerMatch.js\":\"a42b885e63887895\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/AppRuntimeProvider.js\":\"339383d1d328ca06\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/BlockFocusShellDecorator.js\":\"52f0a41753a7732c\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/ExtensionRenderBoundary.js\":\"9365d4c0aad02296\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/PanelContentRecovery.js\":\"c3c842d64c34cb00\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/apiCatalog.js\":\"2dcb574d40f4a207\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/approveExtensionHere.js\":\"8431224c6afb2d71\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/armedCutAppMount.js\":\"ad738825ccf894e4\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/batchableKeyedStore.js\":\"2f799cf5abe7176e\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockInteraction.js\":\"211f354e46aafec8\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/blockSelectionAction.js\":\"be938da55495d291\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compileExtensionModule.js\":\"b4dd56c80dc8af20\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/compiledModuleCache.js\":\"b3868571bf650ba7\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/continuousGestures.js\":\"3446f69a00ff23c5\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/core.js\":\"a2a4ef5dd8ba79ea\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/defaultRenderers.js\":\"1cafa88ae254c521\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/definitionFanoutAppMount.js\":\"71fc7e5ddd9ecb99\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dialogAppMount.js\":\"c65d6f786d584d50\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensionSeeds.js\":\"8cd654db35bfff71\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/dynamicExtensions.js\":\"528261e253b41bb2\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/exampleExtensions.js\":\"e5aa343b71c22a7f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionApprovalStatus.js\":\"15120f84c302b56d\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrorToast.js\":\"ab301d5f893ca784\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLoadErrors.js\":\"3e17cee13dd6257b\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionLookup.js\":\"f27103e533fd1e55\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionToggles.js\":\"7d53ad4f7be8ef33\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/extensionUtilitiesCss.js\":\"1eac594146f4453f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/kernelPageDeletionGuard.js\":\"b27d2342c34803d4\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/liveRuntime.js\":\"1bf1ea3e68f86989\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/openExtensionsSettings.js\":\"7d8dc43c1f9c12cc\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/overridesCache.js\":\"f4983ff9bdc6a0b0\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/pluginIds.js\":\"3e4b7b7b4ab9ee7b\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/processorRejectionToast.js\":\"cb6d7c2fe08df5f7\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeActions.js\":\"173feac8e6089b8f\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/runtimeContext.js\":\"213f45e668488c86\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticAppExtensions.js\":\"dedb9b205ad424f1\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/staticDataExtensions.js\":\"40fb34f1b5e1e7ba\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/toastAppMount.js\":\"3bcc7739abb90a21\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useOverrides.js\":\"af01fa9cce064cb5\",\"/knowledge-medium/pr-preview/pr-1855/src/extensions/useShortcutSurfaceActivations.js\":\"af7a5ceec495c76e\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/discoverToggleTree.js\":\"0518e6c1e011ae32\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/facet.js\":\"f6bb1ef0b41df62a\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/resolveAppRuntime.js\":\"82a05501d4cee7b0\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/runtimeEvents.js\":\"152e9a0bd7695e7e\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/togglable.js\":\"9d39ad957803f9bb\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/variantFacet.js\":\"8f79b1a0cbb45904\",\"/knowledge-medium/pr-preview/pr-1855/src/facets/verbFacet.js\":\"6eabfb10c30571ba\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/block.js\":\"2ceb97ad193b9934\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/focusedChild.js\":\"d55abd608af4d11a\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/propertySchemas.js\":\"e9b7e50419337867\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/typeRegistry.js\":\"66bc21cf7c84a2f7\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAncestorCrumbs.js\":\"310b5f9a986d1069\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useAutocompleteListbox.js\":\"556734a2fe935eca\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedSearch.js\":\"40d0d43531e6368a\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useDebouncedValue.js\":\"b63c4dd21bf4e0dc\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsFocalRender.js\":\"8eeb36c9bee186da\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useIsReadOnly.js\":\"33e77fb8962ae1c7\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMaterializeBacklog.js\":\"e01d8dd8274a99d5\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useMinuteClock.js\":\"9ddd131a5df09216\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePanelLayoutProjection.js\":\"e5bd648b803b3373\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/usePendingInvitations.js\":\"4e2b7a2604e0eda5\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRendererRegistry.js\":\"e294bf38ead4dc17\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useRetainedFieldRows.js\":\"806c2840099d2e81\",\"/knowledge-medium/pr-preview/pr-1855/src/hooks/useWorkspaces.js\":\"5ed47b42561873b4\",\"/knowledge-medium/pr-preview/pr-1855/src/lib/utils.js\":\"48e76306714dda15\",\"/knowledge-medium/pr-preview/pr-1855/src/main.js\":\"c52359fe94496c89\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/MarkdownImage.js\":\"8d1c2cbf24d2e963\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/blockSeparators.js\":\"86edd2537f5f706a\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/context.js\":\"b89079f48bc7d735\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/defaultMarkdownExtension.js\":\"8558b1d457d7a64e\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/extensions.js\":\"cf5686aff0ea71c0\",\"/knowledge-medium/pr-preview/pr-1855/src/markdown/renderMarkdownHtml.js\":\"32e19de95ac93441\",\"/knowledge-medium/pr-preview/pr-1855/src/minimal-editor.js\":\"6999bd895a356b7d\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/armedCut.js\":\"07ea49047e9f3790\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/captureMediaVerb.js\":\"9a8750ce2d67dab3\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/clipboard.js\":\"73a40e17dd9d471e\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/decision.js\":\"b6475f9fc9f455c9\",\"/knowledge-medium/pr-preview/pr-1855/src/paste/operations.js\":\"efc7594e3b166d4f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/AccountHeaderItem.js\":\"7a146fe312fce433\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/account-header/index.js\":\"8f06308d64d5d74b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d72b43b61bc5400a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askAgent.js\":\"41a691bd4a279709\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/askedStore.js\":\"d9a55b13c9506416\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"91af73b770df3264\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/chipState.js\":\"fbfcf72cf49e75e0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2ddf87144b7b409d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/index.js\":\"f64a893e2e324994\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"522162652bc90eab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-dispatch-companion/schema.js\":\"9d99d0c6c149c2c8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d76b924a7f272360\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ca851d9782016ed0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/addMedia.js\":\"5bf19845fdaabb03\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/backlinks.js\":\"31d22eac78851b65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/block.js\":\"067596ae8c12d734\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/context.js\":\"62ef478de6ca3946\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5c36e1a04018165b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/index.js\":\"acca24ae8cfef754\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/outline.js\":\"81a672a8deae0c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/properties.js\":\"fa72ec5d9f5c876f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/refs.js\":\"895c7a2c2e6b88c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b615b2ab39c88bd3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/search.js\":\"3551305e99045dd6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/shared.js\":\"d967c7116f9fa56b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"536102526db5c8ae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentViews/text.js\":\"62613dd9c19c5ff3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/agentWrites.js\":\"78ff2a548b0c9c29\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/authoringCatalog.js\":\"d38c82e80395a3c4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/blockRefTargets.js\":\"180d8ea75ac28b78\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridge.js\":\"d0416bf89cec13a8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/bridgeLoop.js\":\"0fcb300b4ccd0056\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/changeHistory.js\":\"8a0456ce4fcbe6fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commands.js\":\"2e8f03d9d8892662\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/commentsCommands.js\":\"b60877608618878e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataExtension.js\":\"a22dec1ca4a6bf97\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/dataModelGuide.js\":\"8b4e83691058a39a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/describeRuntime.js\":\"70ddb7080c7d40c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/extensionLint.js\":\"dbef4e98f93d4c90\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/grainAudit.js\":\"1a28f45a68dfe446\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/healthCommand.js\":\"77d09470a1c21ba5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/index.js\":\"cebeb1eda59d9ff2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/presetIdentity.js\":\"0b1e8fedd574bbd9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2080de411afd8061\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/readMedia.js\":\"0683bc7a9dab4bb0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/schema.js\":\"40eee1c344e255ad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/serialization.js\":\"7a05147867f6b849\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/targets.js\":\"d3c01b097c1d374c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/tokens.js\":\"46214d00f8dfd9d3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/watchEvents.js\":\"a939aa4a0afc7bc0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/workspaceGuard.js\":\"8f38b5ebc14e07be\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/agent-runtime/writeCommands.js\":\"35272d014713de20\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/AliasCollisionToast.js\":\"f989facc99a38b42\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/DuplicateNameBanner.js\":\"a56c3593e79ec390\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/collisionMerge.js\":\"4e6753a38e104cc5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/dataExtension.js\":\"0e4074e6251d7d9e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/index.js\":\"d9e38f534c53c5e4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/mergeCollisionAction.js\":\"399aa26c35523f7f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/pageStyling.js\":\"2e8bdd8c7b34f5e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/rejectionToast.js\":\"e6b40749d45cc083\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/alias/syncProcessor.js\":\"b90d65b4487ed6c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/actions.js\":\"2ef67930e09d492a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/addComment.js\":\"d1b52f0550b46b86\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchor.js\":\"f7a364cbf9bb4168\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/anchorState.js\":\"04e7933c4337dd65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/commentLinks.js\":\"834377dfddfd5a96\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/confirmThreadDeletion.js\":\"770ecfa83b065377\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/container.js\":\"660d64d6c75ec14f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/dataExtension.js\":\"6a2dc08a5c2c1cfa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/deleteComment.js\":\"290caeac8d2fef88\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/highlights.js\":\"c2713819712b6341\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/index.js\":\"d9d9d5a338c50923\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/linkedCommentsPill.js\":\"a75d9e0a962304e3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/margin.js\":\"3ff8ca6c4b13eaae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/marginSchema.js\":\"90b344228485e9a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/newComment.js\":\"796dd334ff5d3a0f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ownThreadPicker.js\":\"d446ba57198f93ad\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/placement.js\":\"68fc1597150d5d55\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/queries.js\":\"41d6d59b0bf3722c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotePosition.js\":\"82425bf2410ddf07\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedIn.js\":\"b3ed37be31838479\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/quotedRange.js\":\"59d60209d654aa85\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/rangeRefs.js\":\"42369d03707fa586\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readHighlights.js\":\"21578e4561217811\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelection.js\":\"47114904c5708d6f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/readSelectionUi.js\":\"8c2546b96cfde85f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/reanchor.js\":\"ea8e5d75889172ae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/schema.js\":\"853b9a216cf1b85b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scope.js\":\"3480b4fb0f0c6a12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/scopeThreads.js\":\"80f6b7573ad04fe6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/splitRetarget.js\":\"80005bdf282b0792\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestionCard.js\":\"5f5703a0793f5b42\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/suggestions.js\":\"6e73b3739893a2fa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaries.js\":\"516c32bb2aed6f59\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/summaryBatch.js\":\"f90b43e55e86f53d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/surface.js\":\"a6d503e4eb33288d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threadNavigation.js\":\"2ac03738aa66bd51\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/threads.js\":\"599031cb13bc65c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/ui.js\":\"5a73fc9d241b9807\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/annotations/uiStore.js\":\"d1ae6aff3cecdf0d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/appIntents.js\":\"71d69f18cba076b2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-intents/index.js\":\"acbacbc6843bba88\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/index.js\":\"daa6211ecb254815\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/app-update-prompt/status.js\":\"698f5b0838736469\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7b8480560d90d4c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaBlockRenderer.js\":\"6ea729c0ccac06f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7fd35e9be83cc34d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/MediaUploadReconciler.js\":\"1a0724a260b156bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetDownLane.js\":\"595ca5b4df44f76f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetResolver.js\":\"366865c00b1dcae4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/assetUpload.js\":\"4b52467ab3a476d8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/attachmentCleanerIO.js\":\"e143d4d64814fbb5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/supabaseAuditIO.js\":\"59a304a481f721bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/blobStore.js\":\"c6cca344fb4bf2ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/byteStore.js\":\"b65a7e69b9bd487b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanerIO.js\":\"d0fbe172022eb657\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/cleanupAttachments.js\":\"69675760f1fb0f65\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/dataExtension.js\":\"83a80173218cdbe5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/downLane.js\":\"2c5ea76494a404c3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/index.js\":\"6320dd1d12ff756d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/insertImageContribution.js\":\"410e29bf64e81e53\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneArming.js\":\"87c11239d6a84cb1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/laneLock.js\":\"5d69743da535815c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaBlock.js\":\"73ec41ef264c7eea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaCapture.js\":\"9054d6e285502cd2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewers.js\":\"efaccab6c1d2a329\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/mediaViewersFacet.js\":\"fc544926ad8af82e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/pasteCapture.js\":\"7f6965f7638e0bae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/resolver.js\":\"32d3c551460b0d70\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/retryUploadsAction.js\":\"9e6981e49eeacb0a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/storagePaths.js\":\"7586f71b41929e14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadDrain.js\":\"14f2bbc42eab0721\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadLaneStatus.js\":\"54e4e7cb7058cff9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadReconcile.js\":\"4f3f4440d2e8c6ea\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadRecovery.js\":\"b1f082fb54aa5f08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/uploadStore.js\":\"e945402c6dea1765\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/attachments/useAssetObjectUrl.js\":\"3496e9f483c80f8f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a35428c4d5aa995e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/BacklinksViewSection.js\":\"100481204aab2f00\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/facet.js\":\"9401b8e556223e71\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/index.js\":\"4846c374457f47e5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks-view/prop.js\":\"c397d216b93d1f62\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinkFilters.js\":\"7254c96dec3c5092\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4d0a4068ca27a546\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/BlockEntry.js\":\"cae8aff3d094fc92\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/LinkedReferences.js\":\"c66855d2fa14cb62\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2799c0f80a6aacc6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dailyNoteDefaults.js\":\"6a2908ec3a0f32c1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/dataExtension.js\":\"c3b51c77508f0482\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/edgeExclusions.js\":\"c462f4d32e49f0b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/filterProperty.js\":\"94ec0cb051f170fa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/index.js\":\"00f681b6e3e65263\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4bd5a6bc30a12352\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/applies.js\":\"aeb4b808aade78e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/countQuery.js\":\"874d33c3bf277ea5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/expansionStore.js\":\"38bb6110271f6702\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/index.js\":\"a250b808dbb58754\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e50610f2759e348d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/presentationInvalidation.js\":\"482d89239a00f014\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyEditorOverride.js\":\"678714852a3820f6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/propertyFilter.js\":\"6dc003f8e3eb6f99\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/query.js\":\"7f3e76e9d8e9196b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/resolveFilter.js\":\"9d4a63b449969aa0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sourceBatch.js\":\"d35098772c13726a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/sources.js\":\"2c5562f28b5127fe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useBacklinks.js\":\"88516a507c43fdc7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6d5274e2a0ef7af6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayCelebration.js\":\"2e6dd36d604619d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/BirthdayOverlay.js\":\"fe54bd62b391603a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/gate.js\":\"9514f631ab86ffd8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/index.js\":\"6b94161c11adbfcf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/birthday/wolfTheme.js\":\"9c9bb1b82c8c4295\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/BlockDragLayer.js\":\"4b962c328b2c12cc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dragController.js\":\"721827aa1190645a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/dropTarget.js\":\"b075f3d3bd6b27e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/index.js\":\"b5d8c60ba7e82e08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-drag/projection.js\":\"0b8982e9f1dbf4ba\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/BlockMetaCard.js\":\"888f41e747d403b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-info/index.js\":\"738b25e1bc6b4092\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/AddTagDialog.js\":\"7e05fc268706e9e8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7876e0a49de9ec97\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/TagNameIssueHint.js\":\"a86261aa4c807a74\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/addTagAction.js\":\"c6fec2a2171f305f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/appendTag.js\":\"63f2cbfb75deed73\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/config.js\":\"0c3328d7d1b6b8e5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/dataExtension.js\":\"756c2af8e84843e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/index.js\":\"4c1024b27d187fd3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/block-tagging/propertyEditorOverride.js\":\"36ab35d855237b93\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9114fcfe603e9ac3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"86ed3c127eae9602\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1b77e6b196979705\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0d78dcad7f878d47\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9227eb8eec59e5c6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/index.js\":\"942907f8c9f6458a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"87e736b377101be0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/CharacterCountItem.js\":\"70b7136ebece9db1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e906b1e1febda4b6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/actions.js\":\"eb20d377d4294a48\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/blockType.js\":\"af6f2ba09e23a722\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/charCount.js\":\"9a57d49f7d5d0345\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/dataExtension.js\":\"c6e8a760e36450e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/index.js\":\"017b395a02e79cc8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/profiles.js\":\"430532e5171ceea1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/properties.js\":\"3bd3efb8cb59d532\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/character-counter/textCounts.js\":\"87e429c91294ee3f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/colemak-keybindings/index.js\":\"ed891e5c3663cf89\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/CommandPalette.js\":\"16216828c864bd5d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/HeaderItem.js\":\"99bd8c7a0a95b895\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/context.js\":\"b3fc5c3a11132c00\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/index.js\":\"c2e3c0a7a718ee12\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/selection.js\":\"0798ee2b89719372\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/toggleStore.js\":\"a8981166dafddb24\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/command-palette/useCommandPaletteActions.js\":\"2e923efb19fa20e4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/ContributorBadges.js\":\"f6688c2d5a099dd8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/author.js\":\"669d99bd77685b4e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/codeMirrorExtensions.js\":\"7c5f891ab6b94422\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/dataExtension.js\":\"a02be7539104fbe9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/index.js\":\"c33783ae65b756f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/mentionAutocomplete.js\":\"bf2c90a8fa77fbd2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/processor.js\":\"63a2cf5564d0ce91\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/profiles.js\":\"5482b4c2a67a0e57\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/queries.js\":\"9f7974aa16d86b73\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/contributors/schema.js\":\"d0177533ed2803f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ba1ace2b3ebbaa67\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/followOrigin.js\":\"63cdf4b91a32ada8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/index.js\":\"528cc7dc91ad7d2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"be55b8eeb892261c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"309c7fdf08ccdd8c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/CalendarGrid.js\":\"7f98b1a6e0b7afde\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DailyNotePicker.js\":\"47267cfde01042fc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"775ce83ee5814c75\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateNavDecorator.js\":\"dbea3684b2e29290\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/DateScrubOverlay.js\":\"f549fb9b647210b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/HeaderItem.js\":\"a1632faef00cc0e1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/ReschedulePicker.js\":\"6825aff5a4a3c099\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8dcf74dfc8372a50\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/actions.js\":\"2d62fe419be9912c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/blockDateAdapter.js\":\"7a11ac7819b97b06\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/calendar.js\":\"6748661b294de982\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dailyNotes.js\":\"f7b0dbb7b9a179d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dataExtension.js\":\"c7ccfd1082f666cb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubActions.js\":\"f95d1f27ebc17319\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGesture.js\":\"f9ff5c049a72826c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubGestureActions.js\":\"97ab612a5d6b90b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6a81a253eebb80b7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/deletionGuard.js\":\"91111ee6e1b5844d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/dueQuery.js\":\"b4a34e7af6788ea3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/index.js\":\"ba78947b81795f73\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/landing.js\":\"4cdac081e4fc10dd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/localSchema.js\":\"cd6b42a70f08f25c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/referenceDateAdapter.js\":\"efa05d89fa3cc3bb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/rescheduleAction.js\":\"0508e53696a78f94\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/schema.js\":\"bdc355b7c5380a27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadBlockDates.js\":\"a3e5fe0ec9682007\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/spreadDatesAction.js\":\"a0bdaa763ceea9df\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/today.js\":\"e4e73ef68487398f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"80de05d42ae75102\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d46ed363cbec1e70\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/audit.js\":\"c30d13fb57e23ea0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditAction.js\":\"35fca1aa37d511b7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/auditRanges.js\":\"596be079f9171870\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/diagnosticsSource.js\":\"83c69e426c125f88\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/divergenceScan.js\":\"e80e71b89bb57d6e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/index.js\":\"f91cf2ada8f44d2a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/propertyChildrenChecks.js\":\"68ee4f95d54b4804\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/referencesMirror.js\":\"441a53461be505b8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/rowJson.js\":\"afe8bf62784c8ac2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/schedule.js\":\"6c22aaaf99b3d724\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/data-integrity/store.js\":\"90fd663a94e6bff2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/action.js\":\"20ad52a834f78bcb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/index.js\":\"3f60f75e4bdff38a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-maintenance/plugin.js\":\"5d5eb9a7e5a1dafb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"70ee37110e08fb6d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/actions.js\":\"a2fd084cdf98fac7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/changeMarker.js\":\"975d393713c51920\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/diagnostics.js\":\"d98a62a820789245\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/fileSystemAccess.js\":\"c2358aa29696138d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/filenames.js\":\"7d28b395e6091ea0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/index.js\":\"cfc9a5b825be3c80\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/mirror.js\":\"bbba4198b4ebeac1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runLock.js\":\"46692920df6017e0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/runtimeHealth.js\":\"c99575dce9e2e4ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/schedule.js\":\"6cba871ef7c24084\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/db-mirror/store.js\":\"ace5ce36c3cced5a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/index.js\":\"d39eec4d5b7afe14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/default-themes/themes.js\":\"a94fda4226c2c771\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/facet.js\":\"fef648d4a84e1033\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/diagnostics/useDiagnostics.js\":\"79444e4cd6b87dac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/dismissals.js\":\"04459ef9078cf6d0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/index.js\":\"f239806f8a427e47\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/status.js\":\"fc6fbeb705d1cf79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extension-prompts/store.js\":\"c0b9ca7a3aa4204c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e5a40b5778746450\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ce866d283928f1f2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/actions.js\":\"810f84bd8450c25c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/config.js\":\"7032871833fbd28f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/dataExtension.js\":\"badfb37cec5716bc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/effect.js\":\"54a766a8efb5e854\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/index.js\":\"829eb5129203d812\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6a147e5e39003315\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extensions-settings/useToggleTree.js\":\"80f6397884884d63\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/ExtractTypeDialog.js\":\"05a0c716a10217d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f3d4f75f4e65de7f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/PropertyShapePicker.js\":\"d58b2bda9c7c9ecc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/action.js\":\"c39870534067e80d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/extract-type/index.js\":\"1972b52de5af5a48\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/FindReplaceDialog.js\":\"246563e0f6c43d23\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/HeaderItem.js\":\"190819d5e8ecd5bc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/dataExtension.js\":\"ca81a8819b255f66\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/index.js\":\"fcec04eabd39987b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/search.js\":\"b50bbda1805e5c4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/toggleStore.js\":\"531eb1fd633aa42e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/LocationPropertyEditor.js\":\"63d07f25d0f0d435\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/MapView.js\":\"fdb6d2f6f05de0b7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/blockTypes.js\":\"96007c70c0cde4fa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/codeMirrorExtensions.js\":\"26619e030d313895\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/createOrFindPlace.js\":\"30b752acc584a758\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/currentLocation.js\":\"c99eb0167b861c19\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/dataExtension.js\":\"0e3d2f24a3a8b273\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/geoContentDecorator.js\":\"4e21a86a36cae403\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/googlePlacesClient.js\":\"7bcea18281d2598e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/index.js\":\"987f97b88063b93c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/locationsPage.js\":\"5ee13aad6212da73\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/mapViewport.js\":\"d0f584d734341d2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/pickCurrentLocation.js\":\"7b84fc25f6658789\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeAutocomplete.js\":\"4e3d96d5b3cb2429\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/placeNameCollision.js\":\"77cc3c64da0f9d30\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/properties.js\":\"5f4c8b817b024dc0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/propertyEditorOverrides.js\":\"3a94af907a4b19a5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/query.js\":\"9c11eefd5c1d1369\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/geo/usePlaceSearch.js\":\"10e872a0d8fae5a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"147703be54cff614\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e96a2a51c7cf192f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a463ab03e0ef15c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/config.js\":\"5fe5f775bcb81653\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/dataExtension.js\":\"42e59a4fda5d349b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/facet.js\":\"a2999c2a2bd5f69e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/grouping.js\":\"6d60a7c717d26730\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/index.js\":\"6b60e3287dcfbbf9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b4f199b65ce7c50e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/query.js\":\"397021d77957972e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/resolveConfig.js\":\"9774123c7a01aa5a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"18663355d89d2a58\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"673d2c9d41092d9a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlDocumentContent.js\":\"5862e1a4d00033de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/HtmlFrame.js\":\"8006ebe4ce8eacd3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/actions.js\":\"501354573f340ef9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/blockType.js\":\"bb625c619c0847b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/confirmRunScripts.js\":\"e1bc5165fb438299\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/dataExtension.js\":\"1af34de3b684aecf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameAnnotations.js\":\"792635b8fdf86b7b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameDocument.js\":\"c1d68996e755d117\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/frameTheme.js\":\"daca5e7eb4d41e2c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/index.js\":\"5628b6f3fdb83082\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/scriptConsent.js\":\"b440e64bfdeb72d3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/sourceMap.js\":\"8332e99e100e279a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/html-document/useDocumentScripts.js\":\"fcc61890918800e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/index.js\":\"bb2ed5c939811afa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/record.js\":\"bcf1eeb7cca73ed7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/recordStore.js\":\"35a7180531788605\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/responsiveness.js\":\"5f06c73fc9ec8ae8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/schedule.js\":\"b792fe517d460fb2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/interaction-metrics/sessionContext.js\":\"12cf3e8718d6261b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ee1d3c2fdff264b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c48f43936fdc69bb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/actions.js\":\"6784e86bd4c5cf5b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/config.js\":\"0626b4fde6a83ea9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/dataExtension.js\":\"29017adb8a49af5f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/effect.js\":\"636f39701a22eb1c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/index.js\":\"988a0f2beac36f28\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/keyCapture.js\":\"48ec701d5b57963a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/overrideStore.js\":\"b91b3caed750103d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3736a8637f4e5647\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/HeaderItem.js\":\"3b67883e67743bb0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/LeftSidebar.js\":\"066c9184cf66a613\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/actions.js\":\"739d0ca218a94e3e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/facet.js\":\"7745a7d19a940649\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/index.js\":\"d377586a4ae9e3d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/shortcuts.js\":\"a54c1d55664acd5b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/left-sidebar/toggleStore.js\":\"52484acd18b5d906\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/MergePicker.js\":\"661934a67a82294d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/index.js\":\"c4a0df16ea8c1876\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/mergeAction.js\":\"5d56da8da4274043\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/merge-blocks/strategy.js\":\"774dbe076e654986\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/Button.js\":\"99e21b505ae3c0b0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"606a7ba3ab2f6637\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9282082b8bd84def\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/facet.js\":\"7cf3d13d003b2c71\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-bottom-nav/index.js\":\"f8aefceaede344fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4be98f2e7d0631c4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/actions.js\":\"be9f5a4a56b1810c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"13711864cf432aa2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/facet.js\":\"adedcc68275008a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/mobile-keyboard-toolbar/index.js\":\"a3bec21a7915101d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1407aefb28c98bc8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e9d349055124ab9c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/contextMenuItem.js\":\"7188d3fc34d920d8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/index.js\":\"b55c0fcaaf84fc22\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveAction.js\":\"96fb0a869b4f2b5d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/moveBlocks.js\":\"ff0bc76e670e45a1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/move-blocks/selectionAfterMove.js\":\"cf5c600396e9629e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/TutorialBanner.js\":\"60f81ed839cdd59c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/action.js\":\"fca99465b9bf218f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/bannerDismissal.js\":\"a159c18cff35f403\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/documents/cheatSheet.js\":\"df26ffa8b4cb9d9b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/index.js\":\"b4da1b6d339f8ce7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/keys.js\":\"b9db7ac87d16550b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/landing.js\":\"b9797ec0bfd57ff8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/outline.js\":\"07e211f0880cd432\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/onboarding/seed.js\":\"86bd14030724e91a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/PerfTrendDialog.js\":\"99ee5605fe0a0a43\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/analyze.js\":\"64f5670a19b32285\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/diagnosticsSource.js\":\"bc538a3ecc8ce937\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/index.js\":\"e842f3a9338140fd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/load.js\":\"5544fcece5155a2f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/monitorRun.js\":\"9281b575d669a1b9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/schedule.js\":\"efcddde83f58844a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/series.js\":\"56766c7e66cb8f75\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/store.js\":\"3633cc5a092b62d7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/trendAction.js\":\"1ec73c8ea5ffc117\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/perf-monitor/verdict.js\":\"d33e27a1d2d45822\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/clickToEditAction.js\":\"9e6c7dc992fcacb7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/index.js\":\"f939dc6293a8e824\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/plain-outliner/interactions.js\":\"61bd31bbb15be1f3\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"159c8e5521273888\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGate.js\":\"90c118ad341b594f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/MigrationGateDialog.js\":\"7275646242e124ae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/action.js\":\"51c82b4d8e5ca452\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/index.js\":\"35c1842e4bc9e10c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/localRunMessage.js\":\"3a6a3a7e89c061bd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/plugin.js\":\"f498c2389e78128c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/progressReport.js\":\"5b50e22e01f5261e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/properties-migration/sweepProgress.js\":\"30c9c6ff6ca05c66\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/FieldRowRenderer.js\":\"dbd0d446a971d8a8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/ValueRowRenderer.js\":\"4ac6c3513242bedd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/actions.js\":\"cfe49fa6f60bf9a4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/autocomplete.js\":\"fe0e7a37d1d9e40e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/fieldRow.js\":\"0f449e1c66e5408d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/index.js\":\"42f4749d448be98f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/referenceWarning.js\":\"60db584017f22110\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueAutocomplete.js\":\"5a435467237eade8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/property-rows/valueSchema.js\":\"9e5f03eb844a9655\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/HeaderItem.js\":\"221bda5a1c457298\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/QuickFind.js\":\"62eb00a489e744aa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/index.js\":\"33ec80ce63dd6688\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/recents.js\":\"f9955f99a706001b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/resultItems.js\":\"fd1dffc1685f9454\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/selection.js\":\"6654659b7d3c4b0e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/quick-find/toggleStore.js\":\"c1f38714e380e1cf\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/HeaderItem.js\":\"e74f83a770fb16d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5816a3cecef9eeab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/grouping.js\":\"3bd20dbd56f2310b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/index.js\":\"ff44c09e37b4f547\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/recents/target.js\":\"e650247c05d95f82\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/codeMirrorExtensions.js\":\"7c5528308b0d728a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/contentPrefill.js\":\"b68b857724c09c1d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/dataExtension.js\":\"5551fdbd88d40357\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/index.js\":\"3b086eca9fbd0f3e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4429360c624c21fb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/invalidation.js\":\"8691af71d40595cd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/localSchema.js\":\"4f93cc03203a0770\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/index.js\":\"40d91b67a0399330\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"eeaae41bdfa2c079\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/index.js\":\"bc196ebc1aa933fc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/referenceNode.js\":\"c796711182a854d2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e6e4030e79b8cb85\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"73cce403a6311a4a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/index.js\":\"cbf7f185447ed89c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3b253279dc145e83\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"213450171fb800a5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/mergeRetargetProcessor.js\":\"0be891b20e66fc33\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/parseFence.js\":\"47e5d0055ba368a6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceParser.js\":\"ace0648f4936e5a8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referenceProjection.js\":\"c88696a20c773690\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/referencesProcessor.js\":\"1b0b9a9cd0ac7266\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/renameProcessor.js\":\"8fb373652b839810\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/references/spanReplacement.js\":\"5d06fc65b3eb7dfe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/htmlToOutline.js\":\"2d327e07b6730085\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/index.js\":\"da97bde98b93a9d7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8ca17d5e8d2e13f4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/rich-paste/pasteDecision.js\":\"19128d6aaf349131\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/action.js\":\"d50cac01dd391214\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/blockIds.js\":\"52171cf88e29d78b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/content.js\":\"4029e5ae4ed6168e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/effect.js\":\"258f08c2ed4dedfb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/ids.js\":\"942de236675a6465\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/import.js\":\"77091de76d4b7873\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/index.js\":\"9940fa1da412fa27\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plan.js\":\"70d3cf6c6f952337\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/plugin.js\":\"6aebcbdb97f8c741\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/promotion.js\":\"5ac26fb1754392b7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/properties.js\":\"49e3cf3b09038a50\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/references.js\":\"ad93678f106df839\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/report.js\":\"c0a02d1ec147b92b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/roamMemo.js\":\"f1c56bf6ea068125\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/runtime.js\":\"5fbfc226c02a6cfe\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/schemaReconciliation.js\":\"5e781061058628b4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/srsMarkers.js\":\"c20dfc668b99338e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/todo.js\":\"278483fe6cba7892\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/typeCandidates.js\":\"3b7a4811254975de\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/roam-import/types.js\":\"239e79b228e7af9a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/index.js\":\"8dee6cfdf94a1ab5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/search-health/store.js\":\"e136fdd4ca6c08c5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/HeaderItem.js\":\"03ad49835798ed5b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c038f5f5ca0bebdd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/index.js\":\"8f48c591de9c9ddc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/model.js\":\"a175243fcd30418f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/toggleStore.js\":\"d01a46548a429338\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/shortcut-help/useKeyInspector.js\":\"d7697ac435498b71\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6f8a71606d145085\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/ShellDecorator.js\":\"a67ab0d829ddb592\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/actions.js\":\"577cdf7d3d5c343f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/exclusionsFacet.js\":\"22a9cb463a7321b5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/index.js\":\"939068da874c63df\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/shell.js\":\"26a6aeac36ded1c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/surface.js\":\"bf1e24a047ef2cf4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/spatial-navigation/walker.js\":\"1a70475b29310507\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f36cb38116c98a67\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/dataExtension.js\":\"adcba79e5e1c06c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/index.js\":\"6088172253251874\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/indicator.js\":\"42858b8280688856\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/moveSrsState.js\":\"f6f58351f625c637\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c755ff3f8b0dcf4b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/scheduler.js\":\"747fe3594de06418\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/schema.js\":\"2aceb630aefbba1b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"fdb407ced40f6fd0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/srsClipboard.js\":\"0aade69e0a198ddd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ed289b168b92d5e6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DailyNoteReviewHint.js\":\"718ae6d7b8b15744\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/DeckPicker.js\":\"5269d6c9ea7ebb50\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewControls.js\":\"5ae9c4c225f60278\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewDeckRenderer.js\":\"22484d9199f3e681\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/ReviewSession.js\":\"29926ff91210ebe2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/actions.js\":\"d88ac7b2547a5106\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/archive.js\":\"42629d7801b6025c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dataExtension.js\":\"e50222113e32e6d4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/deck.js\":\"5fc4866a589bd21b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/dueQuery.js\":\"e4892ea94a34208e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/gradeDecision.js\":\"5b00f49724c16d55\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/index.js\":\"c442e126b9a4b7d6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/keyHints.js\":\"04b7c3dcbde92120\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewCardLayout.js\":\"a206b33fe5e21c6f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/reviewProgress.js\":\"ecbd2cafb8189217\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/schema.js\":\"f02924adfa905b1a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/srs-review/useDueCards.js\":\"89254c98aac13487\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/index.js\":\"f5ef6b48733a1124\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/startup-metrics/record.js\":\"f12839ba9848364b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/index.js\":\"c32e2ca03c1bf697\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/persistenceStatus.js\":\"e4e1e1b7a38398c0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/storage-persistence/requestAction.js\":\"af1e2006697a0dcd\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/TypeChipsDecorator.js\":\"07985020ed61e5bb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/codeMirrorExtensions.js\":\"cf312d12b9127a08\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/index.js\":\"1679017905ac22c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/supertags/typeAutocomplete.js\":\"59baedfaf93f4ed9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"233dd9bc2fef620b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/actions.js\":\"368d3645642d3dfb\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/anchor.js\":\"c7d2028b8f596992\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/events.js\":\"cdc7b39f7917851b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/gestureActions.js\":\"a72f20e45d03d29a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/index.js\":\"02b7037ea34d8b6d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"593427f8e3575d6a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/collect.js\":\"1fe7ebf54973a5ed\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/index.js\":\"19532565be6659db\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/sync-metrics/record.js\":\"dbf6cb5b2b71988d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/RejectionDialog.js\":\"5848fea956172780\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c246b9a3e6a41f93\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/index.js\":\"8fc19a89171f6548\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/model.js\":\"a9f369a77dd534c8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/queueCounts.js\":\"e82d754ea10e206d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rejectedHelpers.js\":\"2269c609779aae06\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/rematerializeAction.js\":\"d21c649492ef1a77\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/system-status/useHysteresis.js\":\"adf5421f75dbc96e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/ColumnHeaders.js\":\"046725810b56f379\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/QueryUi.js\":\"0a389b5b673237ac\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/TableLayout.js\":\"b89d23f00dbbf2f7\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/actions.js\":\"167a59e9842ed8f0\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/cellEdits.js\":\"b5183ef4a9538775\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/columns.js\":\"919ce85f6a7ef039\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/controller.js\":\"9e72761a1992c281\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/convert.js\":\"2fb0a178f185b916\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/dataExtension.js\":\"d2bec86ca4150617\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/index.js\":\"460304ed0a83fe40\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/keys.js\":\"dfd8f1902a2f1eae\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/model.js\":\"8dd6627e8181fc36\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/navigation.js\":\"c206d8713fc96bd5\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/backfill.js\":\"7eb336ed111b864c\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/completion.js\":\"743162d90325f1f1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/format.js\":\"cceb6a428d3ff62f\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/parse.js\":\"f51396a912cd0cab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/queryValue.js\":\"9b6052a43482b670\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/query/source.js\":\"f44e7772e1ad82ff\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/registry.js\":\"2c5f4cc2247e7f44\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowGutter.js\":\"db2697fcbe5bdc79\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/rowVerbs.js\":\"6178e4f4306eb739\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/schema.js\":\"6f708e6953aaaf71\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/tables/sort.js\":\"f749921679a17482\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/effect.js\":\"48d12e3e5e9ece57\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/index.js\":\"4911083cf2c41197\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/theme-toggle/theme.js\":\"b5853f9d10f07697\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/actions.js\":\"20fa6846c890783d\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/dataExtension.js\":\"2672fe50a7daad84\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/index.js\":\"78c5aece2a57adf4\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/todo/schema.js\":\"9b24d9259595574a\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e8b5455fef47d433\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/actions.js\":\"a521017e0e90b25b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/defaultItems.js\":\"d2d316dc4fc7a1fa\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/facet.js\":\"2b32f4250404ef25\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/holdRecognizer.js\":\"e22b9365947c19b6\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/touch-selection/index.js\":\"e0efb1151c995786\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/UpdateIndicator.js\":\"55b7083d8b1f30b1\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/index.js\":\"2dfb0abc236f7fce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/update-indicator/loadTimes.js\":\"507e423b6d13a35e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoNotesRenderer.js\":\"03ec7ec91a41ed47\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoPlayerRenderer.js\":\"4c74eb214ec2fe1b\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/VideoTimeStamp.js\":\"e941d565972f2722\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/actions.js\":\"64064a29e9dbfa18\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/index.js\":\"69f2c84f07a22048\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/markdown.js\":\"900ba7fa0fff7a57\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/notes.js\":\"4ef22e31b5b658ed\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/registry.js\":\"1a714a1bac8c70e2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/remark-timestamps.js\":\"fcc0115450cf95ab\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/video-player/view.js\":\"a9cc3bca7f57eff8\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/LinkHints.js\":\"40bc0f995c93d691\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/index.js\":\"abcac4b80808114e\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/model.js\":\"175ebec5e18004ce\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-link-hints/settings.js\":\"135533e55572f2dc\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/actions.js\":\"229039ebf0ad06d9\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/index.js\":\"61abd6ee1f7242c2\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/vim-normal-mode/interactions.js\":\"b22d5de2c4cb2d84\",\"/knowledge-medium/pr-preview/pr-1855/src/plugins/workspace-header/index.js\":\"d4bb8b45140e1c51\",\"/knowledge-medium/pr-preview/pr-1855/src/registerServiceWorker.js\":\"d310e42b46ecb489\",\"/knowledge-medium/pr-preview/pr-1855/src/requestPersistentStorage.js\":\"e10c72b28b2d3d85\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authRequestDeadline.js\":\"a2c3687fa1b0e8bb\",\"/knowledge-medium/pr-preview/pr-1855/src/services/authStorage.js\":\"fdc0249511833748\",\"/knowledge-medium/pr-preview/pr-1855/src/services/powersync.js\":\"dd757b4599f754cd\",\"/knowledge-medium/pr-preview/pr-1855/src/services/supabase.js\":\"b901713ff1353744\",\"/knowledge-medium/pr-preview/pr-1855/src/services/uploadErrorClassifier.js\":\"d8785792e9a70100\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/ActiveContexts.js\":\"a5d6e80706fce5aa\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/HotkeyReconciler.js\":\"9b45ced7c9cb8f25\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/WipeLocalDataDialog.js\":\"5b5b12fefc2fe17f\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionDispatch.js\":\"dc72f5a3ac960232\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/actionRefItems.js\":\"468169ef503abd0d\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/applyKeybindingOverrides.js\":\"9af775aa7e9a38d1\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockActions.js\":\"6f60b3e9df441d5d\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/blockMergeGesture.js\":\"bb331d68e84c7bd9\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/canonicalizeChord.js\":\"c795dea08a5ff20b\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultContexts.js\":\"8b66ff389bd0ee7b\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/defaultShortcuts.js\":\"b5720c69e07b463e\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/effectiveActions.js\":\"e3f528afa176ba1c\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureAction.js\":\"a74968d4a3b34a13\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/gestureBinding.js\":\"f69282860d509198\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/holdRegistry.js\":\"95bc112ba5136abc\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingConflicts.js\":\"6c6f87caa40fff83\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/keybindingOverrides.js\":\"9097dbcf426f53e0\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/pointerAction.js\":\"f2869645168c2a73\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/resolve.js\":\"2b046de8ca377769\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/runAction.js\":\"0e9bfa42efe2121b\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/sequenceMatcher.js\":\"cf0ef576b2ea3f1d\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/types.js\":\"86db4b99864a93fe\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionContext.js\":\"3eb6d153d973a7e5\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/useActionDiscovery.js\":\"d197ddfaaa15170a\",\"/knowledge-medium/pr-preview/pr-1855/src/shortcuts/utils.js\":\"f216375a6ca007de\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/bootStore.js\":\"9479ca1f6fdaa030\",\"/knowledge-medium/pr-preview/pr-1855/src/sw/previewDatabases.js\":\"a080f2d0b7ed6154\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/byteTransform.js\":\"731fe924879fb098\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/attachmentCleaner.js\":\"452ba86fdd1fcde1\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/attachmentParts.js\":\"358922e3af1989fe\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleParts.js\":\"f6f2461be30958cb\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/bundleRecord.js\":\"35185aa653a52b74\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/manifest.js\":\"82fd1291181cfabd\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/takeBundle.js\":\"b26dc88b3e921210\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/bundle/verifyBundle.js\":\"9cda22ebe193eb1b\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/cleaningStage.js\":\"0785bc47b0fde105\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionKey.js\":\"7293e655eb7cd4b7\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/conversionServer.js\":\"87e2317c808d00cf\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flip.js\":\"26e530fc54718714\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/flipAttempts.js\":\"5acfa1797e065489\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/pages.js\":\"615d1274e4e5557e\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/preflight.js\":\"b76ff19f42b87bbe\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/reseal.js\":\"0f42e56bbebefd8f\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runConversion.js\":\"619c50134c5dd93c\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/runLock.js\":\"da1769988c55bf12\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealing.js\":\"947eedc2f24a5427\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/sealingStage.js\":\"0f5facfdc1803897\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/stage.js\":\"ba8ad599f88eae11\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/conversion/verifyReseal.js\":\"cff6711541630eaf\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aad.js\":\"c1d58b7e1ab7659d\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/aead.js\":\"53324622463272b7\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base32.js\":\"9bb0fd7d392130d3\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/base64url.js\":\"ef5026e6de3e99ab\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/binaryEnvelope.js\":\"30125aeb4b35cf5a\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/byteAead.js\":\"4d6e6251820f6fe9\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/canary.js\":\"22e3fe80fe6194d9\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentHash.js\":\"4fdb67d5487e0b56\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/contentKey.js\":\"4c8ead960b89acc7\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/derivedIdNamespace.js\":\"d5ee121719cbd8f4\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/envelope.js\":\"2d50a8ef4e0b445d\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/hex.js\":\"1cacd36ac1dbf929\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/sha256Hex.js\":\"0940b81fe096d121\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/crypto/workspaceKey.js\":\"132bbc519c4827a4\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/conversionState.js\":\"1d709c0c02fc0d20\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/createEncryptedWorkspace.js\":\"30d6f8508d974ad1\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/pastedKey.js\":\"da3303591a8317cd\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ed9a7a5250f26242\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e166ff8e9cf53159\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/keyStore.js\":\"af4f39813fd6050b\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/mintWorkspaceKey.js\":\"b29cc5c4c436850f\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/modePin.js\":\"374d84a1ad61982e\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/openWorkspaceKeys.js\":\"de33c4ddc6ec97cc\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolveWorkspaceEntry.js\":\"540582e36c387a62\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/resolver.js\":\"7080f983efad58fe\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/keys/workspaceAccess.js\":\"976bee39964cee86\",\"/knowledge-medium/pr-preview/pr-1855/src/sync/transform.js\":\"7a60492d6134ed09\",\"/knowledge-medium/pr-preview/pr-1855/src/themeBootDefaults.js\":\"1f411dcf2e355746\",\"/knowledge-medium/pr-preview/pr-1855/src/types.js\":\"395c04c5f0bad296\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/ClientLocalSettings.js\":\"1f2211a9ada457a4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/abortableSleep.js\":\"6ef8f082da490a0a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/array.js\":\"4b5d3adfc9d1e6ca\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/backlinkAutocomplete.js\":\"508121684481895f\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockCrumbs.js\":\"cecda6037cae4e7b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/blockrefAutocomplete.js\":\"1ee285947159809d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/cadencedIdleJob.js\":\"95f9c7e983983834\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/callbackSet.js\":\"86bf5d03a8ca6eda\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/clientId.js\":\"4beb44c9652d5eb4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirror.js\":\"481640ace3eafd29\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/codemirrorCompletion.js\":\"708bad7d53da798c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/copy.js\":\"ee7399300234842a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dailyPage.js\":\"b10d6213a6c40769\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensics.js\":\"9592752e5fbb4f70\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dbForensicsHooks.js\":\"78918a5798a409f0\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/deleteBlockThroughUi.js\":\"40805346a8007408\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dialogs.js\":\"fba3affcbb33f496\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/dom.js\":\"c69f20c6a71f8dd1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/downloadBlob.js\":\"78673df83804d844\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/exportSqliteDb.js\":\"f4f912ab2036b3f6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fileSystemAccess.js\":\"159f0d2559afdf50\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/flipSlide.js\":\"33161e479a8bed0a\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fnv1a.js\":\"8917dfb005fa851d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/formatBytes.js\":\"e73b95a47bd0f277\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/fuzzyRank.js\":\"0d1c1de9d4053feb\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idbKeyedStore.js\":\"d768cfa3af3820c5\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/idleCallbackPolyfill.js\":\"abb5f493c07a8dfc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardAwareScroll.js\":\"153ef175386b9dab\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/keyboardViewport.js\":\"02af1dedf781850e\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/lastWorkspace.js\":\"e08fa14dc230ebed\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutColumns.js\":\"adace51b503b4f6c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionDom.js\":\"b1b037389e57f85b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/layoutSessionId.js\":\"9e4340cbf10f8289\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkClickGestures.js\":\"a0571f7b3c3f56fa\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/linkTargetAutocomplete.js\":\"bb0bbbe9301d4692\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbCorruption.js\":\"e9baa8f1de1924dd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/localDbRecovery.js\":\"5d4d9df5061cbe10\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/markdownParser.js\":\"23a07883a88532aa\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/memoize.js\":\"00a861542fe26bd0\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameFieldCommit.js\":\"20d2b06bd239c833\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/nameList.js\":\"a94b02c01b4492a0\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/navigation.js\":\"70ede3626f791c37\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/omnilinerNamespace.js\":\"ace2395bb33ffb12\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/opfsPageScan.js\":\"bfadcf8102d88776\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelClearance.js\":\"fc223e34d9da5345\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelHistory.js\":\"166d8c7044c520f7\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLanes.js\":\"27a3c7b6ed21d221\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelLayoutProjection.js\":\"cb9c7864158b4257\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelScrollAnchor.js\":\"e2453ae11a64f1df\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/panelUrlFlags.js\":\"7ad6a5510c3c7c9c\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/platform.js\":\"982a633ce4b6c7f3\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/pluralize.js\":\"143500e507e4ddfd\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyCreation.js\":\"01be3ceefbb3a459\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyNavigation.js\":\"44ccf13289d5fac4\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/propertyValueContext.js\":\"b82104718e0098bc\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/react.js\":\"4bffe2c423131df1\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeDate.js\":\"a7c3b112546eca06\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/relativeTime.js\":\"3b30a570808f790b\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/renderScope.js\":\"0d7ab898a7cb19f3\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/resolvedThenable.js\":\"0844485a5d1b1361\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/routing.js\":\"07523bf682da9e85\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/safeMode.js\":\"61e34ec421e62d58\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/scheduleIdle.js\":\"7956e3c2ee2e167e\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/screenWakeLock.js\":\"f8de9806b3c2a48d\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/selection.js\":\"c836bb4ca4025980\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/softKeyboardGrab.js\":\"26604847ac3e3974\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/startupTimeline.js\":\"2b063bb75613f042\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/state.js\":\"370c5adf2fc1eaae\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/string.js\":\"5ba1fa5e94db0875\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/surfaceZoom.js\":\"fc4531af2f6b3ef8\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/time.js\":\"d7584534d365c8ff\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toast.js\":\"4b31adfe6012ebad\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/toggleStore.js\":\"deec5be716efd6ce\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/untilStopped.js\":\"8c1de8864de57b57\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/userActivity.js\":\"35fd81e3d8294e57\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewTransition.js\":\"991de6b87f592bab\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/viewport.js\":\"ca78038dd9271488\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/webLock.js\":\"5a28d145f36f4f61\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceRecovery.js\":\"977d668a0ee9ba16\",\"/knowledge-medium/pr-preview/pr-1855/src/utils/workspaceSnapshotStore.js\":\"0f2c06a588335889\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-compiler-runtime.js\":\"f87fe0c82b174e98\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-client.js\":\"835dfcb6683f799b\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server-edge.js\":\"8a3e905cf0018c47\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-server.js\":\"ac7c583281d6dc5b\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static-edge.js\":\"151ab767e0e2c9ef\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-static.js\":\"6d8031b93fc6a5e0\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom-test-utils.js\":\"4ff593909a9fb7f9\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-dom.js\":\"53e9b87b4c15e64f\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react-jsx-runtime.js\":\"acea92e1413cfd52\",\"/knowledge-medium/pr-preview/pr-1855/src/vendor/react.js\":\"85a2f4160a134ba0\",\"/knowledge-medium/pr-preview/pr-1855/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1855/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
