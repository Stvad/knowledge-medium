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
		buildId: "587216d26bbe-8d87a33d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/\":\"f8367fb6d4fdc99f\",\"/knowledge-medium/pr-preview/pr-1858/index.html\":\"f8367fb6d4fdc99f\",\"/knowledge-medium/pr-preview/pr-1858/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1858/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1858/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1858/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1858/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1858/assets/FacadeVFS-D1gtmMk-.js\":\"4406a4c7cf2deaf5\",\"/knowledge-medium/pr-preview/pr-1858/assets/OPFSCoopSyncVFS-CywVYhU5.js\":\"b34a484d4cb79952\",\"/knowledge-medium/pr-preview/pr-1858/assets/OPFSWriteAheadVFS-Bjjd1FFP.js\":\"e2b075bdfda4c8f3\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-DVCVkV2A.js\":\"75b6b421efece65f\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-async-B0bti-FC.js\":\"93d1433e6c6cae8f\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1858/assets/worker-B_BSxPQu.js\":\"cf10fb08ce41fd92\",\"/knowledge-medium/pr-preview/pr-1858/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1858/chunks/app-BkYyt4se.js\":\"c88748a5317dc239\",\"/knowledge-medium/pr-preview/pr-1858/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1858/index.js\":\"f92ea42494751ae7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1858/assets/AccessHandlePoolVFS-qUoEO_Zj.js\":\"16fb83e7eccc95ca\",\"/knowledge-medium/pr-preview/pr-1858/assets/IDBBatchAtomicVFS-qCNJGVRE.js\":\"f0dc67ba9f99fd3f\",\"/knowledge-medium/pr-preview/pr-1858/assets/MemoryVFS-sTOowopE.js\":\"8303ca91f4ae3caf\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-3vYLeVVH.js\":\"a02ddd248b461e83\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-async-BVICo-I5.js\":\"a3982fd8b70a6559\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1858/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1858/chunks/AccessHandlePoolVFS-xB1SAIDy.js\":\"72a5f54a4b79f036\",\"/knowledge-medium/pr-preview/pr-1858/chunks/FacadeVFS-Cg6Fiw6p.js\":\"4da0292880025da6\",\"/knowledge-medium/pr-preview/pr-1858/chunks/IDBBatchAtomicVFS-DLDnha70.js\":\"23d755c69429bd92\",\"/knowledge-medium/pr-preview/pr-1858/chunks/MemoryVFS-DZoAJO0d.js\":\"d9232ab38b07ace3\",\"/knowledge-medium/pr-preview/pr-1858/chunks/OPFSCoopSyncVFS-Y_TKD9YG.js\":\"39a4684fad218891\",\"/knowledge-medium/pr-preview/pr-1858/chunks/OPFSWriteAheadVFS-BXtkhRXe.js\":\"d2ce29ddc02dd6df\",\"/knowledge-medium/pr-preview/pr-1858/chunks/Preview-D-_U7d0A.js\":\"8b979aae49280ecf\",\"/knowledge-medium/pr-preview/pr-1858/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1858/chunks/card-dxU4-tPW.js\":\"4be2b1da835c7c5a\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-5gNxMdj2.js\":\"6f4b242c674b0294\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1858/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1858/chunks/mc-wa-sqlite-async-CEgoi9Ur.js\":\"c3aa26642314fc11\",\"/knowledge-medium/pr-preview/pr-1858/chunks/mc-wa-sqlite-jpKCg9Q2.js\":\"65507a44fdc730be\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-1IGq9AQ3.js\":\"e8663da3ac20d8ed\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-BRspcp0R.js\":\"b4c4b693e25b7cdb\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-BV47mGia.js\":\"05ff1a842b840d40\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-BoCLs7nQ.js\":\"d1cad632cddf2b31\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-CNNl6yaq.js\":\"23ee1f6cc3b1ca32\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-CfVbCZ1i.js\":\"1e13f4dae99b355e\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-D-wZN2Ow.js\":\"44f2c6116d095bdf\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-DT9mo7Vr.js\":\"6a634c89032a97a4\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server-legacy.browser.production-CffCOfii.js\":\"702af9f14a39bb4a\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server.browser.production-BZYD4EZY.js\":\"70d8568bc6aa0e3e\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server.edge.production-Aaj04Dwa.js\":\"1711e6653cf09e01\",\"/knowledge-medium/pr-preview/pr-1858/chunks/server.browser-D-SzNdJT.js\":\"ec94ad6c5f5edcee\",\"/knowledge-medium/pr-preview/pr-1858/chunks/textarea-BiCgBMCe.js\":\"fba2cfcd427d2ebe\",\"/knowledge-medium/pr-preview/pr-1858/chunks/ui-BD18mMui.js\":\"96a636baee0570b4\",\"/knowledge-medium/pr-preview/pr-1858/chunks/wa-sqlite-async-gz4viZnp.js\":\"af5d0c9d8d1a5898\",\"/knowledge-medium/pr-preview/pr-1858/chunks/wa-sqlite-dukafiqG.js\":\"0fee3e9d9d76a2a7\",\"/knowledge-medium/pr-preview/pr-1858/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1858/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1858/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1858/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1858/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1858/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1858/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1858/src/App.js\":\"e8c86adb4826147a\",\"/knowledge-medium/pr-preview/pr-1858/src/appUpdate.js\":\"56639b85d47ee96d\",\"/knowledge-medium/pr-preview/pr-1858/src/appVersion.js\":\"48fa115d1a59bf27\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/initialLayout.js\":\"bd49b8a4baf875aa\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/openWorkspaceData.js\":\"cd6499a0bc8bcbcb\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/resolveWorkspace.js\":\"541da073b5d05854\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/workspaceBootstrap.js\":\"abaefc7ff8843111\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockComponent.js\":\"698f25d06adedcb4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockCrumbs.js\":\"7857127aef7b0803\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockEditor.js\":\"4e7917d931a4ffa2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockLoadingPlaceholder.js\":\"04c90f58ce6bd17a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockProperties.js\":\"d9cb8fba98269a21\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockSearchPicker.js\":\"958ee049cfd1766b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ConfirmBulkDeleteDialog.js\":\"b3a2cc4d6fbbb8f6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/DividerHandle.js\":\"d5167d9b27373e6b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/DraftEditor.js\":\"b916e8caba2e3ff1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/GutterPill.js\":\"37b3c6da7e0f1c13\",\"/knowledge-medium/pr-preview/pr-1858/src/components/Header.js\":\"e639c3cfc0dd10f0\",\"/knowledge-medium/pr-preview/pr-1858/src/components/LazyBlockComponent.js\":\"2831d4e61cbbbe6e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/Login.js\":\"fc832bc81d3b8571\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ZoomableSurface.js\":\"7b5c97e0a3e20f03\",\"/knowledge-medium/pr-preview/pr-1858/src/components/editModeKeepalive.js\":\"4d1d04ba19a4142e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyDisplay/PropertyDisplayScope.js\":\"eac68040cf585dae\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"688e37b112e13ddd\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/RefPropertyEditor.js\":\"09856984b92865a1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/RefTargetTypePicker.js\":\"cdd21af90fe3c204\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/SelectPropertyEditor.js\":\"084a55b2ba95ad7c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/TypesPropertyEditor.js\":\"66b30d319234414c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/defaults.js\":\"63910046b0682d30\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/kernelValuePresets.js\":\"7a3f594f379ea904\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/selectablePresets.js\":\"8463210ba9f1911e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/typesPropertyUi.js\":\"299db99111040c7d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/AddPropertyForm.js\":\"36d977df6c953826\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/PropertyPicker.js\":\"2cdf2e8c39a67573\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/PropertyRow.js\":\"2dc2e372314616d2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/Rows.js\":\"1ae0a72c0eddec28\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/actions.js\":\"cac916fba86ae342\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/declarationOnly.js\":\"4d70aa579d69c5ae\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/layout.js\":\"ce08fe8f2640edb0\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/model.js\":\"1e08b45cb9a0aaae\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/shapeUi.js\":\"34c20c92348f3d93\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/shapes.js\":\"d9c409d2cd919372\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/usePropertyEditingActivation.js\":\"3f385e08e0c67b96\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/visibility.js\":\"3f8a51476c210bae\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanelSections.js\":\"a95a8169a1fc50bb\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockEmbed.js\":\"54905b11c93da20c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockLink.js\":\"d1f3ccdd729c5bb1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockRef.js\":\"bd7e3a86b7ffd6e8\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/ReferenceLink.js\":\"ccd176e97b6ef2bc\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/cycleGuard.js\":\"cdc20c635690a0f5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/cycleGuardContext.js\":\"4b5d701283011597\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/linkInteraction.js\":\"379c1050b5be7d53\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/referenceLayout.js\":\"ad35c0f0736718f7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/useBlockRefAncestors.js\":\"f7f6a108ec22d428\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockGutter.js\":\"64ac8f80c58f4ea3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockInfoDialog.js\":\"ff94c7a5ce2551cb\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockTypeBlockRenderer.js\":\"9a395ba847d6eb96\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BulletHoverCard.js\":\"4d108b7b68ca47a1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/CodeMirrorContentRenderer.js\":\"c778f603a591a0de\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4998602430df53f3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/ColumnResizeHandles.js\":\"64ec44906a06608e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1d7f2b8b666cd0e7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/DefaultBlockRenderer.js\":\"b91826a8b020ebc4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/LayoutRenderer.js\":\"31a4fbff34f08138\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/MarkdownContentRenderer.js\":\"9d14cdc547fc5c6a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/MissingDataRenderer.js\":\"0abed28a5c366ad7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/PanelRenderer.js\":\"85b56f7210fa1cc2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/PropertySchemaBlockRenderer.js\":\"49322f5b97e5ce18\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/TopLevelRenderer.js\":\"c7425f27b13a7d9a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/blockGutterMode.js\":\"89d1676bbd1b4cdd\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/blockTitleText.js\":\"63504148a5753f7c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/fieldCreationKeydown.js\":\"a7623491ba6f8c33\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/layoutRootContext.js\":\"dc6d6c6c4dd77f4a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/typeChip/TypeChip.js\":\"96756e4ab960d756\",\"/knowledge-medium/pr-preview/pr-1858/src/components/typeChip/chipStyle.js\":\"f0b7eda07db1c0c6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/anchored-floating.js\":\"8ffae6ee6fde12c4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/button.js\":\"165c74b6f09e1994\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/card.js\":\"10675bcb166b926b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/checkbox.js\":\"bf82a19c070c35f2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/collapsible.js\":\"b32b27a33a77d355\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/command.js\":\"f35e5e178f4c8d7a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/context-menu.js\":\"8d90cb12f9fd6780\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/dialog.js\":\"80ebc027b1769e36\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/dropdown-menu.js\":\"19ba87773ae7933c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/floating-listbox.js\":\"0143747ed62bf29c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/index.js\":\"83903762a60c9d52\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/input.js\":\"4ef1893ae4d09821\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/kbd.js\":\"8f9531463a402de1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/label.js\":\"ee9f5c84eb657e41\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/textarea.js\":\"32770cebc5c5260f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/useEditModeYieldKeepalive.js\":\"ffc24a0f030a7e39\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/BootFallback.js\":\"c4ffede36c0ee598\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/FocusedRowLazyMount.js\":\"18d36dcb2c0502d6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/LazyViewportMount.js\":\"40a7ad35d2f34d0f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/LocalDbCorruptionFallback.js\":\"d7f274ea2f35f36d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/error.js\":\"cf8c880d06536248\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/lazyMountRegistry.js\":\"0a519b06a9919b17\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/suspense.js\":\"9aaa60e49de510c9\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/CreateWorkspaceDialog.js\":\"57329f59413c19c1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/PendingInvitations.js\":\"abe9c533dcc02ce9\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/SyncProgress.js\":\"96cc8437847d6be5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/UnlockProgress.js\":\"572023e91b8226b6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceKeyGate.js\":\"f8dd81e6859ca6bb\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSettingsDialog.js\":\"e694cecfe63f74b5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSwitcher.js\":\"d2372738a39a9879\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSyncGate.js\":\"ac87eb7b83690c6d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/ConversionFlow.js\":\"8ff1331fec71207c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/ConversionFlowHost.js\":\"ffc5ba3966f426e7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/EncryptionSection.js\":\"a6405c960ef6f8a3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/attachmentPrompts.js\":\"e6b3daa1dd14d4ad\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/bundleFolderPrompts.js\":\"49f3a675b0463a2a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/conversionFlowDeps.js\":\"14d1694f3589629f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/conversionFlowStore.js\":\"5de2fe59104b621d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/flowUi.js\":\"f4841d386d306095\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/useConversionRun.js\":\"f22321975320b54a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/keyUi.js\":\"2f738dcd58f7ab1f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/useCloseOnKeyLoss.js\":\"97f1ed33946ecdfe\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/useCloseOnServerE2ee.js\":\"5b99eddf68cb85ff\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/workspaceUnlocked.js\":\"36d631bb0f76ef89\",\"/knowledge-medium/pr-preview/pr-1858/src/context/backgroundSubtree.js\":\"d8d1081e3aab32d0\",\"/knowledge-medium/pr-preview/pr-1858/src/context/block.js\":\"ec16e584a4d863c2\",\"/knowledge-medium/pr-preview/pr-1858/src/context/layoutWsContext.js\":\"724984bdaf9a6afa\",\"/knowledge-medium/pr-preview/pr-1858/src/context/propertyDisplay.js\":\"c0cce1375b165a73\",\"/knowledge-medium/pr-preview/pr-1858/src/context/repo.js\":\"4ce012d66edf0d4c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/aliasClaim.js\":\"0da9810c250f7b03\",\"/knowledge-medium/pr-preview/pr-1858/src/data/aliasSeatNamespace.js\":\"725aacd5449300d4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/blockData.js\":\"d716b8481b904284\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/blockType.js\":\"2a57bdb0255dd713\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/changeScope.js\":\"a1a2d59bee58dc2f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/codecs.js\":\"f97b2ed18fd71104\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/derivedData.js\":\"d217380da9a55e3d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/errors.js\":\"a993f39c087ce13a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/events.js\":\"e4aa2ba9d5faabb1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/handle.js\":\"28629d7ecd9edaca\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/index.js\":\"d8278eafd0103f64\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/mutator.js\":\"2601be5792dfd941\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/processor.js\":\"7a92f6d1a1e66f49\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/propertySchema.js\":\"78b6bc4a772563db\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/query.js\":\"5dd4aba5e30eb3b8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/sameTxProcessor.js\":\"7bb3f96d18a5df0a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/schema.js\":\"28629d7ecd9edaca\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/tx.js\":\"28629d7ecd9edaca\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/typedBlockQuery.js\":\"21aa4e7537e8d02d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/user.js\":\"86ce7d7f10041b1d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/valuePresetCore.js\":\"34b645f0272adf9f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/valuePresets.js\":\"9b36a0760e686ed8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/attachmentCleanerIOVerb.js\":\"ae009eb1721073dd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/block.js\":\"120eee5acb8a9480\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockCache.js\":\"3fab599c8e54e263\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockId.js\":\"5223dbf1147eda1c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockLiveness.js\":\"7f3b1f87db88ff70\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockMerge.js\":\"e171d0a6f5d85c32\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockSchema.js\":\"9576ca301bfcd2b2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockTypeLookup.js\":\"11425f06856ce406\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockTypes.js\":\"d7ce168f877b83cd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/childrenView.js\":\"c1d64b0a9f8727f6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/clientContext.js\":\"82fc5bad35a639b1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/dbFileSiblings.js\":\"9c9ce18eb9c2258c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/definitionSeeds.js\":\"0ef6df7e0f28eab0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/derivedIds.js\":\"cabd80bd696fe964\",\"/knowledge-medium/pr-preview/pr-1858/src/data/drawnSubtree.js\":\"2f6a337cd03d879d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/facetBridge.js\":\"4dd7484ffd199bad\",\"/knowledge-medium/pr-preview/pr-1858/src/data/facets.js\":\"942ddc0e50d0fe66\",\"/knowledge-medium/pr-preview/pr-1858/src/data/globalState.js\":\"dafac0e61f703579\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/aliasClaimRederiveProcessor.js\":\"8c87bdfec9127a60\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/ancestorBatch.js\":\"89b17c8d743957a2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/blockTypeTypeifyProcessor.js\":\"98f423e59dd4a13b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/clientSchema.js\":\"045fd81f04758caa\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/commitPipeline.js\":\"e0c160c1c69b884a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/devAssertions.js\":\"fc4dfc33fb852758\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/firstSync.js\":\"8bbfe1fe58c82f38\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/freshInitialLoad.js\":\"12a7abf98445aa37\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/graphBackfillClaim.js\":\"5566c5cb630bef73\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/handleStore.js\":\"e5eb5267d125f37e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/idleMarkerJobs.js\":\"66f644dd979af46c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/initialDownload.js\":\"bd19e7998522feb3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/initializeClientDatabase.js\":\"9efcdd717e075965\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/jsonCanonical.js\":\"af8541b2eb7523a2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelInvalidation.js\":\"61283a09ab40f0ce\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelProcessors.js\":\"89ee3c7fd9f76d1d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelQueries.js\":\"c6b108613e2929a8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/mergeTypeMembershipProcessor.js\":\"f5734d53a6ed20ef\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/normalizeReferencesProcessor.js\":\"b28c9c3954fec4f8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/poolInstrumentation.js\":\"7a44b93f03c13bd5\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/processorRunner.js\":\"0fdbcb16498b9c7e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyCellBackfill.js\":\"9127479293e24650\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyChildMint.js\":\"3427aa053b0c3335\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyChildrenProcessor.js\":\"73a3ae365f1b5f1c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyDefinitionChangeProcessor.js\":\"abd046d06f94ea00\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyDefinitionSynthesis.js\":\"266e988206e1ae17\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyKeyScan.js\":\"72fc645729fc1ecf\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertySchemaResolution.js\":\"46593ea7eb88dce7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyValueEdits.js\":\"59af8deb1d34be66\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/raiseProtocol.js\":\"1b9390356fd4b33a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/readBatch.js\":\"cdefc38744be6cb5\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/refProjection.js\":\"a5fd583532d87dc3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/referenceTargetLookups.js\":\"5011b61b1fcfa6e7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/referenceTargetProcessor.js\":\"1331203fdf3b9c7a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/replayMerge.js\":\"c857c128b507c55d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/sqlBinds.js\":\"ec3c7be06d595418\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c8478355896d8b76\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/arrivalProcessors.js\":\"923a79caf4c2f8d2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/invalidate.js\":\"95ce473994a828e2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/materialize.js\":\"1c3a50dc0672057f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/observer.js\":\"5f6bd609d707934e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/reconcile.js\":\"595fc86795e4c53e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/timingMetrics.js\":\"96a0ebd9f4fe823f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/treeQueries.js\":\"465628ef8249ced4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/txEngine.js\":\"d227eb1d71056bb1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/txSnapshots.js\":\"faa30099698537ca\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/typedBlockQuery.js\":\"831acb2902d1905a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/undoManager.js\":\"7295e927a153f04e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/invalidation.js\":\"a6d18c68b04a0d56\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelDataExtension.js\":\"84ddf2cc1712fe33\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelPage.js\":\"9a1c1fb08e5c68bc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelValuePresetCores.js\":\"dc199bd3d7a8d330\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbCorruptionSignal.js\":\"abcd7e04d1e7d74e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbStorage.js\":\"0524d85eb8a40149\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbVfs.js\":\"bf9399bc1d11c684\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localSchema.js\":\"75f96e988ddd1163\",\"/knowledge-medium/pr-preview/pr-1858/src/data/maintenance.js\":\"b5708e4541911f80\",\"/knowledge-medium/pr-preview/pr-1858/src/data/mergeProperties.js\":\"c051914a355dda41\",\"/knowledge-medium/pr-preview/pr-1858/src/data/metricsConsoleHook.js\":\"9127c48ecdcbdb90\",\"/knowledge-medium/pr-preview/pr-1858/src/data/migrationsPage.js\":\"6f085be53ab84f2b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/mutators.js\":\"df3e974687456ffe\",\"/knowledge-medium/pr-preview/pr-1858/src/data/orderKey.js\":\"15249061236be639\",\"/knowledge-medium/pr-preview/pr-1858/src/data/orderKeyPlacement.js\":\"2de82ad741022036\",\"/knowledge-medium/pr-preview/pr-1858/src/data/outlineSurface.js\":\"490f79008238696c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pendingEditorContent.js\":\"400256b3737546d1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pendingUploadsSql.js\":\"87c38c4f9044d674\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pluginStateExtensions.js\":\"2d318a3971e5e1d6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/powerSyncLogger.js\":\"10178308486cc88f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/projectorRuntime.js\":\"d206f317ed3bd93f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/properties.js\":\"ca1c7171b3ac4c7a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertiesPage.js\":\"bac8296faa771469\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyChildren.js\":\"297df11c8184b03f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionFanout.js\":\"5be347dfa95ae198\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionMetadata.js\":\"2f4e6e1dd8ffda45\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionRegistry.js\":\"018b6516c4bb4466\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDisplayMode.js\":\"ac73abda91847425\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyRowCreation.js\":\"21743ba45122f0ec\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertySchemaCreation.js\":\"2ff6d54030c78311\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertySeeds.js\":\"3fe35cdaa31de921\",\"/knowledge-medium/pr-preview/pr-1858/src/data/recentsPage.js\":\"93ad16b57a3bd709\",\"/knowledge-medium/pr-preview/pr-1858/src/data/referenceBlock.js\":\"5511c36eb155862d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/rejectedUploads.js\":\"f98615bd8c04d4de\",\"/knowledge-medium/pr-preview/pr-1858/src/data/releasePowerSyncConnection.js\":\"ed568f32fb2e2c5a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/repo.js\":\"3c4a9d0d0ba5d748\",\"/knowledge-medium/pr-preview/pr-1858/src/data/repoProvider.js\":\"74f090432a81d018\",\"/knowledge-medium/pr-preview/pr-1858/src/data/rowProperty.js\":\"1ca21a2ef3f606d0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/searchFilter.js\":\"a72dfc298d92a186\",\"/knowledge-medium/pr-preview/pr-1858/src/data/seedIdentityLedger.js\":\"47ea2bdfea8d5aca\",\"/knowledge-medium/pr-preview/pr-1858/src/data/stateBlocks.js\":\"64f7f9f9a1127b30\",\"/knowledge-medium/pr-preview/pr-1858/src/data/structuralEditPolicy.js\":\"a313ea5aabef9bd1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/subtreeDelete.js\":\"b9a7c7f9315bfaee\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncStreamLock.js\":\"b794987d8aaec128\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncedTableSqlRecognizer.js\":\"498d3cb9277d3fcd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncedTableWriteGuard.js\":\"d43368ecf608f402\",\"/knowledge-medium/pr-preview/pr-1858/src/data/targets.js\":\"af0e46ecfcc557cf\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeColors.js\":\"ef1a5e67d6074700\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeDefinitionMetadata.js\":\"b6638bab6533b5eb\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeDefinitionRegistry.js\":\"82e21a714eb9fe04\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeExtraction.js\":\"61cce373e1a21a04\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeInitialValues.js\":\"b9666b4e1f6a26b1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typePropertyGroups.js\":\"6953df2759d69117\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeSeeds.js\":\"ae700c5fd99ff49a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeTagger.js\":\"3d8a0a3842c12bb1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typedRecords.js\":\"c00e96cb228dbdcc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typesPage.js\":\"ffe7133672cddf83\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userPrefs.js\":\"05ec8c56f8d99a49\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userSchemasService.js\":\"49951ce24508438d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userTypesService.js\":\"0c43b03f374cda29\",\"/knowledge-medium/pr-preview/pr-1858/src/data/valuePresetRegistry.js\":\"22e171dd3ebac8e6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/visibleChildren.js\":\"2a2bc38fea500a7f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceConversion.js\":\"9891b6423dc6d49f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceFirstSync.js\":\"8d2207d5a9c14021\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceIdNamespace.js\":\"3da9d9c058e45cd1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceSchema.js\":\"5f26e5cc9c6f8cc7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaces.js\":\"6aa5faaf27dce1ad\",\"/knowledge-medium/pr-preview/pr-1858/src/data/writeAheadLog.js\":\"091b6a73af49b982\",\"/knowledge-medium/pr-preview/pr-1858/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/BlockPasteShellDecorator.js\":\"ba039b9ba7c42fe7\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/atTrigger.js\":\"4352152043df5ff2\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/autocomplete.js\":\"939f759307c57687\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/codeMirrorExtensions.js\":\"39c2f1b4d0249a0d\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/contentFlush.js\":\"abef9f1a6cee7c7a\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/defaultInteractions.js\":\"d4a33d3c55bb869a\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/editSettleSignal.js\":\"01adbda3aeb5ec6a\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/insertImage.js\":\"d47710d3f01f65bc\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/referenceCompletionRange.js\":\"f5c9c6a1ba2c33e1\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/referenceTargetTypes.js\":\"6694ea5d8d5b1685\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/syntaxContext.js\":\"200ab6db596cddde\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/triggerMatch.js\":\"6d7a789faf6a06d7\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/AppRuntimeProvider.js\":\"a37e307305cfe392\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/BlockFocusShellDecorator.js\":\"6c1da1b457cac761\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/ExtensionRenderBoundary.js\":\"df0600e3581557de\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/PanelContentRecovery.js\":\"f1372d5a89e4f177\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/apiCatalog.js\":\"4da8dd71ef55ff93\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/approveExtensionHere.js\":\"4c44178b57e493da\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/armedCutAppMount.js\":\"16c5fe6591e3ec59\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/batchableKeyedStore.js\":\"6a88e38c1ac8cfdf\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/blockInteraction.js\":\"8c70de692217db44\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/blockSelectionAction.js\":\"392decd4e616cb41\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/compileExtensionModule.js\":\"25c547b4c19e685b\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/compiledModuleCache.js\":\"d4b35c522fc2878a\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/continuousGestures.js\":\"80d2e49ee4cf6ddf\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/core.js\":\"95445254a207a8ba\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/defaultRenderers.js\":\"aa9ed863230a3b8f\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/definitionFanoutAppMount.js\":\"eaca51b469a21c8d\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dialogAppMount.js\":\"1d384b5f74ea07a9\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dynamicExtensionSeeds.js\":\"35f9dc831a3e9cb6\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dynamicExtensions.js\":\"4ca772f70e78c023\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/exampleExtensions.js\":\"583538ee723c9367\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionApprovalStatus.js\":\"9c0c21a8498b1319\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLoadErrorToast.js\":\"95862a7e748c1ab1\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLoadErrors.js\":\"7e817574b6f746e2\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLookup.js\":\"06f123c1b716db4e\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionToggles.js\":\"436b96dc51c62c6d\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionUtilitiesCss.js\":\"e2ca7d3b1705f6b2\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/kernelPageDeletionGuard.js\":\"5fd058e8fa2b8e9e\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/liveRuntime.js\":\"66748d5fc29ca9ea\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/openExtensionsSettings.js\":\"169b2bb2b3ea0005\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/overridesCache.js\":\"76f9f79bf5cb4fb5\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/pluginIds.js\":\"0aa2a829177e735c\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/processorRejectionToast.js\":\"81f6288e4d542e3d\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/runtimeActions.js\":\"ab3f5314b102f871\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/runtimeContext.js\":\"910d52e04ed0788e\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/staticAppExtensions.js\":\"c896dc4d7d62e3d9\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/staticDataExtensions.js\":\"f8a3e66e3c1dcc5f\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/toastAppMount.js\":\"7a76482882965248\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/useOverrides.js\":\"ec6abcbd5b2066ab\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/useShortcutSurfaceActivations.js\":\"d1bc1fc0cd400ed5\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/discoverToggleTree.js\":\"728d95f9e7d725ba\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/facet.js\":\"19e0b794b28502a1\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/resolveAppRuntime.js\":\"b210483fefbffccc\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/runtimeEvents.js\":\"89cbb9ce52799449\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/togglable.js\":\"a4cf032a5515bb0a\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/variantFacet.js\":\"f38058312919c169\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/verbFacet.js\":\"6c2f4d45d7d49e17\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/block.js\":\"c964b6c4e931eb53\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/focusedChild.js\":\"34c4635cf7b78155\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/propertySchemas.js\":\"23fe30650cba6cb8\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/typeRegistry.js\":\"a16b41496efe7720\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useAncestorCrumbs.js\":\"5cc9e54edae83768\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useAutocompleteListbox.js\":\"2d38cc5df03f9c5b\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useDebouncedSearch.js\":\"24da3138eb7b6aa9\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useDebouncedValue.js\":\"ce93539ff8d4fd20\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useIsFocalRender.js\":\"d24a4bbdc5d0136d\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useIsReadOnly.js\":\"bc83abda6c80c03a\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useMaterializeBacklog.js\":\"92481b2897839fcd\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useMinuteClock.js\":\"5a900cebe28f82c9\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/usePanelLayoutProjection.js\":\"fdea373e756c315a\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/usePendingInvitations.js\":\"56136de8e8221ac3\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useRendererRegistry.js\":\"0dece6f7026bbd31\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useRetainedFieldRows.js\":\"00779a65b60d0b5d\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useWorkspaces.js\":\"8e3ec4cae52ed337\",\"/knowledge-medium/pr-preview/pr-1858/src/lib/utils.js\":\"8b412201522b7a7e\",\"/knowledge-medium/pr-preview/pr-1858/src/main.js\":\"7fcaa40414da69c0\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/MarkdownImage.js\":\"f291bc9488b9d583\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/blockSeparators.js\":\"ead751bcf04f6363\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/context.js\":\"c4bbfd0c220dce41\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/defaultMarkdownExtension.js\":\"1a4aacd87df7a43f\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/extensions.js\":\"982187627c4af1be\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/renderMarkdownHtml.js\":\"76ecbd7f2b2ffc74\",\"/knowledge-medium/pr-preview/pr-1858/src/minimal-editor.js\":\"36c235524fe3be54\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/armedCut.js\":\"2468eb7f26664d88\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/captureMediaVerb.js\":\"819b93a53245a433\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/clipboard.js\":\"6a69b06d641480c6\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/decision.js\":\"6ef79aacb9b63c65\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/operations.js\":\"7ef1a0ec2dae16d2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/account-header/AccountHeaderItem.js\":\"57ea45a22ce0a261\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/account-header/index.js\":\"fb5da98381fff13f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"647b5bccc859ce19\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/askAgent.js\":\"b674c3ccdefd854f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/askedStore.js\":\"34f161e7f24c1778\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"45b6e8c739cd7c54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/chipState.js\":\"c57cc3c56a0e72c2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/dataExtension.js\":\"43895fa0c3beb409\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/index.js\":\"cb1892b917e00c2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"38e69cd86d03fe13\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/schema.js\":\"09c56c6f8a0f427e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/AgentTokensDialog.js\":\"09ec540f2c1c4a68\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0553f609e58c5734\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/addMedia.js\":\"391901f8fdc99cf0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7922d21222603189\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/block.js\":\"91e4f98dc6051a54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/context.js\":\"0ecdc1c6d6f31c94\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/displayIds.js\":\"98a9c80ce7b482b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/index.js\":\"0bb422bc27acd0c6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/outline.js\":\"8d5cb9098f5fba9b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/properties.js\":\"91292b7227090cac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/refs.js\":\"45c8b42c85cfdd6a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f0483860e648f6a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/search.js\":\"15c20ba51dc72d29\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/shared.js\":\"ba68b2712eeee9eb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"759b7d31684638a2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/text.js\":\"6f67fb2913040255\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentWrites.js\":\"b702d7e35e0f118d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/authoringCatalog.js\":\"55ac6ea19919e38e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/blockRefTargets.js\":\"46eb6fe1af61c9b7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/bridge.js\":\"5a746def65a591ca\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/bridgeLoop.js\":\"023eef441ed50264\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/changeHistory.js\":\"838f3a37c8782b55\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/commands.js\":\"d40d20e4e1ac24e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/commentsCommands.js\":\"c5966ccddc2ce626\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/dataExtension.js\":\"21e3b37d61046fe7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/dataModelGuide.js\":\"04be8ba5da5e9563\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/describeRuntime.js\":\"686fd3ba88e4bdf9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/extensionLint.js\":\"568ff1a7ac92916e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/grainAudit.js\":\"733c8a7684810680\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/healthCommand.js\":\"69c5e667af9ba3fc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/index.js\":\"b75e159bba9ad0a5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/presetIdentity.js\":\"511511f7601cac1d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7d8c9ccd6d3ae019\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/readMedia.js\":\"1754b364ddfd013a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/schema.js\":\"0d6c611979e54fee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/serialization.js\":\"fa25d47ef722df5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/targets.js\":\"8b5e5d9d398376df\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/tokens.js\":\"d7b10e2a1a65d8c7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/watchEvents.js\":\"627f200add709c64\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/workspaceGuard.js\":\"13e76ba55b277def\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/writeCommands.js\":\"5d32f8c88bc87c7c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/AliasCollisionToast.js\":\"414cd8ded24188d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/DuplicateNameBanner.js\":\"2a6dc40d09e45ce5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/collisionMerge.js\":\"0f705c122f2732ad\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/dataExtension.js\":\"13b9e0f5f8c17440\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/index.js\":\"58f79d1724253b61\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/mergeCollisionAction.js\":\"b0940e3e20f6dc80\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/pageStyling.js\":\"bb6de30f7e0caeef\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/rejectionToast.js\":\"3f4701b8187de69e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/syncProcessor.js\":\"7908796b84f203ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/actions.js\":\"12327150e1332a9b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/addComment.js\":\"64161ade647f7878\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/anchor.js\":\"426331c28ed413ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/anchorState.js\":\"2e0ca46897a2d2c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/commentLinks.js\":\"93c83b582d5ead24\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/confirmThreadDeletion.js\":\"afa915315effd1cc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/container.js\":\"949e6bdacc4ad47c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/dataExtension.js\":\"b3d5dc7206f499cd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/deleteComment.js\":\"e6add0a20fcb0a01\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/highlights.js\":\"c5be02582a81bb85\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/index.js\":\"14cc93c7145b9234\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/linkedCommentsPill.js\":\"519b7280847b4198\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/margin.js\":\"cd876bf5fdbb1d08\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/marginSchema.js\":\"d58a8e17eee62a36\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/newComment.js\":\"2bc77035267f6c8a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/ownThreadPicker.js\":\"9fb274613761b525\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/placement.js\":\"d0ae8bd7708ef6e6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/queries.js\":\"35738b3254b255dc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotePosition.js\":\"adb1b737b86f0731\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotedIn.js\":\"44b5632f3ba52b2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotedRange.js\":\"8b9e3e4c7cf6a6b3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/rangeRefs.js\":\"eb081e162eb87d15\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readHighlights.js\":\"3cb62b53f0697efd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readSelection.js\":\"618f2de426b573a3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readSelectionUi.js\":\"77aeeaaa2dee5c03\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/reanchor.js\":\"efb871b457ac7a25\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/schema.js\":\"5de433d1df173df2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/scope.js\":\"0e57d8a978b62237\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/scopeThreads.js\":\"febbadb92625f64a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/splitRetarget.js\":\"beb5407a3d9b4469\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/suggestionCard.js\":\"8d79759d86d9698c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/suggestions.js\":\"dec3312a9fbf950a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/summaries.js\":\"e5ea9379d323f2fe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/summaryBatch.js\":\"896340eb26cefa7b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/surface.js\":\"43362ebe702f9982\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/threadNavigation.js\":\"2adc8d9380d9ef96\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/threads.js\":\"97fe4084ed0c440b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/ui.js\":\"54d522dccd472169\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/uiStore.js\":\"fcfae5b097d7213e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-intents/appIntents.js\":\"b26fac3e1732d282\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-intents/index.js\":\"6568512127a7d069\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-update-prompt/index.js\":\"77fd241f4edfea10\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-update-prompt/status.js\":\"6928ecba9d5433b1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"140aadfa39bea87c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaBlockRenderer.js\":\"61850a7a4f0ed825\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e1ad561eabf26622\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaUploadReconciler.js\":\"18a2afd1b66c883b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetDownLane.js\":\"7e9ab52f9ec286d4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetResolver.js\":\"c51dbade9ecb9e13\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetUpload.js\":\"6751c3746962bd04\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/attachmentCleanerIO.js\":\"a5bdff0d4e6f7907\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/supabaseAuditIO.js\":\"9b0b80df8304f91d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/blobStore.js\":\"3e10da8a962d2284\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/browserMedia.js\":\"009d7c15eaf3cded\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/byteStore.js\":\"32fbfdc4c1753403\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/cleanerIO.js\":\"ec8f76d4fecc6139\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/cleanupAttachments.js\":\"199eafa27444ea17\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/dataExtension.js\":\"dd74955cd5b7d903\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/downLane.js\":\"0ecefcd47c3069f1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/index.js\":\"a7b4f99faa8ded9b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/insertImageContribution.js\":\"72857c3160419903\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/laneArming.js\":\"465931ffbf477e1d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/laneLock.js\":\"d64af9ad185cb107\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaBlock.js\":\"29829764b9f471fe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaCapture.js\":\"07b64f21b55b5589\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaLanes.js\":\"c3e8023e1b2726ff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaViewers.js\":\"6d7ef8815eaff510\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaViewersFacet.js\":\"d5ac25703e1aa551\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/pasteCapture.js\":\"46860fe01b104d4f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/resolver.js\":\"1650951f9c3a7998\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/retryUploadsAction.js\":\"6b925819a19874d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/storagePaths.js\":\"88859281da294e05\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadDrain.js\":\"9c5c29b7b598cc33\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadLaneStatus.js\":\"e41580fd12c5ede1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadReconcile.js\":\"bef78ac405ae01c6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadRecovery.js\":\"969d876301a6801c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadStore.js\":\"a313e8f8fd5d828b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/useAssetObjectUrl.js\":\"034f5ab56a2119e2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d4e578a27a3b2c28\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c614c096ba9d6e36\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/facet.js\":\"cfef95beae31a0e2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/index.js\":\"5721452209a7c8a9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/prop.js\":\"d8506a0b5fcb48f3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BacklinkFilters.js\":\"f6172039f2643816\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"841790b7eed8a678\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BlockEntry.js\":\"1e593c5c4ef848d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/LinkedReferences.js\":\"dfe04eb411f0b698\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5382f7be622acb75\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/dailyNoteDefaults.js\":\"b3df9fdce65168e6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/dataExtension.js\":\"6598ff5cd7906653\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/edgeExclusions.js\":\"e6b472665fddcd54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/filterProperty.js\":\"bf0e39c6742db899\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/index.js\":\"5a5caeb7734e8562\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b6079e1e0f06a57c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/applies.js\":\"03135b7a2d1f930e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/countQuery.js\":\"7fc6919c50a5cad5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1b4cf55a516645cc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/index.js\":\"073a65417bf4f245\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0f797ebc68f4ac67\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/presentationInvalidation.js\":\"afaf88b9951235be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/propertyEditorOverride.js\":\"52f5134d64ede450\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/propertyFilter.js\":\"f0d238bf9e17112e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/query.js\":\"6cb7203bbc350eda\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/resolveFilter.js\":\"4ae2c5da84029fd3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/sourceBatch.js\":\"7cf2d3ec864e6aa9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/sources.js\":\"f9d3613dc7d39bee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/useBacklinks.js\":\"7e1f04cf59e7b9c1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"dd663f7d857a242e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/BirthdayCelebration.js\":\"0e7953db2e6ab057\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/BirthdayOverlay.js\":\"95acceaf917e62c0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/gate.js\":\"123336c76a4e51d5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/index.js\":\"7155e3e595c59d64\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/wolfTheme.js\":\"98c658cea2abae2b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/BlockDragLayer.js\":\"8f7fee14a3816bb6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/dragController.js\":\"f4a1d750cbf6669e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/dropTarget.js\":\"b8fa0d5446d1741c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/index.js\":\"ce4d5595aa4df279\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/projection.js\":\"e515a953f289abad\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-info/BlockMetaCard.js\":\"47015f24eb076ecb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-info/index.js\":\"73a60cc18d0e7a45\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/AddTagDialog.js\":\"967c80bed7923c2b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1914d072f4b96b2b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/TagNameIssueHint.js\":\"f97a052d569d8b99\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/addTagAction.js\":\"fd1c06bf35fb7218\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/appendTag.js\":\"41ffb9d53a5e11ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/config.js\":\"54c8460c35577245\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/dataExtension.js\":\"154bd62f66191133\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/index.js\":\"2ab5764197ad1b11\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/propertyEditorOverride.js\":\"2db06ec49a5f3d24\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/BreadcrumbList.js\":\"12734213ac810f66\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c9ecbedd47dc44ed\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a71e5f1658c4b0ed\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6b36c6fb7e7c170f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c2cd0f03e8613d66\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/index.js\":\"6331122d0aadb2e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e269552175894025\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/CharacterCountItem.js\":\"d41e5ccfefbbdd5c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/ProfilePropertyEditor.js\":\"df90bb36dfcb629c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/actions.js\":\"543588b5d63ddde8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/blockType.js\":\"2ed5cf89c814c46c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/charCount.js\":\"f7e4412e41ae69c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/dataExtension.js\":\"b29e36c02b1288e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/index.js\":\"571e0fa7e851c314\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/profiles.js\":\"9a99cae86015169b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/properties.js\":\"3b74545343bf2c87\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/textCounts.js\":\"f9448b35a82409f8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/colemak-keybindings/index.js\":\"d49f344c9345a1cf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/CommandPalette.js\":\"81cd29272b6f980e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/HeaderItem.js\":\"8ba35b04b11cafff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/context.js\":\"d969a52baa789df5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/index.js\":\"6d9c5d75f08170be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/selection.js\":\"d65d6f2c46c6c11b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/toggleStore.js\":\"015e4cf892c5fc9c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/useCommandPaletteActions.js\":\"f732b30b49aee07b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/ContributorBadges.js\":\"bdd1d6e62fc25496\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/author.js\":\"348a88a831e30900\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/codeMirrorExtensions.js\":\"17e6dc7b7b593139\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/dataExtension.js\":\"75df395c876ed334\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/index.js\":\"353b651c7d31f3dc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/mentionAutocomplete.js\":\"1a7bed607d18b382\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/processor.js\":\"d24d50faae00dccc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/profiles.js\":\"e3ab53495f419120\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/queries.js\":\"fee42535028e9832\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/schema.js\":\"c88c0f373a33a547\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a0244129ac429293\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/followOrigin.js\":\"dc7af40e2d8e044e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/index.js\":\"9f3b170faa271ad4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d3de230bad62b75f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b288ccb39de031b7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/CalendarGrid.js\":\"793eb2ce512e63ee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DailyNotePicker.js\":\"dabe9fb8ee52ab82\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"41e016edacbad59c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateNavDecorator.js\":\"1728ad193342e235\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateScrubOverlay.js\":\"423cdef209d5af23\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/HeaderItem.js\":\"3b5db854d52abb06\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/ReschedulePicker.js\":\"4f9e05785202cef1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/SpreadDatesDialog.js\":\"be26c4879fa91896\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/actions.js\":\"1ab9454952760d8f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/blockDateAdapter.js\":\"1ec9ad9164fa7eb2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/calendar.js\":\"6c2518e48b09cc2b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dailyNotes.js\":\"5050de99840a1997\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dataExtension.js\":\"626e15c1560c7d93\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubActions.js\":\"f3588a5dbcfb88e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubGesture.js\":\"442ed85cf2e46297\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubGestureActions.js\":\"14d7f15751ba6a5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8f26ec66d8060f6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/deletionGuard.js\":\"88af9f05fb805877\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dueQuery.js\":\"3b26efb1a157f46a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/index.js\":\"51dbc5932986e9da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/landing.js\":\"5973ad951ed4d9dd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/localSchema.js\":\"47128c3123d58147\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/referenceDateAdapter.js\":\"ec09d2e18f66c1f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/rescheduleAction.js\":\"52508b9f7f2dfc80\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/schema.js\":\"dbc8ee2d823d731e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/spreadBlockDates.js\":\"cb3fce663ffe3855\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/spreadDatesAction.js\":\"e44b212fa987e967\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/today.js\":\"75cbed8fd72fcfe9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"56f26ae900bb9b65\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f9ed3d7d98e2a00b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/audit.js\":\"11da3c4605ead85c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/auditAction.js\":\"82cf415daedd7d19\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/auditRanges.js\":\"65506e3df6c15c16\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/diagnosticsSource.js\":\"02847525f386662b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/divergenceScan.js\":\"c1286d9446d0e849\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/index.js\":\"04b1227c64b2053c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7f4eb6e4a50e20b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/referencesMirror.js\":\"9afc3bd840e23c99\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/rowJson.js\":\"538b46060cd39eb4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/schedule.js\":\"f43442b007e79fa8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/store.js\":\"a9699ac304d2ad16\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/action.js\":\"fba8fef923637602\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/index.js\":\"edf5a497b8bcd474\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/plugin.js\":\"76ea0d9b30162742\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ac1de19de4617296\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/actions.js\":\"015c816922501005\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/changeMarker.js\":\"5c084df1eb830da9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/diagnostics.js\":\"f4f3d75da6b55848\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/fileSystemAccess.js\":\"a17b08362ecd4c89\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/filenames.js\":\"5232214048c02b78\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/index.js\":\"01b4d14d51e4f203\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/mirror.js\":\"076e8cc012109594\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/runLock.js\":\"4f0b6864217083f9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/runtimeHealth.js\":\"9945bd5f935c1cb2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/schedule.js\":\"33eb83b6d5b13550\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/store.js\":\"b3db504f10fbafa5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/default-themes/index.js\":\"8aaf59a63900b956\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/default-themes/themes.js\":\"e9a17513ed0c999a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/diagnostics/facet.js\":\"637cf58630ad3b18\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/diagnostics/useDiagnostics.js\":\"951162fba4cd0fa3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/dismissals.js\":\"644ee2a2d4db767c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/index.js\":\"c40938e62f443dc1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/status.js\":\"df55e8759479d490\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/store.js\":\"c5a547b07db17259\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"49ad37f03d39d00e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a627e8e9b18422c1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/actions.js\":\"0b6289ba0b56dae0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/config.js\":\"c4e6099dc36411ab\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/dataExtension.js\":\"d1b0eed917f2556d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/effect.js\":\"de4512b8c5a31e2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/index.js\":\"754690f89c129c67\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/propertyEditorOverride.js\":\"499d308f26ae4b7f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/useToggleTree.js\":\"ac814635aca5e4bc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/ExtractTypeDialog.js\":\"d5e60da7d55de824\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"720f115a967d9a14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/PropertyShapePicker.js\":\"209e0c4167908170\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/action.js\":\"80a75b4036b2dc3d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/index.js\":\"bff3bedcdc4cd55d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/FindReplaceDialog.js\":\"6a2a029d452e4fd4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/HeaderItem.js\":\"89e51c794ab10617\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/dataExtension.js\":\"91e6b1d6f6ec62b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/index.js\":\"aee1a45966a51292\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/search.js\":\"270fccc36121a3f4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/toggleStore.js\":\"bdef648562a710a5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/LocationPropertyEditor.js\":\"2dea0a7825b431b0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/MapView.js\":\"fd87855f758a717c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/blockTypes.js\":\"e9fb524b7f270ab2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/codeMirrorExtensions.js\":\"45a54e7c0af7e3de\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/createOrFindPlace.js\":\"712f1097d04e62a1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/currentLocation.js\":\"384574f4955f7eaa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/dataExtension.js\":\"5943958187b84402\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/geoContentDecorator.js\":\"599d7361df46c245\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/googlePlacesClient.js\":\"72eb1a252b0d53f6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/index.js\":\"4896fd5a6ad09535\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/locationsPage.js\":\"2c4715b3e2e5fc7c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/mapViewport.js\":\"cdf9233f1bd15357\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/pickCurrentLocation.js\":\"79afe9897ce9ade0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/placeAutocomplete.js\":\"b52ac77988ac0f6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/placeNameCollision.js\":\"a5a748587a6816ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/properties.js\":\"55b4e782e081df5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/propertyEditorOverrides.js\":\"bc9c2f824ecc4220\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/query.js\":\"4a54f769340fd050\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/usePlaceSearch.js\":\"d9c6bff15af284e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9716bd313980546b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f4b2e0eca34e7fcf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c016151cf06c1049\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/config.js\":\"8eb39ba949a0b170\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/dataExtension.js\":\"f0ae7f2099922521\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/facet.js\":\"ab5ce45edc66edfa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/grouping.js\":\"e812a922683ba836\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/index.js\":\"0d2ae37d86b26742\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"db56c57114c137de\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/query.js\":\"89a998941bc05040\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/resolveConfig.js\":\"d9e4132d881dc697\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9fc810c0c87a78bd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"083b059cca314313\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/HtmlDocumentContent.js\":\"87f0a061cd7618fe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/HtmlFrame.js\":\"54bdae6052950ca9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/actions.js\":\"2525196436a4fd3e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/blockType.js\":\"eb63ac86352200ab\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/confirmRunScripts.js\":\"3ca3e1fc3d7860cb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/dataExtension.js\":\"3b7ad8322fe049f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameAnnotations.js\":\"155f9577ec903b81\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameDocument.js\":\"7f9439acb372fb0d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameTheme.js\":\"224164a0a106ee8c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/index.js\":\"503a8f28d870811f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/scriptConsent.js\":\"0e08b1920c35e9f6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/sourceMap.js\":\"84d49f4416b8aade\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/useDocumentScripts.js\":\"8b79e3c35cf106e2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/index.js\":\"8705f8905bd1919e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/record.js\":\"c16c2ebb1e144959\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/recordStore.js\":\"711b48d54841f963\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/responsiveness.js\":\"8fe9e2a26e3c3c89\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/schedule.js\":\"685d1549ebbbcc21\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/sessionContext.js\":\"b345fc58d33921ad\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4f3a6a2bf162a510\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"70ed0eaf40b7d52e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/actions.js\":\"fc61b3574697b905\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/config.js\":\"2ee7f7f0f9c7af5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/dataExtension.js\":\"013b56298f30fbb5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/effect.js\":\"a4c3ba9094b28261\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/index.js\":\"bb7efc97b88c9b74\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/keyCapture.js\":\"11a3ab7f1a0e2172\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/overrideStore.js\":\"e1114a0b4b68e5ff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bbc410366b581099\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/HeaderItem.js\":\"8ac9d0f755b691e7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/LeftSidebar.js\":\"ac9e99949072b99a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/actions.js\":\"9853786d20835006\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/facet.js\":\"b8d7d6f5f8f82d9b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/index.js\":\"18b125f7f8bf2cb4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/shortcuts.js\":\"44030c1ad13843ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/toggleStore.js\":\"9951b16b65d2a80a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/MergePicker.js\":\"437b7e3451529ff1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/index.js\":\"95417b44487e8ef8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/mergeAction.js\":\"789954f149938bdb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/strategy.js\":\"dbf916cbe559693c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/Button.js\":\"5b7df026d29defec\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2d1700db60f47a2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/defaultItems.js\":\"52c29e90c17229ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/facet.js\":\"12b0fb2cf4ffb215\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/index.js\":\"023039d26c7180b5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"91201bad6f2aae34\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d58ab8c684bdd7a4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"78861666c800c04a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/facet.js\":\"40439b949a444ab5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/index.js\":\"1dfc5a55b7ebc032\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ab5a438c076f3979\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d5e9aabade35223a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/contextMenuItem.js\":\"7506b74255670b4e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/index.js\":\"9c8fc8f99c1f874b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/moveAction.js\":\"145efd01eae69584\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/moveBlocks.js\":\"947fdbb944d89358\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/selectionAfterMove.js\":\"07b0f776bcd9da44\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/TutorialBanner.js\":\"0d9aaaff0285204d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/action.js\":\"3abcfbe05baa470c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/bannerDismissal.js\":\"04751e14bc794510\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/documents/cheatSheet.js\":\"f34d855fa6d93a02\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/index.js\":\"0bf4eaf0dc8f4d2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/keys.js\":\"425bd4d4e44d0429\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/landing.js\":\"aa378ca08b49c49b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/outline.js\":\"96cf5c26970f4e09\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/seed.js\":\"560fd1112089b72a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7a1edf79436d762d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/analyze.js\":\"9f10b882d6b40d0f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/diagnosticsSource.js\":\"f871157b8b608c66\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/index.js\":\"b3428d1753bda997\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/load.js\":\"897470926b7c3241\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/monitorRun.js\":\"197f4a37f19a98d1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/schedule.js\":\"2c381f327fbc7256\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/series.js\":\"d47005fb6cd393f2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/store.js\":\"33aaf12b8767c400\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/trendAction.js\":\"f21f127b75c7d4b9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/verdict.js\":\"e0b62f5ef70935f3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/clickToEditAction.js\":\"e81b8562616c3a12\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/index.js\":\"e5b052ed722f8fc8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/interactions.js\":\"4c0db3c687cfb2ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7ed1fb47ff7f5fb9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/MigrationGate.js\":\"b6d54f127786b1fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/MigrationGateDialog.js\":\"83c7f6ab04cb2bcc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/action.js\":\"f49fe872dcbb03f8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/index.js\":\"fe26145ced25beb7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/localRunMessage.js\":\"ab2ba04ff8d64827\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/plugin.js\":\"b1c4638e0bd96b03\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/progressReport.js\":\"f3547b5b766232ef\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/sweepProgress.js\":\"800bbc3789adaf67\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/FieldRowRenderer.js\":\"e9897e58e0fbf897\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/ValueRowRenderer.js\":\"e6494847b8ff1bda\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/actions.js\":\"e9bbe834b7a2af35\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/autocomplete.js\":\"a47c750ee251f0f6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/fieldRow.js\":\"ef261a25a4c8ca4d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/index.js\":\"e51cdb64527754a4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/referenceWarning.js\":\"9391e26ea8514a3f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/valueAutocomplete.js\":\"63a986f459c81d99\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/valueSchema.js\":\"e10cbaba72290817\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/HeaderItem.js\":\"e0f98d4bbe698696\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/QuickFind.js\":\"597ce80b9f87f29b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/index.js\":\"c1d088155ae33f78\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/recents.js\":\"729065fce962c578\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/resultItems.js\":\"f67f49bf521b1dbd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/selection.js\":\"7e9a0003f7353074\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/toggleStore.js\":\"aa7fce70ebfe4aa9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/HeaderItem.js\":\"bf8ea8b5d403ea59\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ad2a9bb159872dd0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/grouping.js\":\"dffbdaedc89875fc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/index.js\":\"a4547a7bfda11987\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/target.js\":\"03cd3837dd5e7505\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/codeMirrorExtensions.js\":\"ac8d21a497933e22\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/contentPrefill.js\":\"a19ab40946a0d2a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/dataExtension.js\":\"7eca8b778466749d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/index.js\":\"0291711e20a01924\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"70010bf6f5b3e686\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/invalidation.js\":\"c8cfbff593199e5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/localSchema.js\":\"0715e847ca5b1f9a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/blockrefs/index.js\":\"9da3a4c157b310c5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9279aad1f5731ad6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/index.js\":\"6aa3d1cd36ffa4eb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/referenceNode.js\":\"c09063b2eddcc9c7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/remark-reference-occurrences.js\":\"101562f94aeea370\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6bae76340fa9c595\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/index.js\":\"6c64b2f5903e3d20\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d76374ee405523f5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0142cfc0fed20e33\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/mergeRetargetProcessor.js\":\"01633a8fa3cd1b1e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/parseFence.js\":\"7bdc6ce5f52b3542\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referenceParser.js\":\"542b360d39af0a81\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referenceProjection.js\":\"ef6547f3d64e9269\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referencesProcessor.js\":\"021d65759d260096\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/renameProcessor.js\":\"91bf10a5bfba4279\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/spanReplacement.js\":\"c5b577a21aa882cb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/htmlToOutline.js\":\"7c0e11db33be4718\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/index.js\":\"7ed4827bb8487b67\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/normalizeClipboardDom.js\":\"543c7e90a8865c8c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/pasteDecision.js\":\"6347ca0af10a7e4d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/action.js\":\"bcfb6f50bcde64ea\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/blockIds.js\":\"09fdd983d96b05db\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/content.js\":\"9a838f719651a38c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/effect.js\":\"f5cf830093b73ad0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/ids.js\":\"b41bc076bdeed9c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/import.js\":\"d8112a84f5fda12c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/index.js\":\"84b4c74dcb468fda\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/plan.js\":\"4983b17a5a2ad65d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/plugin.js\":\"e56c5cac9eb113bb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/promotion.js\":\"b8052ea1bf909476\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/properties.js\":\"b54d09e88e2a6cf5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/references.js\":\"b8d716e58be7bc61\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/report.js\":\"9251cb4104d0776c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/roamMemo.js\":\"8cddb7ea1c8e066c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/runtime.js\":\"f02221c3fdf94a90\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/schemaReconciliation.js\":\"b537105c426b0d0b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/srsMarkers.js\":\"3055f35d17927e32\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/todo.js\":\"1ba415273c8986e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/typeCandidates.js\":\"0b68ddbc02df8022\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/types.js\":\"b965873e9712b0a5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/search-health/index.js\":\"7a0a224437fbbfba\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/search-health/store.js\":\"2abe3d2800243263\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/HeaderItem.js\":\"a75f4f520894c4f1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8d961250eb03b6bf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/index.js\":\"459be26f11ba72ab\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/model.js\":\"19081bf63af0c8e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/toggleStore.js\":\"1e5d36be91eb72f2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/useKeyInspector.js\":\"5d3c6ae10a521e6b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e25f23caf85bb86a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/ShellDecorator.js\":\"b40b6324990e6722\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/actions.js\":\"d71a474043f36706\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3e2139bc5275ba6c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/index.js\":\"7021f58e82080775\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/shell.js\":\"8108ca5d95821771\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/surface.js\":\"0b73b7861c8b52e9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/walker.js\":\"f4abb051f3e97237\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/RescheduleToast.js\":\"04c4a397f455cc46\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/dataExtension.js\":\"28263604af5ca1fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/index.js\":\"2ce896cceacd44d3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/indicator.js\":\"9f3369f696f6044b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/moveSrsState.js\":\"9eb45f99598808ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b92645bdde8616e9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/scheduler.js\":\"403c39b37b82de23\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/schema.js\":\"161f7e3f9d11ae85\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c58aeb13471bfbd3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/srsClipboard.js\":\"e1db07cca7739301\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"88cefc57d4ae0a03\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8b69819f36192b59\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/DeckPicker.js\":\"bdff690ab236100f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewControls.js\":\"b489b59f981a60a5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewDeckRenderer.js\":\"656bdf629c874c54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewSession.js\":\"dc22d1ceca428b25\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/actions.js\":\"8b40a368e4f45cb6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/archive.js\":\"c4f2d086fb3a40da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/dataExtension.js\":\"0dcc7f095922c7f9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/deck.js\":\"0656965608b749de\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/dueQuery.js\":\"e46f46c75797012e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/gradeDecision.js\":\"d58f24066d1e7bdd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/index.js\":\"395d563d660f775e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/keyHints.js\":\"d45dc0f43265d5a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/reviewCardLayout.js\":\"8476f81d7bce7bc0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/reviewProgress.js\":\"5a1e42c3e679105c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/schema.js\":\"675af07583c1b046\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/useDueCards.js\":\"327ac63f7ac0d2d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/startup-metrics/index.js\":\"b4e8641fd963463a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/startup-metrics/record.js\":\"8b3e8a38aaef03b0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/index.js\":\"61bed9ad1a20eb3f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/persistenceStatus.js\":\"04ef90e6a0067b82\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/requestAction.js\":\"e9a41c7a3cfc434d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/TypeChipsDecorator.js\":\"e93e847db7e16af3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/codeMirrorExtensions.js\":\"1c3f479f989840a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/index.js\":\"52bd593f49f88129\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/typeAutocomplete.js\":\"843bbdaee0e5e3e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3ea4293baca97313\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/actions.js\":\"9618246ce1db3a8f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/anchor.js\":\"d6d0874e56200fa6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/events.js\":\"b392255c6e19bd2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/gestureActions.js\":\"6aa1fdde294fef38\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/index.js\":\"e82369470e3660b2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a1f259d23b52283f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/collect.js\":\"6f76798e80415697\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/index.js\":\"ea17e53e2b4fc183\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/record.js\":\"886a14ddd6f6d156\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/RejectionDialog.js\":\"4b5ed2b9f56ddd8d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d5b909aae58af2fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/index.js\":\"e985c78c4a9bc88b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/model.js\":\"c4a1a171ed00a127\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/queueCounts.js\":\"8a4e736841262527\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/rejectedHelpers.js\":\"1e3c7e12a95516e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/rematerializeAction.js\":\"d0eb918804831b21\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/useHysteresis.js\":\"08096db45af56daf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/ColumnHeaders.js\":\"d4cf31a0ca57307e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/QueryUi.js\":\"8c600c0b2b4ed0fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/TableLayout.js\":\"c4591a466eba3159\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/actions.js\":\"acc7c9b8602be5d5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/cellEdits.js\":\"854eb380f8c8326e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/columns.js\":\"6edbf4770da13b09\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/controller.js\":\"f1e5b81602a21658\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/convert.js\":\"6701fb3cee8467af\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/dataExtension.js\":\"585473e55183111e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/index.js\":\"41032daaa7ba27cf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/keys.js\":\"144493c66ea0bdbb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/model.js\":\"b20f57043fadaabf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/navigation.js\":\"be5c5cd09c1ac0a1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/backfill.js\":\"2c36e3c9dcf2cdca\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/completion.js\":\"588ee407845ab2e4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/format.js\":\"1302775a76290d29\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/parse.js\":\"8700b96ba517f9d6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/queryValue.js\":\"f69fd4ba6fbe7edf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/source.js\":\"2cb798c0b0d4833f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/registry.js\":\"4c76a786b954e6e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/rowGutter.js\":\"bb2a22a7ff96c3be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/rowVerbs.js\":\"4e02130180695adc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/schema.js\":\"bca66ec5d1b8fe72\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/sort.js\":\"7e6e023c4fd86ff1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/effect.js\":\"2649093750ec55c0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/index.js\":\"93e9ebb16995ec39\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/theme.js\":\"3f2d73b7ef90d68e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/actions.js\":\"0e3c5e90163d5135\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/dataExtension.js\":\"618d39d632686d33\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/index.js\":\"f09aa29476b6f05a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/schema.js\":\"19b1f542567fd9bf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/TouchSelectionLayer.js\":\"48be92838fe63906\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/actions.js\":\"090469e80b253021\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/defaultItems.js\":\"9f01c66213141863\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/facet.js\":\"29fa74e98adf400b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/holdRecognizer.js\":\"a5a77c6a7aba4e18\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/index.js\":\"d30acd858ef7bce2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/UpdateIndicator.js\":\"a5c5c5c3e174a1fa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/index.js\":\"77129d6a52f41a8e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/loadTimes.js\":\"ae1670c8dbf509bf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoNotesRenderer.js\":\"6305eeccae26f7ca\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoPlayerRenderer.js\":\"e6f646d523f8e77f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoTimeStamp.js\":\"527ca41cc01469b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/actions.js\":\"ecca93d427018e87\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/index.js\":\"6cb1dd81f7d4e68a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/markdown.js\":\"b94f7c44fdd9ab85\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/notes.js\":\"ac742361406c4f47\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/registry.js\":\"d128d67a82ae7e2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/remark-timestamps.js\":\"a5ef53bfb5371e9c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/view.js\":\"8e669985bd86febe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/LinkHints.js\":\"9953ce12d5dc335c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/index.js\":\"b982eec8bd5faad8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/model.js\":\"e416de87a2495bee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/settings.js\":\"48708ba13dac23cb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/actions.js\":\"5763c74444f998b7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/index.js\":\"21df80023c4e141f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/interactions.js\":\"86e76b9031e3acf3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/workspace-header/index.js\":\"16ade752d62c7c72\",\"/knowledge-medium/pr-preview/pr-1858/src/registerServiceWorker.js\":\"12734e979c6cd04a\",\"/knowledge-medium/pr-preview/pr-1858/src/requestPersistentStorage.js\":\"532ddcefbf3e34d3\",\"/knowledge-medium/pr-preview/pr-1858/src/services/authRequestDeadline.js\":\"6c91809ebcb188d5\",\"/knowledge-medium/pr-preview/pr-1858/src/services/authStorage.js\":\"b7901bfc587cf44f\",\"/knowledge-medium/pr-preview/pr-1858/src/services/powersync.js\":\"f4d93a3f3f70a86c\",\"/knowledge-medium/pr-preview/pr-1858/src/services/supabase.js\":\"07116bafd300ddc4\",\"/knowledge-medium/pr-preview/pr-1858/src/services/uploadErrorClassifier.js\":\"1cd0043a2a795df4\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/ActiveContexts.js\":\"74eebe5339c52863\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/HotkeyReconciler.js\":\"c36a85790646128b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/WipeLocalDataDialog.js\":\"cf717b85097e7797\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/actionDispatch.js\":\"8723a2d06ac9aa03\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/actionRefItems.js\":\"609154d66f6e9637\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/applyKeybindingOverrides.js\":\"bf5a854dc535e372\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/blockActions.js\":\"96b7671b31049592\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/blockMergeGesture.js\":\"2fffabf24710eee0\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/canonicalizeChord.js\":\"3e71f2780f8b1427\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/defaultContexts.js\":\"eb953480633dbf7f\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/defaultShortcuts.js\":\"c1850d89042f4917\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/effectiveActions.js\":\"115473865e67ab21\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/gestureAction.js\":\"1b4cd484bd3d9ad8\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/gestureBinding.js\":\"61df0cfc1b963b8d\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/holdRegistry.js\":\"dfdb1d05fc9a85c0\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/keybindingConflicts.js\":\"0818973fa1ee2d6e\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/keybindingOverrides.js\":\"389092e6bebd1eab\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/pointerAction.js\":\"c52fa1cb82b80a1e\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/resolve.js\":\"251edbe8a9d2b694\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/runAction.js\":\"ec8621102123ffdd\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/sequenceMatcher.js\":\"af3cc3a660e67fb7\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/types.js\":\"25e589bbc6ba46e7\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/useActionContext.js\":\"3414ff68977b3c3b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/useActionDiscovery.js\":\"ce8395408a641e1b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/utils.js\":\"8e7e0f1b75742e15\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/bootStore.js\":\"57fb0c0a423c4f40\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/previewDatabases.js\":\"6d8e2ff615cc88b0\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/byteTransform.js\":\"6cc733557da223d3\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/attachmentCleaner.js\":\"4a8675113036ae64\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/attachmentParts.js\":\"e5adfedb483a4186\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/bundleParts.js\":\"f1effb3c9cb9ec11\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/bundleRecord.js\":\"e6d7fb9e6d5e7784\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/manifest.js\":\"365a60d165aa408d\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/takeBundle.js\":\"588efa7d3c95ae29\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/verifyBundle.js\":\"62fa6b7a0e430e8c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/cleaningStage.js\":\"6f9604551d265fc5\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionKey.js\":\"ce98f3a82b87f8cf\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionServer.js\":\"9ecca87e8b663769\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/flip.js\":\"ad51ce27ba004719\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/flipAttempts.js\":\"11113ad7adb43f83\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/pages.js\":\"ab40130e8078077d\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/preflight.js\":\"467b92b208dc06d8\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/reseal.js\":\"7d22fed8a1503403\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/runConversion.js\":\"bc12eb419a75986e\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/runLock.js\":\"2d238ebddb705d7f\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/sealing.js\":\"f5f039ad22375931\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/sealingStage.js\":\"7c2e2c2a235fbd11\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/stage.js\":\"56940c52f5e25333\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/verifyReseal.js\":\"fca0f46594b1cc5b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/aad.js\":\"9f81c9194a5109c2\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/aead.js\":\"c6a31fad7fbe9893\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/base32.js\":\"f02cfcaaa1039cbc\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/base64url.js\":\"de451d132c664a07\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/binaryEnvelope.js\":\"a887151ccc782e5a\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/byteAead.js\":\"b43dc1fbb0fbcb02\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/canary.js\":\"6c31afa92ea65aee\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/contentHash.js\":\"639ee8e4ce31d442\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/contentKey.js\":\"b024aa84fb3896e9\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/derivedIdNamespace.js\":\"93a43efa00d4787f\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/envelope.js\":\"6a3b16a250c30c35\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/hex.js\":\"9828bc4cc5713530\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/sha256Hex.js\":\"71431e5206bbf06e\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/workspaceKey.js\":\"a062dbd5de252467\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/conversionState.js\":\"848364d0c09ad747\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9a7060eaf345b71b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/pastedKey.js\":\"7e36a473a1bfbd61\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b604b260b0a58d5a\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8ac49f245e0f8fed\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/keyStore.js\":\"0aabb50c2b2016cb\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/mintWorkspaceKey.js\":\"6344124a6869dbb4\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/modePin.js\":\"bbdcddbffac494bd\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/openWorkspaceKeys.js\":\"43922387b4aced01\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/resolveWorkspaceEntry.js\":\"2bc0827abc015416\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/resolver.js\":\"e21305e193d02eac\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/workspaceAccess.js\":\"c5167e57f4a90325\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/transform.js\":\"5999efe8c27f9bbe\",\"/knowledge-medium/pr-preview/pr-1858/src/themeBootDefaults.js\":\"868b8cdf1f87310a\",\"/knowledge-medium/pr-preview/pr-1858/src/types.js\":\"98510eadb2c0e82a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/ClientLocalSettings.js\":\"ef7275ba07d1e9c9\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/abortableSleep.js\":\"351579b57020cd45\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/array.js\":\"aa7f8617d5de3137\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/backlinkAutocomplete.js\":\"301b390a513926f3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/blockCrumbs.js\":\"c90808039767c71d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/blockrefAutocomplete.js\":\"70778055a0651221\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/cadencedIdleJob.js\":\"4bdaab0277d149e2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/callbackSet.js\":\"1831c04b5140837e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/clientId.js\":\"62bae634929190e9\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/codemirror.js\":\"34c10118e95d745f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/codemirrorCompletion.js\":\"f06615fd5fd4359b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/copy.js\":\"e1f90084f6db276d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dailyPage.js\":\"2f8895444bc4ea99\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dbForensics.js\":\"1994d58bd208aea0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dbForensicsHooks.js\":\"0ecd243b90f0c8e0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/deleteBlockThroughUi.js\":\"c461c1718a070282\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dialogs.js\":\"a28ba23e0093351e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dom.js\":\"74b44f7616bd3283\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/downloadBlob.js\":\"6bb8caa7ef6599f9\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/exportSqliteDb.js\":\"f78d59118c56b5c8\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fileSystemAccess.js\":\"d7d4a477786f8a6c\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/flipSlide.js\":\"011fc3d2796da13d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fnv1a.js\":\"98cccd14f4613a7a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/formatBytes.js\":\"d9da44d3cab03052\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fuzzyRank.js\":\"29318aaf9385846a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/idbKeyedStore.js\":\"3159ff40a3b29b81\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/idleCallbackPolyfill.js\":\"6e0b7e55cb870dc0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/keyboardAwareScroll.js\":\"1c12e8529c3e3e94\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/keyboardViewport.js\":\"2876922d79c1120a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/lastWorkspace.js\":\"7a767e99d5c4bd66\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutColumns.js\":\"a91602f18b7962a6\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutSessionDom.js\":\"3cbebb01cd9f7712\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutSessionId.js\":\"94a7c06e7fc4487e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/linkClickGestures.js\":\"85f965a00cbfa61b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/linkTargetAutocomplete.js\":\"28e1a53adcde98b3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/localDbCorruption.js\":\"26e6342ccbdf438d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/localDbRecovery.js\":\"ee91e7a9d52783b5\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/markdownParser.js\":\"fe26a9aef41f2158\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/memoize.js\":\"141be1a373b53177\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/nameFieldCommit.js\":\"03ca46165a1e3e79\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/nameList.js\":\"77e473902ca3c055\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/navigation.js\":\"e622c6afde930475\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/omnilinerNamespace.js\":\"6db8d69fa4b301ed\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/opfsPageScan.js\":\"fa7c396bfb13d365\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelClearance.js\":\"83fd4bff443d9586\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelHistory.js\":\"508ac7d2748032fa\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelLanes.js\":\"0e6fb9f801233fd1\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelLayoutProjection.js\":\"9ff0ebd6cd0454a8\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelScrollAnchor.js\":\"41f61ac7319edf79\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelUrlFlags.js\":\"7813ff562c4ed894\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/platform.js\":\"f2d3d721e70e18fa\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/pluralize.js\":\"f0fdf6b7bf8bd78f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyCreation.js\":\"8168b51cfb3cf17d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyNavigation.js\":\"83f4992f83a337cf\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyValueContext.js\":\"eb689faec97bc682\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/react.js\":\"12335f529eff43cb\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/relativeDate.js\":\"d8d05fcbf9dbda9a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/relativeTime.js\":\"0eed617bfeb0786b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/renderScope.js\":\"6b8a44eee44315b0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/resolvedThenable.js\":\"98150879b91aa9a0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/routing.js\":\"d99d73e341831b8e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/safeMode.js\":\"c4ba8fe8c7f023d3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/scheduleIdle.js\":\"9ac24bfdb6506fd2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/screenWakeLock.js\":\"c3a578d5d666233a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/selection.js\":\"c40608b036e47887\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/softKeyboardGrab.js\":\"2ecfa5b52fbda981\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/startupTimeline.js\":\"f4134f36e010c701\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/state.js\":\"f994b0729b462d44\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/string.js\":\"9a9d081254cc2084\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/surfaceZoom.js\":\"e1156733d2b2d63f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/time.js\":\"84f2e918e7483440\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/toast.js\":\"dbb3a176afeb4801\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/toggleStore.js\":\"4c707a32b0758a26\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/untilStopped.js\":\"2d6214bd88d40c71\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/userActivity.js\":\"93820110f8e79f2f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/viewTransition.js\":\"e882303275f8d644\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/viewport.js\":\"5ffe13a08a0727f2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/webLock.js\":\"5ffef9cfd9aa6763\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/workspaceRecovery.js\":\"1196a0ddd59e67ad\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/workspaceSnapshotStore.js\":\"073d3f10e83b949a\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-compiler-runtime.js\":\"bc06029dd6ae4a47\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-client.js\":\"5468421ff8763943\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-server-edge.js\":\"1afe337c1f9f4c20\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-server.js\":\"8acebcff76339a5a\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-static-edge.js\":\"474eaa1014f7b775\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-static.js\":\"2e365b2f30ddfa57\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-test-utils.js\":\"899de5580c6a5dff\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom.js\":\"4b81bfa27f4e88c5\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-jsx-runtime.js\":\"6d265b5a77e60059\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react.js\":\"15fff20502970278\",\"/knowledge-medium/pr-preview/pr-1858/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1858/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1858/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
