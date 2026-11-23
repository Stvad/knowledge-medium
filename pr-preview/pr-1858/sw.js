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
		buildId: "14aacf235859-73e8caa7",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/\":\"e49762efda0daedd\",\"/knowledge-medium/pr-preview/pr-1858/index.html\":\"e49762efda0daedd\",\"/knowledge-medium/pr-preview/pr-1858/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1858/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1858/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1858/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1858/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1858/assets/FacadeVFS-D1gtmMk-.js\":\"4406a4c7cf2deaf5\",\"/knowledge-medium/pr-preview/pr-1858/assets/OPFSCoopSyncVFS-CywVYhU5.js\":\"b34a484d4cb79952\",\"/knowledge-medium/pr-preview/pr-1858/assets/OPFSWriteAheadVFS-Bjjd1FFP.js\":\"e2b075bdfda4c8f3\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-DVCVkV2A.js\":\"75b6b421efece65f\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-async-B0bti-FC.js\":\"93d1433e6c6cae8f\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1858/assets/worker-B_BSxPQu.js\":\"cf10fb08ce41fd92\",\"/knowledge-medium/pr-preview/pr-1858/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1858/chunks/app-NiFa047w.js\":\"e245cbbffc49a7d5\",\"/knowledge-medium/pr-preview/pr-1858/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1858/index.js\":\"db4bca7730ee1665\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1858/assets/AccessHandlePoolVFS-qUoEO_Zj.js\":\"16fb83e7eccc95ca\",\"/knowledge-medium/pr-preview/pr-1858/assets/IDBBatchAtomicVFS-qCNJGVRE.js\":\"f0dc67ba9f99fd3f\",\"/knowledge-medium/pr-preview/pr-1858/assets/MemoryVFS-sTOowopE.js\":\"8303ca91f4ae3caf\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-3vYLeVVH.js\":\"a02ddd248b461e83\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-async-BVICo-I5.js\":\"a3982fd8b70a6559\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1858/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1858/chunks/AccessHandlePoolVFS-CfWkKaSY.js\":\"d8aab1cc93f83af3\",\"/knowledge-medium/pr-preview/pr-1858/chunks/FacadeVFS-c5dNYms5.js\":\"4b2e55b8422014be\",\"/knowledge-medium/pr-preview/pr-1858/chunks/IDBBatchAtomicVFS-D9-DlR2K.js\":\"3309fbe0651d176d\",\"/knowledge-medium/pr-preview/pr-1858/chunks/MemoryVFS-nQL6jHv_.js\":\"87d530242c0cd7c4\",\"/knowledge-medium/pr-preview/pr-1858/chunks/OPFSCoopSyncVFS-BuXHDetJ.js\":\"5d98d203fce93041\",\"/knowledge-medium/pr-preview/pr-1858/chunks/OPFSWriteAheadVFS-DsfXKrmw.js\":\"dfb0457ff8012cb8\",\"/knowledge-medium/pr-preview/pr-1858/chunks/Preview-DtdoEQBf.js\":\"c3ad1d57176971fc\",\"/knowledge-medium/pr-preview/pr-1858/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1858/chunks/card-Bua59QDn.js\":\"656751cf486089a3\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-CfgTaD2y.js\":\"ef1d37ba1a585029\",\"/knowledge-medium/pr-preview/pr-1858/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1858/chunks/mc-wa-sqlite-async-CEgoi9Ur.js\":\"c3aa26642314fc11\",\"/knowledge-medium/pr-preview/pr-1858/chunks/mc-wa-sqlite-jpKCg9Q2.js\":\"65507a44fdc730be\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-B05zkxYT.js\":\"f984c4dbdf1527a8\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-BmWTVCdU.js\":\"81ac4153021278b2\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-Cv30RIFc.js\":\"ef85299759c92749\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-CwmZ4y8T.js\":\"4dde19c602b018d5\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-DFItHhn-.js\":\"8f6ad18dc9f83ad1\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-Dsr93wpo.js\":\"b78dbe9f662f900d\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-OgDC846B.js\":\"6a686c1ecac54ab6\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-RnDNc0t_.js\":\"3bdccdb487c17a34\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server-legacy.browser.production-CHMMqjR-.js\":\"5598a74afc509e6e\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server.browser.production-DK_B4OIF.js\":\"7e27d4dcda14e324\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server.edge.production-X5RYcdW7.js\":\"db0031775caa643b\",\"/knowledge-medium/pr-preview/pr-1858/chunks/server.browser-DvSS8NXn.js\":\"b1c1388099a79bb4\",\"/knowledge-medium/pr-preview/pr-1858/chunks/textarea-DzQu_uHw.js\":\"254f539674f4518f\",\"/knowledge-medium/pr-preview/pr-1858/chunks/ui-DYcjiajZ.js\":\"51f52733fedd7012\",\"/knowledge-medium/pr-preview/pr-1858/chunks/wa-sqlite-async-gz4viZnp.js\":\"af5d0c9d8d1a5898\",\"/knowledge-medium/pr-preview/pr-1858/chunks/wa-sqlite-dukafiqG.js\":\"0fee3e9d9d76a2a7\",\"/knowledge-medium/pr-preview/pr-1858/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1858/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1858/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1858/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1858/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1858/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1858/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1858/src/App.js\":\"1603c39236882bba\",\"/knowledge-medium/pr-preview/pr-1858/src/appUpdate.js\":\"20ad78dc97ff2431\",\"/knowledge-medium/pr-preview/pr-1858/src/appVersion.js\":\"6574ceb5bddb95a1\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/initialLayout.js\":\"6690317ae24b3f3b\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/openWorkspaceData.js\":\"ca8887b31cadba69\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/resolveWorkspace.js\":\"8bc358eea22f0cb5\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/workspaceBootstrap.js\":\"55c71c6a895d702c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockComponent.js\":\"7653f3cdb5e5a057\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockCrumbs.js\":\"01f2428ee481bdae\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockEditor.js\":\"942735e03469cce6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockLoadingPlaceholder.js\":\"74c2819434cac590\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockProperties.js\":\"93920e69732cdd37\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockSearchPicker.js\":\"37a367499a38cbfc\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ConfirmBulkDeleteDialog.js\":\"f6166ecb56a0c3af\",\"/knowledge-medium/pr-preview/pr-1858/src/components/DividerHandle.js\":\"99261f01ed9d7afe\",\"/knowledge-medium/pr-preview/pr-1858/src/components/DraftEditor.js\":\"ee75ace25906d0d5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/GutterPill.js\":\"add6b8e2ea019342\",\"/knowledge-medium/pr-preview/pr-1858/src/components/Header.js\":\"a153abfb889a5af9\",\"/knowledge-medium/pr-preview/pr-1858/src/components/LazyBlockComponent.js\":\"8f5de47b6e54186c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/Login.js\":\"497b380cfecb04bd\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ZoomableSurface.js\":\"c8654b4f9709cfea\",\"/knowledge-medium/pr-preview/pr-1858/src/components/editModeKeepalive.js\":\"11417031d8fb051d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyDisplay/PropertyDisplayScope.js\":\"99e762511c2e2255\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"daee2d535df2024e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/RefPropertyEditor.js\":\"50afae9cfb7aad6c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/RefTargetTypePicker.js\":\"9fbedcfe08d536a4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/SelectPropertyEditor.js\":\"47d1ba01a82843cf\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/TypesPropertyEditor.js\":\"ba6ff1d2bae785ea\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/defaults.js\":\"3153edacad7450db\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/kernelValuePresets.js\":\"bdac4cf716b94970\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/selectablePresets.js\":\"c3d00fc047252a08\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/typesPropertyUi.js\":\"ed9e56485f50446d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/AddPropertyForm.js\":\"9bd05a3699115207\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/PropertyPicker.js\":\"ba3a6031da2fc881\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/PropertyRow.js\":\"30ff65a5e377cdb7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/Rows.js\":\"8fdc630683ad2b2f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/actions.js\":\"d9ca6b19761e6011\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/declarationOnly.js\":\"8a2382cb6431eb81\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/layout.js\":\"aa81761da8cd9859\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/model.js\":\"09e253488f14148e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/shapeUi.js\":\"931bd085e2377a40\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/shapes.js\":\"26931c7d4ae035a0\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/usePropertyEditingActivation.js\":\"58b58529f769f467\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/visibility.js\":\"8e7ac3e48f04956b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanelSections.js\":\"3534af88c2d12266\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockEmbed.js\":\"8a1d2a61eb802ea5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockLink.js\":\"f475960e106f645e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockRef.js\":\"539cd4848b0855d8\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/ReferenceLink.js\":\"936816514d642728\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/cycleGuard.js\":\"4e855810a5d78258\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/cycleGuardContext.js\":\"a7c4fb0d6070da3b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/linkInteraction.js\":\"04ee4b1f9cd1a71b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/referenceLayout.js\":\"03d7bb66bb84aab7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/useBlockRefAncestors.js\":\"74103039ed8efea6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockGutter.js\":\"b1920b4e682fbfb2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockInfoDialog.js\":\"53f46485d83f9d58\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockTypeBlockRenderer.js\":\"64d3285a84c43959\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BulletHoverCard.js\":\"9a45e3dd6f273b85\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/CodeMirrorContentRenderer.js\":\"1634753b0a0ec840\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7ec2123969f73d06\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/ColumnResizeHandles.js\":\"27c6b332e0a369c2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4e93dbfaf29cc2dc\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/DefaultBlockRenderer.js\":\"143e9c556373941a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/LayoutRenderer.js\":\"5003b131f48e9f0f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/MarkdownContentRenderer.js\":\"a4f750dcf46aebe4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/MissingDataRenderer.js\":\"ac1fec17ede46085\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/PanelRenderer.js\":\"5ff0dd264e6f14f7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b61b5b252a6b5375\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/TopLevelRenderer.js\":\"dfd3bf248e187310\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/blockGutterMode.js\":\"50ae2dd9027a05bf\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/blockTitleText.js\":\"288a240199091b3c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/fieldCreationKeydown.js\":\"171a91c93e66b321\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/layoutRootContext.js\":\"82f4f71d9e76d50e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/typeChip/TypeChip.js\":\"032b669d2d39129c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/typeChip/chipStyle.js\":\"e74ef135c05ff291\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/anchored-floating.js\":\"d2796866862fb59c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/button.js\":\"22c98853f83a2475\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/card.js\":\"769f106d9e571d34\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/checkbox.js\":\"082232767e63499b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/collapsible.js\":\"a7de92604c698089\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/command.js\":\"95b728baf57aa588\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/context-menu.js\":\"685c01320b4675f9\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/dialog.js\":\"44f15149c7fde429\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/dropdown-menu.js\":\"301527cb6f14a501\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/floating-listbox.js\":\"ae7c530a0e64814b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/index.js\":\"251b0aa4a318887f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/input.js\":\"abebf64b587cd044\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/kbd.js\":\"e99e519803d3e1bb\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/label.js\":\"af0692bb8ca97703\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/textarea.js\":\"48e751d60e19419c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/useEditModeYieldKeepalive.js\":\"4d9fff789a670d40\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/BootFallback.js\":\"7ee59a9978d652d3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/FocusedRowLazyMount.js\":\"d2ae5342948ee82a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/LazyViewportMount.js\":\"ac57eb01c0daf042\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/LocalDbCorruptionFallback.js\":\"0886e997ce4fdc4a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/error.js\":\"470554c313b747e1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/lazyMountRegistry.js\":\"07206efc9c02c602\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/suspense.js\":\"44eb6d88ce42feeb\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/CreateWorkspaceDialog.js\":\"29a6144d4538a9b5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/PendingInvitations.js\":\"eb619f77a7f6e3b5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/SyncProgress.js\":\"8efe85d05a505666\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/UnlockProgress.js\":\"ec897c69cb5cc744\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceKeyGate.js\":\"b7ebfa2bddbdabfe\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSettingsDialog.js\":\"030ba913fef9b7d1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSwitcher.js\":\"f5453205cdc95a8b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSyncGate.js\":\"42e1cfe3d0e6ccd4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/ConversionFlow.js\":\"db59a8438373165b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/ConversionFlowHost.js\":\"4636528b478d89aa\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/EncryptionSection.js\":\"2d4d934027ce0654\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/attachmentPrompts.js\":\"404c61b495313bad\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/bundleFolderPrompts.js\":\"605ccd38482a1809\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/conversionFlowDeps.js\":\"20603dd2b40f37d3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/conversionFlowStore.js\":\"7e8c25dcd3ffd5c5\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/flowUi.js\":\"c273d51ad2eb8092\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/useConversionRun.js\":\"4df00d88eb11c03c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/keyUi.js\":\"acb0b789f10895b4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/useCloseOnKeyLoss.js\":\"311b1b5c670f2309\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/useCloseOnServerE2ee.js\":\"3c60a3746bafa1ef\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/workspaceUnlocked.js\":\"2598a357651e28ce\",\"/knowledge-medium/pr-preview/pr-1858/src/context/backgroundSubtree.js\":\"ff5bf55d7c6ba623\",\"/knowledge-medium/pr-preview/pr-1858/src/context/block.js\":\"33a3f50ffbe6d41e\",\"/knowledge-medium/pr-preview/pr-1858/src/context/layoutWsContext.js\":\"4bd15f75121d7ab1\",\"/knowledge-medium/pr-preview/pr-1858/src/context/propertyDisplay.js\":\"78570afe06614650\",\"/knowledge-medium/pr-preview/pr-1858/src/context/repo.js\":\"008691b32bb49d19\",\"/knowledge-medium/pr-preview/pr-1858/src/data/aliasClaim.js\":\"13572a13c42486f2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/aliasSeatNamespace.js\":\"1ebf0b0fa1a3def8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/blockData.js\":\"d071c00d64f3c5ec\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/blockType.js\":\"ccbaed7495bd575c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/changeScope.js\":\"8f353903d8d65c57\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/codecs.js\":\"d3a48b9195fc158c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/derivedData.js\":\"e17e7cd443b02d0e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/errors.js\":\"802eeae3eefced2b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/events.js\":\"b13d45c9123c1bb3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/handle.js\":\"79a0a9299f852b91\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/index.js\":\"7611a1d45345604c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/mutator.js\":\"f5e1532b012680ab\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/processor.js\":\"59fbde4f909eaf87\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/propertySchema.js\":\"926847cbeb7bbf07\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/query.js\":\"a967949cf0228128\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/sameTxProcessor.js\":\"1112c33468f8cd23\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/schema.js\":\"79a0a9299f852b91\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/tx.js\":\"79a0a9299f852b91\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/typedBlockQuery.js\":\"6a28635db5cb9d0a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/user.js\":\"e2c5d208d168c0c2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/valuePresetCore.js\":\"4318964043681e39\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/valuePresets.js\":\"abc21ad697ef45f3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/attachmentCleanerIOVerb.js\":\"6aa818d723009cfc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/block.js\":\"63b0326f2aacfce7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockCache.js\":\"cfa98a42560ed094\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockId.js\":\"ff8ca6ff74264ac3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockLiveness.js\":\"f0669406d29fab43\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockMerge.js\":\"d98c70128110f246\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockSchema.js\":\"38931d9b93c62908\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockTypeLookup.js\":\"fe564d07ba0cf75a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockTypes.js\":\"66d4b8276cd37713\",\"/knowledge-medium/pr-preview/pr-1858/src/data/clientContext.js\":\"4fb75a17fad1e939\",\"/knowledge-medium/pr-preview/pr-1858/src/data/dbFileSiblings.js\":\"35bfb4280c67e50c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/definitionSeeds.js\":\"d5c70d1e59020246\",\"/knowledge-medium/pr-preview/pr-1858/src/data/derivedIds.js\":\"bea6e4acf944c7f6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/drawnSubtree.js\":\"aba8f282bcd4b7fc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/facetBridge.js\":\"91dd1b9f5567e601\",\"/knowledge-medium/pr-preview/pr-1858/src/data/facets.js\":\"cc68737c599ae7cc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/globalState.js\":\"6c000379c51ad121\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/aliasClaimRederiveProcessor.js\":\"a7840c991f9eabaa\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/ancestorBatch.js\":\"bd98467a145cfa79\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/blockTypeTypeifyProcessor.js\":\"121133c2dad02272\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/clientSchema.js\":\"52eeaf48c689a0cd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/commitPipeline.js\":\"04c4004a5d33a8fb\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/devAssertions.js\":\"f03440af59a5ab40\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/firstSync.js\":\"62ff671e356d058e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/freshInitialLoad.js\":\"baf24951fd422bee\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/graphBackfillClaim.js\":\"210c5657377fd45e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/handleStore.js\":\"7fdd20322fb27e48\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/idleMarkerJobs.js\":\"94ae002fbcaecf0e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/initialDownload.js\":\"0b0bf64ba62fa0e0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/initializeClientDatabase.js\":\"7e6955860b74b26d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/jsonCanonical.js\":\"b4c2b0c186bc292e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelInvalidation.js\":\"566a8dabe2a4c51e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelProcessors.js\":\"dfd52eadece0f347\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelQueries.js\":\"999b62055922f0a3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/mergeTypeMembershipProcessor.js\":\"e98b8a7f39cbb2a3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/normalizeReferencesProcessor.js\":\"79158cfe0bc727c6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/poolInstrumentation.js\":\"b7575dd8682e647d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/processorRunner.js\":\"5564f279518d5146\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyCellBackfill.js\":\"baedff4cd8adf1fe\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyChildMint.js\":\"3c607c4eadc2b2dc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyChildrenProcessor.js\":\"5c48fa914fa23b19\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyDefinitionChangeProcessor.js\":\"80482ef7b74e28e7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyDefinitionSynthesis.js\":\"4e66b4b5a45b811e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyKeyScan.js\":\"bd746615b65b6670\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertySchemaResolution.js\":\"61a480668100343c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyValueEdits.js\":\"db2d1de6d8a34874\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/raiseProtocol.js\":\"539187bd47b203c3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/readBatch.js\":\"100e3d7124dad749\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/refProjection.js\":\"02544f794ee3677a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/referenceTargetLookups.js\":\"28a3a508a62e9982\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/referenceTargetProcessor.js\":\"a1424890d01349b4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/replayMerge.js\":\"645561e9075c5872\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/sqlBinds.js\":\"207b5b0e34901dfd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0f9e0cb31c6916f1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/arrivalProcessors.js\":\"e428f17c1f760e71\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/invalidate.js\":\"b01801dcf2e97e70\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/materialize.js\":\"080ad5f58a10d24b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/observer.js\":\"0a35d7da45ca60f6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/reconcile.js\":\"39c3f815a2ce0511\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/timingMetrics.js\":\"fa232f71f35e29e1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/treeQueries.js\":\"a3f71b9dada36473\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/txEngine.js\":\"9d1258ba268b23a1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/txSnapshots.js\":\"9325a2d545860293\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/typedBlockQuery.js\":\"da4e67449b09e3a4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/undoManager.js\":\"31edbaab49155e8a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/invalidation.js\":\"aac4d4cde7cd31da\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelDataExtension.js\":\"c44c254ccc83eaf0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelPage.js\":\"22fd6864b72c3ed9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelValuePresetCores.js\":\"ff60983227d6aefa\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbCorruptionSignal.js\":\"f9ea6536699a5546\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbStorage.js\":\"776fe502f9522cc7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbVfs.js\":\"57579153738becd3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localSchema.js\":\"05b40f97e803035a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/maintenance.js\":\"67c1adc92ff1db80\",\"/knowledge-medium/pr-preview/pr-1858/src/data/mergeProperties.js\":\"da044a4aa22b0ae6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/metricsConsoleHook.js\":\"90b6db783f632203\",\"/knowledge-medium/pr-preview/pr-1858/src/data/migrationsPage.js\":\"080e7bab848b265c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/mutators.js\":\"c4afb0a59d8e9e2c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/orderKey.js\":\"37ce31ccd193f215\",\"/knowledge-medium/pr-preview/pr-1858/src/data/orderKeyPlacement.js\":\"dbeffa23927ea744\",\"/knowledge-medium/pr-preview/pr-1858/src/data/outlineSurface.js\":\"3132c1cfcf9b7d95\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pendingEditorContent.js\":\"5ad6c902edd9fc9e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pendingUploadsSql.js\":\"2f82efa2d1c66575\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pluginStateExtensions.js\":\"8020b17b8fad2761\",\"/knowledge-medium/pr-preview/pr-1858/src/data/powerSyncLogger.js\":\"09f96a39564b9741\",\"/knowledge-medium/pr-preview/pr-1858/src/data/projectorRuntime.js\":\"d400679a2a36edf3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/properties.js\":\"08b30547ee9e1447\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertiesPage.js\":\"80749f5c7c9cd404\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyChildren.js\":\"5647f24a2c02039f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionFanout.js\":\"d5606dacffc09a0f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionMetadata.js\":\"aac0f3b16cb37ded\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionRegistry.js\":\"e1dd5a4e38990a74\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDisplayMode.js\":\"6c0c556f52776b09\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyRowCreation.js\":\"d0d3101e08c10758\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertySchemaCreation.js\":\"f38568caa881f4a4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertySeeds.js\":\"452a11db063b545d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/recentsPage.js\":\"acf003ab2803899e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/referenceBlock.js\":\"8c931494d5cade40\",\"/knowledge-medium/pr-preview/pr-1858/src/data/rejectedUploads.js\":\"e7172e504134795d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/releasePowerSyncConnection.js\":\"49c376b9332192dd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/repo.js\":\"a99887b099622920\",\"/knowledge-medium/pr-preview/pr-1858/src/data/repoProvider.js\":\"cf116d2d311aeea7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/rowProperty.js\":\"e9af1d94c4f72f67\",\"/knowledge-medium/pr-preview/pr-1858/src/data/searchFilter.js\":\"239b882f8f7b0871\",\"/knowledge-medium/pr-preview/pr-1858/src/data/seedIdentityLedger.js\":\"e5bc06c7f17bff93\",\"/knowledge-medium/pr-preview/pr-1858/src/data/stateBlocks.js\":\"7af8b987e4e9adb0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/structuralEditPolicy.js\":\"f78304b96097d4f3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/subtreeDelete.js\":\"1d6d063937a1a423\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncStreamLock.js\":\"7dfa0c93e3a98f31\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncedTableSqlRecognizer.js\":\"8ca7a41ab51b3ff7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncedTableWriteGuard.js\":\"2766cd6c1e00ad52\",\"/knowledge-medium/pr-preview/pr-1858/src/data/targets.js\":\"f06b1a21d1296a3c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeColors.js\":\"e4dd4a6c44cd85f9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeDefinitionMetadata.js\":\"87edcfa9ee68f2cd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeDefinitionRegistry.js\":\"09f338f03ba8d4c0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeExtraction.js\":\"38fa2586d1466858\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeInitialValues.js\":\"b39971062475a37d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typePropertyGroups.js\":\"ae825530a2723ba0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeSeeds.js\":\"4e52b1ef24b47d6d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeTagger.js\":\"dd157efb3464bf47\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typedRecords.js\":\"310ad85f53c4d351\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typesPage.js\":\"f67892fd2716e0c4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userPrefs.js\":\"6b0cfa986542d1ea\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userSchemasService.js\":\"f58b635375d89bbf\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userTypesService.js\":\"5c768ce945c7fb35\",\"/knowledge-medium/pr-preview/pr-1858/src/data/valuePresetRegistry.js\":\"9ce6160f6afb4043\",\"/knowledge-medium/pr-preview/pr-1858/src/data/visibleChildren.js\":\"ab4e8a4f1a6d8ff6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceConversion.js\":\"f0ef2fdc526286b0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceFirstSync.js\":\"e5ea0c65f17f1d29\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceIdNamespace.js\":\"afbc2373c7ae79e4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceSchema.js\":\"4f5563fb6f599818\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaces.js\":\"cdea6daa92b2bfa5\",\"/knowledge-medium/pr-preview/pr-1858/src/data/writeAheadLog.js\":\"85e8df81639cafad\",\"/knowledge-medium/pr-preview/pr-1858/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/BlockPasteShellDecorator.js\":\"b0919678b3f5a332\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/atTrigger.js\":\"5d3727636cc41cf3\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/autocomplete.js\":\"dae0fef830ed8a20\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/codeMirrorExtensions.js\":\"4b73ce2d1ebf2135\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/contentFlush.js\":\"6a740f90c4361906\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/defaultInteractions.js\":\"f2478a3bca6f851f\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/editSettleSignal.js\":\"9dc67140477feff9\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/insertImage.js\":\"e88ac32cba1d1b42\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/referenceCompletionRange.js\":\"8ad261f4d1b2a378\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/referenceTargetTypes.js\":\"a6b13559a1bed3bf\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/syntaxContext.js\":\"9f58e7fd681a596d\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/triggerMatch.js\":\"a97fa9b20194b3c5\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/AppRuntimeProvider.js\":\"c2c1fbfd2ef6bde7\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/BlockFocusShellDecorator.js\":\"7211990d4c578123\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/ExtensionRenderBoundary.js\":\"11bc01504f5272cf\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/PanelContentRecovery.js\":\"b9e87b6d01455bfc\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/apiCatalog.js\":\"d11c125d381dc6ca\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/approveExtensionHere.js\":\"b88cfb446bc6a0d1\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/armedCutAppMount.js\":\"a3cc586e04b0cd3c\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/batchableKeyedStore.js\":\"3758b331cbfd6025\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/blockInteraction.js\":\"d3c0268679fd1058\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/blockSelectionAction.js\":\"b8b175cd5c37ef38\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/compileExtensionModule.js\":\"d6ac21a6970b67d5\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/compiledModuleCache.js\":\"3443ee16c4ed2c68\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/continuousGestures.js\":\"adbd94c91a82aaf3\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/core.js\":\"1d17fda59a8427cf\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/defaultRenderers.js\":\"dbf52c2f9648e445\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/definitionFanoutAppMount.js\":\"8a85cf28d571cc0d\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dialogAppMount.js\":\"7921e943f70ef8da\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dynamicExtensionSeeds.js\":\"aca687e53b49f0b7\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dynamicExtensions.js\":\"7ca0506b83b1e91a\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/exampleExtensions.js\":\"c22ac57484d51ba1\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionApprovalStatus.js\":\"90e0b461da692812\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLoadErrorToast.js\":\"8c1db50b31a06de6\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLoadErrors.js\":\"e75cdd4463f62bb4\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLookup.js\":\"7970392721cf28d7\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionToggles.js\":\"74d3b792deaa3926\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionUtilitiesCss.js\":\"dd5a3040045392bc\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/kernelPageDeletionGuard.js\":\"7702aae37a327dae\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/liveRuntime.js\":\"f7f460e51c6d2c89\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/openExtensionsSettings.js\":\"0eaf448c725d7fe8\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/overridesCache.js\":\"389f6891fe1686fb\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/pluginIds.js\":\"d6d073f57a05e4ef\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/processorRejectionToast.js\":\"94b94e7b3ef5a4c2\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/runtimeActions.js\":\"6e8762750076f8ff\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/runtimeContext.js\":\"cf9dfe3a1592c306\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/staticAppExtensions.js\":\"ed53c7b5c07fdf9f\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/staticDataExtensions.js\":\"d815cb1ef9393de4\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/toastAppMount.js\":\"a2f5d87da3881c69\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/useOverrides.js\":\"01c4d606845d0106\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/useShortcutSurfaceActivations.js\":\"880689b2f4dd366e\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/discoverToggleTree.js\":\"d9f47acaf88cbed7\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/facet.js\":\"e7594bd3a835eed6\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/resolveAppRuntime.js\":\"8488717e7a684587\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/runtimeEvents.js\":\"e48539e8b9d08b78\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/togglable.js\":\"27233cc5e0f54da2\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/variantFacet.js\":\"ad090662b299e9de\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/verbFacet.js\":\"ad02659349683bee\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/block.js\":\"e3ca48e3f49dd6bd\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/focusedChild.js\":\"8d1339c07381e079\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/propertySchemas.js\":\"9865f63f960cd327\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/typeRegistry.js\":\"f8caf7028352ff08\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useAncestorCrumbs.js\":\"6c90c13e294825e8\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useAutocompleteListbox.js\":\"856abb3763ee7ea8\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useDebouncedSearch.js\":\"5ac8df4ea5d61143\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useDebouncedValue.js\":\"83991e54308b4569\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useIsFocalRender.js\":\"b026ffde13f59c9e\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useIsReadOnly.js\":\"bce67249fec7c626\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useMaterializeBacklog.js\":\"002e0f471d1eb0a3\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useMinuteClock.js\":\"4c2b16c8aacaf77d\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/usePanelLayoutProjection.js\":\"56408b2da9f50d2c\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/usePendingInvitations.js\":\"ec456b6c2c110632\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useRendererRegistry.js\":\"eda6a6bb424f57e7\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useRetainedFieldRows.js\":\"3b1b74bba85a2c56\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useWorkspaces.js\":\"835833a1745289a6\",\"/knowledge-medium/pr-preview/pr-1858/src/lib/utils.js\":\"89f3a58464142b99\",\"/knowledge-medium/pr-preview/pr-1858/src/main.js\":\"cea93746b9ab5894\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/MarkdownImage.js\":\"c1aeece985e23033\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/blockSeparators.js\":\"2c5db7b10f580d1c\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/context.js\":\"fef76379e0873204\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/defaultMarkdownExtension.js\":\"ca4d8742fe3b2e24\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/extensions.js\":\"8a514cd3dd886067\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/renderMarkdownHtml.js\":\"38b1b63f2b692376\",\"/knowledge-medium/pr-preview/pr-1858/src/minimal-editor.js\":\"79bb6d7434d531f1\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/armedCut.js\":\"0a5d3ab9f391b9cb\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/captureMediaVerb.js\":\"68b95129a7fcdc52\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/clipboard.js\":\"d20708c5217c034a\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/decision.js\":\"9f428ea5656b09b5\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/operations.js\":\"63d672c1a84d1e30\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/account-header/AccountHeaderItem.js\":\"b73b02969fcee67b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/account-header/index.js\":\"e31905f3faf23394\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"60451ed29c815c23\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/askAgent.js\":\"3cb363d750ee825c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/askedStore.js\":\"d654b0385402352c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0016c5504fde330c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/chipState.js\":\"e85a1b2ea445d265\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ceccabddbb29219d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/index.js\":\"d0ffa075228f9261\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"aff363c8bef54acc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/schema.js\":\"96b82505a3be5241\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e67e900ceaa90fe1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/BridgePairingDialog.js\":\"265b9024810a13a8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/addMedia.js\":\"d813d4bc60f22034\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4d4d264dfed76a4e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/block.js\":\"6eaf9efc51104609\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/context.js\":\"ac103674a509c39f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/displayIds.js\":\"83bcb3527ff211df\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/index.js\":\"ab5a0959ce1cd2a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/outline.js\":\"97ad6792dd77f009\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/properties.js\":\"fc6b9cac7271a899\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/refs.js\":\"ce6e62cf23936559\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"19a3782ce760e8e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/search.js\":\"e803c2a12d9f08f2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/shared.js\":\"163abbfb50075566\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c3ec02e82c4f4c1b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/text.js\":\"ad7de7a1c16ceff3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentWrites.js\":\"9bb0d554383cf631\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/authoringCatalog.js\":\"a6a0c6906eaa1b43\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/blockRefTargets.js\":\"064ddf0915cdba34\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/bridge.js\":\"1449cfd01c2c2e1f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/bridgeLoop.js\":\"588efc2b34738cb6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/changeHistory.js\":\"25931dfce40de08c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/commands.js\":\"0e7ec45b029462fb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/commentsCommands.js\":\"36303d3ef7e9a267\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/dataExtension.js\":\"f1f987f6b84a1277\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/dataModelGuide.js\":\"dbd27fbe6a80ebf7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/describeRuntime.js\":\"dbec1060c7165f85\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/extensionLint.js\":\"f341d17965c37de6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/grainAudit.js\":\"7b95986c74494f8f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/healthCommand.js\":\"a612d01f867f816d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/index.js\":\"331a0728503dff54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/presetIdentity.js\":\"837c5cf59507e709\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"072674f12443751c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/readMedia.js\":\"66ab99e6e7b5e9ab\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/schema.js\":\"aa2b4eeeb323b762\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/serialization.js\":\"6bba58e60787c1ec\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/targets.js\":\"2b3fc06625cbed00\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/tokens.js\":\"d19f1ecbf4e43212\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/watchEvents.js\":\"6bcf3062acdba745\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/workspaceGuard.js\":\"eb6a49094cfe8c10\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/writeCommands.js\":\"9f05ff71cada2260\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/AliasCollisionToast.js\":\"3feb63c024811afd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/DuplicateNameBanner.js\":\"0512696fca9da521\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/collisionMerge.js\":\"19b6f799fd9c2abf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/dataExtension.js\":\"f1f5e3f6cd5732a4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/index.js\":\"fb829edea5cecf78\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/mergeCollisionAction.js\":\"92830d6f3dbc8d38\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/pageStyling.js\":\"d56deb826cea79ea\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/rejectionToast.js\":\"52c5c477089b1b1a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/syncProcessor.js\":\"84c5956e5bfbcba0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/actions.js\":\"b3602b62946f0203\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/addComment.js\":\"060269a164b194db\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/anchor.js\":\"0a743997a4b79e58\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/anchorState.js\":\"c504289d009a1aff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/commentLinks.js\":\"2d8b592148c1f2be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/confirmThreadDeletion.js\":\"feb384bc82bd2348\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/container.js\":\"f377ab750f0cc9d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/dataExtension.js\":\"3b9fd6e270057ee6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/deleteComment.js\":\"4a1e8b766f5bb4f4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/highlights.js\":\"1a20e3a643d113a6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/index.js\":\"e551584aed8b9130\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/linkedCommentsPill.js\":\"41d034faf6406dfa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/margin.js\":\"8389fdcb74c586ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/marginSchema.js\":\"b05d7685bebc6a21\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/newComment.js\":\"38d5601296936a90\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/ownThreadPicker.js\":\"31495cfd6c3c3e8b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/placement.js\":\"493fe028442b1b25\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/queries.js\":\"df227199b8efe5f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotePosition.js\":\"0a7eba95055c62f9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotedIn.js\":\"6f014378b7348582\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotedRange.js\":\"c278d819c97375a3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/rangeRefs.js\":\"2a77766e79ad10d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readHighlights.js\":\"bdb5b64fe32280ad\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readSelection.js\":\"f91f2e035675d601\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readSelectionUi.js\":\"c85452fadbf8dffe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/reanchor.js\":\"86c5c1eaedafc86e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/schema.js\":\"a578807e69dc6eb2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/scope.js\":\"cd693a8cd0e9c690\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/scopeThreads.js\":\"7ec22bb327f097f2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/splitRetarget.js\":\"52bceff861715d07\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/suggestionCard.js\":\"1ec21eac1c8e6cc3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/suggestions.js\":\"7f56ce7e3cb32720\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/summaries.js\":\"b81763aa2dac74ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/summaryBatch.js\":\"757e287f233fc5fe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/surface.js\":\"665faa20d7eb52b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/threadNavigation.js\":\"441c36a8d87b5f57\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/threads.js\":\"2c9b846bb744464c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/ui.js\":\"0ed1b539f0a08d9e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/uiStore.js\":\"a8423b57b4ef5749\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-intents/appIntents.js\":\"9d5de223b94397b5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-intents/index.js\":\"f2d3906fdeaf2a45\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-update-prompt/index.js\":\"bf1e7c85215be64d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-update-prompt/status.js\":\"16129c66a0ae89b9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"24be2621e3f74196\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaBlockRenderer.js\":\"136f3d9d6f0cf3cb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9e16bafa0bc3620e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaUploadReconciler.js\":\"d7cd651eea1e737a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetDownLane.js\":\"85b461af521987a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetResolver.js\":\"55749c1fca1085aa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetUpload.js\":\"8082009ea15dc1fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/attachmentCleanerIO.js\":\"8924253b04f69100\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/supabaseAuditIO.js\":\"656fce4957271911\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/blobStore.js\":\"8b316ab16ad32c17\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/byteStore.js\":\"9240c0ade5135214\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/cleanerIO.js\":\"b42bde08ed62828b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/cleanupAttachments.js\":\"fd2425d603927e3f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/dataExtension.js\":\"25f211da271faec1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/downLane.js\":\"436a243fa0d4008c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/index.js\":\"a99eaacf50e50ff8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/insertImageContribution.js\":\"104925798c7e8fa5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/laneArming.js\":\"f30ec3a0fefd33a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/laneLock.js\":\"b0d64eb3e056fc36\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaBlock.js\":\"2976f75a7d8e5ef1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaCapture.js\":\"80fbeb1880beede6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaLanes.js\":\"50107543dd2e3b8b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaViewers.js\":\"f87a46b5ab6e012f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaViewersFacet.js\":\"c6116f79d9cd0a86\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/pasteCapture.js\":\"c417d8197366ce23\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/resolver.js\":\"e982bec28c2d71b0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/retryUploadsAction.js\":\"d6a792e0e63fc714\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/storagePaths.js\":\"fa5dfc54fbfe29a4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadDrain.js\":\"1e5025df66846630\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadLaneStatus.js\":\"dcc7eb4bda708ca4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadReconcile.js\":\"18079c86dae9cc4c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadRecovery.js\":\"0d9fd08e2f9f471c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadStore.js\":\"5eed005b4ddb60ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/useAssetObjectUrl.js\":\"31ed18b39bbead2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"380a153b90108359\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/BacklinksViewSection.js\":\"453111e937a87c54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/facet.js\":\"a8aaf542878ad3b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/index.js\":\"ca3568085ba51ab4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/prop.js\":\"8a26a0059b97bf66\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BacklinkFilters.js\":\"da1114d499559636\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1ea3219602e700cc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BlockEntry.js\":\"1e3035c6d2e17093\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/LinkedReferences.js\":\"96380ffee3bb7563\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0f2f400d37bd1186\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/dailyNoteDefaults.js\":\"5276206358f07f6c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/dataExtension.js\":\"ea86443dd8d22ea7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/edgeExclusions.js\":\"818f6a579932de6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/filterProperty.js\":\"3ee5c225f57b8f82\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/index.js\":\"1eadeef19961bbc9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"94050943914173b5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/applies.js\":\"fb5d7cc402e27b5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/countQuery.js\":\"65e19b46a61e1811\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/expansionStore.js\":\"19a1966aa8dbcc6c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/index.js\":\"0defd6d2060f47e9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"39bef45c0e275070\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/presentationInvalidation.js\":\"823fb87192c35bc8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/propertyEditorOverride.js\":\"55cad0213a1de08e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/propertyFilter.js\":\"a594978e997eebdb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/query.js\":\"ebb9d00ae405b966\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/resolveFilter.js\":\"dc1bad68cf2bec2a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/sourceBatch.js\":\"2b7bc56ed4906762\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/sources.js\":\"9dbb5bbd766c59a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/useBacklinks.js\":\"0c8bef57868a47be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4e4a611a21e2c6f1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/BirthdayCelebration.js\":\"cbaf81b111bca4d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/BirthdayOverlay.js\":\"96497cdbce7db8c0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/gate.js\":\"cc3e5b33eea64599\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/index.js\":\"3d60db58c1d1c6d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/wolfTheme.js\":\"9c819b09646b7894\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/BlockDragLayer.js\":\"0cbe00cd74536cd9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/dragController.js\":\"0adef07f768f029b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/dropTarget.js\":\"2202a4aa69be9200\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/index.js\":\"1b933d5aebbb06f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/projection.js\":\"27e9152097ad5eb0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-info/BlockMetaCard.js\":\"98f065eae811e766\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-info/index.js\":\"30b5633167312b5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/AddTagDialog.js\":\"1c6238e44075c54a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b1fdb7a02f066bff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/TagNameIssueHint.js\":\"1e58175096e26a38\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/addTagAction.js\":\"8c77bcb0f197793c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/appendTag.js\":\"b2c38441cf58b274\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/config.js\":\"106c84142add5458\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/dataExtension.js\":\"a91b168acfd1204c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/index.js\":\"72f27a2c1ddff3a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/propertyEditorOverride.js\":\"9e777b00911f2711\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/BreadcrumbList.js\":\"06b37b3e426a77a3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"54a664a2d83a9b8d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8d3ea14236f4d3a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7af58f30e35512e6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6449287133d1f630\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/index.js\":\"88f7fa9273da43cb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cd6905602ca71cc7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/CharacterCountItem.js\":\"c6df8a76c74df91d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b9f4bea8dbb76d7e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/actions.js\":\"42ab89de1fb5674d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/blockType.js\":\"1faa85cea4462d9c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/charCount.js\":\"99c325f77fbcb541\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/dataExtension.js\":\"90cb4acd5e8d6300\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/index.js\":\"97805bc1fc5d6f66\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/profiles.js\":\"c65e53bcfe648eb8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/properties.js\":\"040e080dd2fa007a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/textCounts.js\":\"a49e3a4eb52fe5eb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/colemak-keybindings/index.js\":\"058bc6a057765fd1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/CommandPalette.js\":\"2781e717faecbf11\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/HeaderItem.js\":\"f38f2e66cff4ed8d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/context.js\":\"ce8a2c3dcdacecbe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/index.js\":\"c77d10c0b5b11782\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/selection.js\":\"fc0e98bcad3a379e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/toggleStore.js\":\"dfa9df83bf93c5da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/useCommandPaletteActions.js\":\"59eb2be0ea441e34\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/ContributorBadges.js\":\"059c57f169d01013\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/author.js\":\"996fbffe270ff5c0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/codeMirrorExtensions.js\":\"550dfe397cf12ddf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/dataExtension.js\":\"0da79f99fc326844\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/index.js\":\"c26deca8a31f2394\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/mentionAutocomplete.js\":\"f8a540b519d1be57\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/processor.js\":\"6fd4ac4f3ba27ea6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/profiles.js\":\"140de037d4502284\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/queries.js\":\"a8db3720a72d9b47\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/schema.js\":\"f7c15190d689eb97\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a900be02f520ef35\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/followOrigin.js\":\"83cfa2f4aebfe4a8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/index.js\":\"419e8756e63d28e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1681bc50caa7bf51\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"33971b189d2d5320\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/CalendarGrid.js\":\"a138fa38d8e49b2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DailyNotePicker.js\":\"b259bf0ca6833a93\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3e30c78aeba7334e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateNavDecorator.js\":\"b037e9028b43ed59\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateScrubOverlay.js\":\"044716b09f56877a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/HeaderItem.js\":\"8b5c31c29f1f6ea7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/ReschedulePicker.js\":\"09ac04957146c28d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5d3884b3a5e987f1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/actions.js\":\"2f2c6cf1aea58f73\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/blockDateAdapter.js\":\"fd6885f7b5e72e3f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/calendar.js\":\"1a372318a7d72498\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dailyNotes.js\":\"ab42d05c7e6bc95f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dataExtension.js\":\"430da75f9b05fede\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubActions.js\":\"ac7bad8518054f8f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubGesture.js\":\"9ab6585da16bb7b6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ef293b91f264f14f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1cdd8ace699482b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/deletionGuard.js\":\"305f62a6dd70da6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dueQuery.js\":\"ab1380d6efc0bd75\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/index.js\":\"086e31af4fab72d5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/landing.js\":\"0d7a03a252f2c3f0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/localSchema.js\":\"5f071b7a4a74aeea\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/referenceDateAdapter.js\":\"0329f8ca3a7793c3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/rescheduleAction.js\":\"7bfda83483f5f641\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/schema.js\":\"4a3b24922b0aca9c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/spreadBlockDates.js\":\"ff574a718f0dbd91\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/spreadDatesAction.js\":\"50d3abcc7dff99d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/today.js\":\"de3d5fac469dfa2a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"35be375ab670fb1e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6259a67e4725bb6c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/audit.js\":\"fe6bbee0fe8999e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/auditAction.js\":\"6918e2f303d358d0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/auditRanges.js\":\"825483c3a3afd4d3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/diagnosticsSource.js\":\"24baa96d8a43029f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/divergenceScan.js\":\"dd838b62f718f47d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/index.js\":\"1b25ec48ad53bd70\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/propertyChildrenChecks.js\":\"81352534d4381d61\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/referencesMirror.js\":\"90810d2be164add2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/rowJson.js\":\"f5b02944c576d448\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/schedule.js\":\"4f74dba5f2da4753\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/store.js\":\"70745578a9f05a85\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/action.js\":\"2ca6eee348e48799\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/index.js\":\"67cde31796ff3fda\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/plugin.js\":\"b939517e52c4c4f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"16915aa00f602bdd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/actions.js\":\"7776173dc9b35b8a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/changeMarker.js\":\"39d20bb968ca189a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/diagnostics.js\":\"ff249a762a559975\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/fileSystemAccess.js\":\"70cc2de75306379f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/filenames.js\":\"2b82c3c3b0c0d556\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/index.js\":\"ee9717b66518676b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/mirror.js\":\"b8425796187208de\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/runLock.js\":\"aa94d5e841533072\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/runtimeHealth.js\":\"7360a2316ffe1aa4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/schedule.js\":\"4c5df088a75d34a8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/store.js\":\"0c9ff231d44e4d61\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/default-themes/index.js\":\"6b3a581c575f6dd6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/default-themes/themes.js\":\"2ff5566f9ef9829f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/diagnostics/facet.js\":\"0b0bb35c47200c98\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/diagnostics/useDiagnostics.js\":\"38c43dd2ddbeb024\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/dismissals.js\":\"c6e46bfe1e279b78\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/index.js\":\"2267cdb6b781fbb8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/status.js\":\"4e48662f0503e92d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/store.js\":\"132e4d8957c7b24c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2d5ef1d035fd383f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bee860343d44025b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/actions.js\":\"48f389741c16a318\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/config.js\":\"9867238770f8ad5a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/dataExtension.js\":\"b686f0fc9b4e6227\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/effect.js\":\"3b4305274957d313\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/index.js\":\"aac34f66c1ab4227\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d1a4851ae79abaeb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/useToggleTree.js\":\"8c4e4834dcf6f7da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/ExtractTypeDialog.js\":\"0b6122e57222bfa6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5dc7cf39b52f310e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/PropertyShapePicker.js\":\"b7b0124a06b47b1c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/action.js\":\"3bf69fb845b04a7c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/index.js\":\"cdbf58eb21456553\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/FindReplaceDialog.js\":\"883b3d892084944e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/HeaderItem.js\":\"c19c97f5f2e51edb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/dataExtension.js\":\"156b6bec6558ff6c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/index.js\":\"e9b5d9a5fddd715d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/search.js\":\"9abf625d3ed397b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/toggleStore.js\":\"5dc3d2e922237726\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/LocationPropertyEditor.js\":\"1d15313381e9142d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/MapView.js\":\"4cbe2d4117739e0a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/blockTypes.js\":\"5d0207cb94eb3236\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/codeMirrorExtensions.js\":\"9d0939cf9a940efc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/createOrFindPlace.js\":\"2b4d845341230227\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/currentLocation.js\":\"7f6a80477aafcca1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/dataExtension.js\":\"81ccb581b551a3bd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/geoContentDecorator.js\":\"729721fb339df35b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/googlePlacesClient.js\":\"771986c865245d8e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/index.js\":\"70ad500e93f755c2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/locationsPage.js\":\"313fef28a424d450\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/mapViewport.js\":\"55cd66a2a770b157\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/pickCurrentLocation.js\":\"c8b24955ee36d2a9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/placeAutocomplete.js\":\"a35ddee0fe231db0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/placeNameCollision.js\":\"2d186c2ae69a5757\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/properties.js\":\"18cc9fb85ecf4339\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/propertyEditorOverrides.js\":\"0d4259db0c470ae6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/query.js\":\"142b2f371f3ce652\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/usePlaceSearch.js\":\"de9026294546a6fc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c31e0b69640d2c98\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"01b2273b5967f5d7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6aa55f839738c642\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/config.js\":\"f2daca533b732c2b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/dataExtension.js\":\"c88096f6fdc12536\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/facet.js\":\"0d9a15bf779b3b73\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/grouping.js\":\"3140c3c7eaa1fbb4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/index.js\":\"934b60afe1e1de20\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f5337d1715538293\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/query.js\":\"634277f5334f19af\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/resolveConfig.js\":\"25eb0abf3b3ab2d6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"289ad8c203f988d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6ca25ccaea4b9701\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/HtmlDocumentContent.js\":\"2f713c01f7e803b2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/HtmlFrame.js\":\"9de07b348af04202\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/actions.js\":\"389e651f44ebcc96\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/blockType.js\":\"733483dfbddffec9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/confirmRunScripts.js\":\"d7b4fc4db49b3741\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/dataExtension.js\":\"452dba4a3017a753\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameAnnotations.js\":\"3693ef78a51fcc0c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameDocument.js\":\"5a2d06ba44c6fb8b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameTheme.js\":\"a02114cb00de4e92\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/index.js\":\"ca665a5c53b80be1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/scriptConsent.js\":\"972223295171f19d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/sourceMap.js\":\"26feb89c55f63ce8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/useDocumentScripts.js\":\"30d199b7ff6929a4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/index.js\":\"782c9a4fd4998860\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/record.js\":\"dbd513d0ab34201f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/recordStore.js\":\"5101d4f41a2c42da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/responsiveness.js\":\"71116869f5ee513e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/schedule.js\":\"fd15489a90f3cd7f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/sessionContext.js\":\"371837a01eebeaf1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"39aaf279a0ee45f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"29ec997fc59733ed\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/actions.js\":\"1523fbaa8c07e589\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/config.js\":\"2b724704a7263eb5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/dataExtension.js\":\"93b675f4d9a4460c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/effect.js\":\"486422a2af0946ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/index.js\":\"44a5bc32363c9d37\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/keyCapture.js\":\"0c6692071048d6b2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/overrideStore.js\":\"5ea874890bdc8b4a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7ba32f3336007296\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/HeaderItem.js\":\"2270c2b7806a4999\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/LeftSidebar.js\":\"0b664e3c1805920a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/actions.js\":\"65ef726ac7a7751b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/facet.js\":\"1a654095929b446d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/index.js\":\"c2d0d0e643e64221\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/shortcuts.js\":\"adbfe933780be6db\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/toggleStore.js\":\"7ab584a6d9171011\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/MergePicker.js\":\"ce0f7f43d6f5392a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/index.js\":\"411e80807a0c7e36\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/mergeAction.js\":\"6c922ef8dcc3bed1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/strategy.js\":\"1e4ee28e2bf1bee3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/Button.js\":\"805efdafce2e9ab1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8ac8f35e6eb679e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a7cbef73291433e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/facet.js\":\"68c9d39d78fbaed8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/index.js\":\"2563a15d9cfcf1c1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"edfe971eb7adb4a5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3724f7b18472bb39\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6280f5d0021f7e48\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/facet.js\":\"cd7656a5266ec68d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/index.js\":\"79c1e23fe12f1484\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6d2036fd95dcba05\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/blockSubtreeMembership.js\":\"552e8d44a29d9281\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/contextMenuItem.js\":\"f5ed56344def3ec2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/index.js\":\"58bc7f5ae27adaf8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/moveAction.js\":\"aae3da9447971393\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/moveBlocks.js\":\"d6d4c2ec1dba363b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/selectionAfterMove.js\":\"979fe3d4ca923d48\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/TutorialBanner.js\":\"072e5c4b3014536d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/action.js\":\"be24ec54ec27ab85\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/bannerDismissal.js\":\"ef4d1052f3c18986\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/documents/cheatSheet.js\":\"6191ca5a6c0cf243\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/index.js\":\"dfcaf50f6bbdf1ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/keys.js\":\"5ad8f84d8c352528\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/landing.js\":\"779e41c2a8bc36de\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/outline.js\":\"e17be871cd89b115\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/seed.js\":\"064bdae923b588bf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5f4c61466c960a65\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/analyze.js\":\"54ff37d1e423a972\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/diagnosticsSource.js\":\"1ec9713a415452ee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/index.js\":\"2cc69c92d53532fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/load.js\":\"8652c20efc525493\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/monitorRun.js\":\"8ad7916fcabd4651\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/schedule.js\":\"5a8a1096cb700081\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/series.js\":\"9b16686f9251658f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/store.js\":\"4fcdba5ded1bcc64\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/trendAction.js\":\"be0a5aca54c54002\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/verdict.js\":\"0ca5585db702ac0f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/clickToEditAction.js\":\"057159065b92b8b6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/index.js\":\"445bd41a67dabadd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/interactions.js\":\"de5552e4cef14010\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3a5f1bcd2440c2b5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/MigrationGate.js\":\"7ce3ca8873404f7e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/MigrationGateDialog.js\":\"2f05be2779462792\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/action.js\":\"dcf8bff7e9bf2a58\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/index.js\":\"d1685e43b2b4e676\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/localRunMessage.js\":\"fd5b5ca8cac6c4b2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/plugin.js\":\"eac149d312a2fe70\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/progressReport.js\":\"254eb9caa776fc51\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/sweepProgress.js\":\"b43b383a8ce024d2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/FieldRowRenderer.js\":\"4631e63d6404d3f2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/ValueRowRenderer.js\":\"e41a05741e2e2940\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/actions.js\":\"dc1fb2e6171b385b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/autocomplete.js\":\"ea87a8dff2c6c6e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/fieldRow.js\":\"78611ae9a8014956\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/index.js\":\"ac5ae59b1ba97d66\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/referenceWarning.js\":\"eb76d301bf8273c2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/valueAutocomplete.js\":\"f8388375a4e17321\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/valueSchema.js\":\"a9940a937da4209a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/HeaderItem.js\":\"d9eafa6b1fc6c67b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/QuickFind.js\":\"b5723bc176ac3fc2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/index.js\":\"47772618189c3fc8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/recents.js\":\"4057c12903de3bc0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/resultItems.js\":\"c0b343380c0f061d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/selection.js\":\"c021d75c7b47adbb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/toggleStore.js\":\"c081376b90e362cd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/HeaderItem.js\":\"996a9a72b26e203a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a59b50f5bbce4518\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/grouping.js\":\"884446ba814c67d5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/index.js\":\"208b55c7679cfc32\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/target.js\":\"ac9cf0ba4e57224a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/codeMirrorExtensions.js\":\"333c5b6bbbfb7df7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/contentPrefill.js\":\"22afb14508e55e7f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/dataExtension.js\":\"ac3d89de5e1eee07\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/index.js\":\"bcc7fbd61ba42312\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"65cbb3ce490787f0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/invalidation.js\":\"f31c6ef6b1ebbcd1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/localSchema.js\":\"709de89f13d345e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/blockrefs/index.js\":\"169cc099284a5681\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8e4bfcc15e7aae67\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/index.js\":\"9ed71954be42c4a9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/referenceNode.js\":\"fd0eb0f1924bcb81\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/remark-reference-occurrences.js\":\"93c9dc5e6d6650ca\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e6d38d9d51ac6855\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/index.js\":\"389455149ee9c1e7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2184f5469d84d5f8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2858e892e09348e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/mergeRetargetProcessor.js\":\"55872e8fe4681a06\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/parseFence.js\":\"d792b62f1c0e2c5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referenceParser.js\":\"267f3bc13682cbb0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referenceProjection.js\":\"d4be661f969f9933\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referencesProcessor.js\":\"37f4e082f551b304\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/renameProcessor.js\":\"381af9d79dc4fe5a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/spanReplacement.js\":\"7daf7345a24552c7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/htmlToOutline.js\":\"3834a80dcf176a93\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/index.js\":\"35f3fe6e3dc01ba0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a69619d1c6b36339\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/pasteDecision.js\":\"30da02cf5e749ce0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/action.js\":\"69f1d9d2c538445c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/blockIds.js\":\"d53e1c77f0a04728\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/content.js\":\"56ff5e550f89ac2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/effect.js\":\"0c5443a74cd9f3fd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/ids.js\":\"6b678d2889c9d227\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/import.js\":\"faf833becac8cc18\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/index.js\":\"55ca6acd796dc7d6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/plan.js\":\"7527fa94150beaf9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/plugin.js\":\"e751cf89c2b28bd7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/promotion.js\":\"f7cd436a8b03e8f1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/properties.js\":\"13fcc9001190c888\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/references.js\":\"773eb0f144f2d230\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/report.js\":\"45bd8b9ede5267fe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/roamMemo.js\":\"8f49a3e6fea3ed73\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/runtime.js\":\"d1d07862b86fca7b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/schemaReconciliation.js\":\"c5c9a114fb0da6ca\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/srsMarkers.js\":\"0befcd2ef9720b35\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/todo.js\":\"2b896ebf1e473c76\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/typeCandidates.js\":\"9ab3c0c8ce4bb504\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/types.js\":\"4f1d1cc16607ad72\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/search-health/index.js\":\"4d489d67866a102a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/search-health/store.js\":\"fd12004140aa68e6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/HeaderItem.js\":\"99aa699e17369d35\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f94c145cc3dde0db\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/index.js\":\"de34cbe3fdb843be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/model.js\":\"8c4faf954fec12ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/toggleStore.js\":\"05dc25749dc8d8d4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/useKeyInspector.js\":\"23b51b5fbc9223da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"58ec0675c77ee20d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/ShellDecorator.js\":\"4810a068853cd723\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/actions.js\":\"13b66c0d82429459\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/exclusionsFacet.js\":\"332087761474a727\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/index.js\":\"e855c5d790a3a1b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/shell.js\":\"f6df18e10b6f2237\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/surface.js\":\"34f0a3a3d298659c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/walker.js\":\"e7fa0c45a6e0efcc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/RescheduleToast.js\":\"69d5ce7e9842dbb2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/dataExtension.js\":\"fe62b2f84c94a9b0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/index.js\":\"0f368621cb0f07e9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/indicator.js\":\"fb997dea48e990d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/moveSrsState.js\":\"4eaf4e604ba762a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"14d03dd479ecd75c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/scheduler.js\":\"f77f97dc1e3e9dec\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/schema.js\":\"7177439a2ed5f7c5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"985972cc0f7c1b6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/srsClipboard.js\":\"5eb08a07c3b9c251\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"338da41894dd07cd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9d30377a9831954c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/DeckPicker.js\":\"cf50a5a65cf44ea6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewControls.js\":\"f752745e52382bde\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d309e3ae0ef2903a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewSession.js\":\"708af78be035920c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/actions.js\":\"a80f117146660da7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/archive.js\":\"c16db07ab9109e03\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/dataExtension.js\":\"7c0070d8af10eaf9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/deck.js\":\"4621055951ecb6cd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/dueQuery.js\":\"2848f80bda8cd67f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/gradeDecision.js\":\"279a898e5534326f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/index.js\":\"e2cf047508903d20\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/keyHints.js\":\"f1455f635af47767\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/reviewCardLayout.js\":\"169160f19c8764e4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/reviewProgress.js\":\"54b11d2fd2278e31\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/schema.js\":\"ac306391d0ed9ca1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/useDueCards.js\":\"68783224f82f29dc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/startup-metrics/index.js\":\"ebc43625420ff318\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/startup-metrics/record.js\":\"0d08b238bded9464\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/index.js\":\"ecd17f87339035f4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/persistenceStatus.js\":\"8a5293d3d21db10c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/requestAction.js\":\"676d992a788e2bcf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/TypeChipsDecorator.js\":\"71e16a20130bb015\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/codeMirrorExtensions.js\":\"5738c390dc701ef0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/index.js\":\"3106a6e2d87d1b8e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/typeAutocomplete.js\":\"cdf09e6f4fc68495\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"83a479ee91d1dcf1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/actions.js\":\"e36eb2a168e5bba5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/anchor.js\":\"b06f49b65e575b2a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/events.js\":\"01f5d617a444fa4e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/gestureActions.js\":\"e28053bb7cb7c8f2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/index.js\":\"5d37515cc8b69144\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1144af20996a4ff6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/collect.js\":\"cf7226c8ed237bc6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/index.js\":\"275ae97e9c4ca8d5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/record.js\":\"547414b1b6c109df\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/RejectionDialog.js\":\"e3b7522cd30dac5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9373b57b91bc9b13\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/index.js\":\"b8b255f496094cee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/model.js\":\"bb70a68e9be6c54c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/queueCounts.js\":\"ba57648d8b359bb3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/rejectedHelpers.js\":\"6104bdbb79384d06\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/rematerializeAction.js\":\"29d0ae8222c18bb9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/useHysteresis.js\":\"936c8846ac7be20b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/ColumnHeaders.js\":\"69523a2cfc0d27a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/QueryUi.js\":\"62d76b7b31715ae8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/TableLayout.js\":\"47ad0e063ee92f41\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/actions.js\":\"9b1eb4781cd10687\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/cellEdits.js\":\"4b74d8916031c52f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/columns.js\":\"927c15681e028a0b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/controller.js\":\"1a33a279c647dd4a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/convert.js\":\"5b4799a747710b98\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/dataExtension.js\":\"7b760bfd86832e00\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/index.js\":\"b6d7c47c8db2be05\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/keys.js\":\"7fff4c60ab720d70\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/model.js\":\"c16994114ead7059\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/navigation.js\":\"d018a5605d379cbf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/backfill.js\":\"9de4938f05ff3f44\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/completion.js\":\"420f03c47e14156f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/format.js\":\"7c1418363299b7bd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/parse.js\":\"bbb6cc812fde32c4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/queryValue.js\":\"215e2bf916ab83c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/source.js\":\"74ffa13e8139296d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/registry.js\":\"5e3d1b9d4f022105\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/rowGutter.js\":\"23924359c7ee8903\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/rowVerbs.js\":\"9cb41416c0b6c03c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/schema.js\":\"6f1fb2f806b4f744\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/sort.js\":\"008157ffe0b4ea61\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/effect.js\":\"2e2c65466388432a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/index.js\":\"8a4d5d231fdad29d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/theme.js\":\"ab5f6c46dfd5b6ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/actions.js\":\"4e3cdc3b8031be7b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/dataExtension.js\":\"85fe27e517a87000\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/index.js\":\"73c3f6910fc28998\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/schema.js\":\"9770059f4d7a755d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9d1b2239f44fb535\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/actions.js\":\"8346afeeffac0006\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/defaultItems.js\":\"aa63f03a09d8de40\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/facet.js\":\"6b032188c842d595\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/holdRecognizer.js\":\"c4e259865b8ff3aa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/index.js\":\"7e19259ec594bb87\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/UpdateIndicator.js\":\"fea4b21c4a50279e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/index.js\":\"43d0d1aa132acb0d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/loadTimes.js\":\"6d8d5d29980f152b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoNotesRenderer.js\":\"f4d8677e55fc8823\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoPlayerRenderer.js\":\"51b337a96ee009cd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoTimeStamp.js\":\"fcba9430f2d1775c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/actions.js\":\"afb94c06c9ed8c70\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/index.js\":\"1b4cd87de7501853\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/markdown.js\":\"4bf4aa2e3610f4da\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/notes.js\":\"6198983f20399667\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/registry.js\":\"6d4963f55b1e467e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/remark-timestamps.js\":\"c8c88ce157e73c99\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/view.js\":\"18a858c59937d823\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/LinkHints.js\":\"4024ce044b75b970\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/index.js\":\"744257e0268576f3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/model.js\":\"0ae078025f848766\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/settings.js\":\"d7d83cedd8829066\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/actions.js\":\"1f6abbe689a2fa5a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/index.js\":\"304530322628e61c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/interactions.js\":\"badd48810bf183ca\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/workspace-header/index.js\":\"3b853cbf3627348c\",\"/knowledge-medium/pr-preview/pr-1858/src/registerServiceWorker.js\":\"73fc122205a4d788\",\"/knowledge-medium/pr-preview/pr-1858/src/requestPersistentStorage.js\":\"8f074ad4491e80a5\",\"/knowledge-medium/pr-preview/pr-1858/src/services/authRequestDeadline.js\":\"59e4e70215a2d896\",\"/knowledge-medium/pr-preview/pr-1858/src/services/authStorage.js\":\"c86fce4cb7b9d1c9\",\"/knowledge-medium/pr-preview/pr-1858/src/services/powersync.js\":\"e89fe89394f8de12\",\"/knowledge-medium/pr-preview/pr-1858/src/services/supabase.js\":\"cb0aca4823322ee5\",\"/knowledge-medium/pr-preview/pr-1858/src/services/uploadErrorClassifier.js\":\"8c068466bf0781fa\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/ActiveContexts.js\":\"4bda56231f306b75\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/HotkeyReconciler.js\":\"09bbd95e033a72c3\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/WipeLocalDataDialog.js\":\"b568550afc9b17f0\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/actionDispatch.js\":\"5aadd23e9ed566ec\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/actionRefItems.js\":\"b4ce91e598084399\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/applyKeybindingOverrides.js\":\"3ee8b914c1fa6d6e\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/blockActions.js\":\"555754510f0b4dfe\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/blockMergeGesture.js\":\"60f313fb46ceb23b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/canonicalizeChord.js\":\"74f5abb8e8d355a8\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/defaultContexts.js\":\"1025ebe67b6126a0\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/defaultShortcuts.js\":\"ee019d245aebcc79\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/effectiveActions.js\":\"f8412c7b56a6dbf6\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/gestureAction.js\":\"7ac4810f95613897\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/gestureBinding.js\":\"8c30fa5924c57002\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/holdRegistry.js\":\"8ca816f56ded00f2\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/keybindingConflicts.js\":\"a8c42d57c72d290c\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/keybindingOverrides.js\":\"90c709d2aad91034\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/pointerAction.js\":\"f6a8fbfc16b19c78\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/resolve.js\":\"40c0762f4559130b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/runAction.js\":\"c23b511ea4b4bbc2\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/sequenceMatcher.js\":\"edf5bb28e0fdcb40\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/types.js\":\"3ef3225907ba32da\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/useActionContext.js\":\"89d5ab8d4ac86bf5\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/useActionDiscovery.js\":\"f3baf5808d1ecfb8\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/utils.js\":\"056285258603bfda\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/bootStore.js\":\"41ed81ad806973b9\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/previewDatabases.js\":\"5518d68ef11d94ff\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/byteTransform.js\":\"8f749044e63e21c6\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/attachmentCleaner.js\":\"49a109ea8aab0727\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/attachmentParts.js\":\"a1e842aa59a93b7b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/bundleParts.js\":\"25407a725a9e5472\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/bundleRecord.js\":\"b4b66c022c297b30\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/manifest.js\":\"c963d4bd9a6fb16e\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/takeBundle.js\":\"004aa88b2fb45c09\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/verifyBundle.js\":\"3ce51bca028bc0b0\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/cleaningStage.js\":\"19a83b20340dae84\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionKey.js\":\"527ec5f8ccbc75df\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionServer.js\":\"c2dcc04e6b26667b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/flip.js\":\"57ad7790f5bd2ecd\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/flipAttempts.js\":\"18bd67708ffb43ae\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/pages.js\":\"e76eec1431e8de26\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/preflight.js\":\"539df24d079f0e46\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/reseal.js\":\"c334ccc6b556cb65\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/runConversion.js\":\"2dda81a4a4c964b8\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/runLock.js\":\"435a20b67dab6086\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/sealing.js\":\"74d754c03e72ef56\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/sealingStage.js\":\"ec88d14da19b4d43\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/stage.js\":\"4870643432fe2fcd\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/verifyReseal.js\":\"aa8a6bb7ae0e0217\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/aad.js\":\"1dd4cc7458672af9\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/aead.js\":\"2583925eac9b615d\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/base32.js\":\"301221f2deda8cd3\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/base64url.js\":\"66139fd7cf06653e\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/binaryEnvelope.js\":\"b8ad1f43494d21b9\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/byteAead.js\":\"c9f1320f1c5826b7\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/canary.js\":\"bc90aeb14736459c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/contentHash.js\":\"22dd23525addf037\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/contentKey.js\":\"1ef3945f0ca52b96\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/derivedIdNamespace.js\":\"76ceec6b8ceeb1dc\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/envelope.js\":\"a791848408e1f852\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/hex.js\":\"45ca100429acd48b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/sha256Hex.js\":\"64cebd66d7f22801\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/workspaceKey.js\":\"00d8da210f6aec4b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/conversionState.js\":\"d2815fd2503195cb\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/createEncryptedWorkspace.js\":\"045e886a6e27c9c3\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/pastedKey.js\":\"39e469f6be9e5c02\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"cb82add235d35f90\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0859ff7625c3bfd7\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/keyStore.js\":\"af0cc0949cc4fa6c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/mintWorkspaceKey.js\":\"b2b6c4fc9ea232ce\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/modePin.js\":\"857f7ea47a508a65\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/openWorkspaceKeys.js\":\"01a4283234729b03\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/resolveWorkspaceEntry.js\":\"239a5fb69e8ead77\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/resolver.js\":\"81f00881a36e3860\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/workspaceAccess.js\":\"0b3103faa8e6430b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/transform.js\":\"5c7ac154c6925ef6\",\"/knowledge-medium/pr-preview/pr-1858/src/themeBootDefaults.js\":\"3ed84a954034283f\",\"/knowledge-medium/pr-preview/pr-1858/src/types.js\":\"6a7ca6f41d11f4aa\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/ClientLocalSettings.js\":\"0d7f7c20702b0e25\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/abortableSleep.js\":\"f352bd7e15a17fcb\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/array.js\":\"f788017836787c10\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/backlinkAutocomplete.js\":\"8b8011f991d1730e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/blockCrumbs.js\":\"201e2d99a5dc5b8a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/blockrefAutocomplete.js\":\"4b84286671e0c001\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/cadencedIdleJob.js\":\"421be29701b0bd75\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/callbackSet.js\":\"8092e417300ffa6f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/clientId.js\":\"c42943a17a9c1149\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/codemirror.js\":\"833923d67c2d94c1\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/codemirrorCompletion.js\":\"906aa64b61d90893\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/copy.js\":\"947903dd010621a2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dailyPage.js\":\"e91d488c2cf265d7\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dbForensics.js\":\"4b2981b7804f9d06\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dbForensicsHooks.js\":\"862b23d2c0fadb4a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/deleteBlockThroughUi.js\":\"25683187ff30f348\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dialogs.js\":\"c947c6438fc04792\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dom.js\":\"0e7175e34fff3354\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/downloadBlob.js\":\"f51717db525c9a93\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/exportSqliteDb.js\":\"952944c16f0b22f1\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fileSystemAccess.js\":\"82096f6439375a3c\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/flipSlide.js\":\"ea0cb06f0027f7c2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fnv1a.js\":\"1be6d45ad10fd62d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/formatBytes.js\":\"44793e277947d83d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fuzzyRank.js\":\"ba527f6142bbe740\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/idbKeyedStore.js\":\"5add9b93722ec9d3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/idleCallbackPolyfill.js\":\"db01ef7776206ac0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/keyboardAwareScroll.js\":\"075fff6102e8caeb\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/keyboardViewport.js\":\"99a3637f529ceaec\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/lastWorkspace.js\":\"1d64a9b7f5d9e720\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutColumns.js\":\"ea4e43d835d8d020\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutSessionDom.js\":\"8583d896209739e3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutSessionId.js\":\"aa644de5d4ef9cd0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/linkClickGestures.js\":\"74a20895654057de\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/linkTargetAutocomplete.js\":\"dddb8b103ed53767\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/localDbCorruption.js\":\"5b72e529b727a437\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/localDbRecovery.js\":\"5300b5f766e06210\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/markdownParser.js\":\"4adc37d51926a025\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/memoize.js\":\"9a96b5c2cb5580fd\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/nameFieldCommit.js\":\"38fb4253869dbd5a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/nameList.js\":\"45e1a876fdbcc3a7\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/navigation.js\":\"53bd80e6b8d586c0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/omnilinerNamespace.js\":\"1be2fd017b10f8c5\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/opfsPageScan.js\":\"6c7b9ef5a7f25f79\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelClearance.js\":\"0548e3d56ed50167\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelHistory.js\":\"dd18eb4c9c071c63\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelLanes.js\":\"d0425c64fd8f367a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelLayoutProjection.js\":\"69233570ea2e90f2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelScrollAnchor.js\":\"76dddc17e6d6e263\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelUrlFlags.js\":\"2b0785339073a9c0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/platform.js\":\"dba2aec260e16162\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/pluralize.js\":\"38cc8b1b481f2ee3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyCreation.js\":\"97a3e2c8230ac6ad\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyNavigation.js\":\"cbb793e939fdf559\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyValueContext.js\":\"620788dbcbe60336\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/react.js\":\"65ed7a5ed2ad96c3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/relativeDate.js\":\"b2ca3723e0d71766\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/relativeTime.js\":\"4b5eabd449ffb06d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/renderScope.js\":\"2606dee958d24689\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/resolvedThenable.js\":\"6302ad27dc175169\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/routing.js\":\"f031beff210c4a01\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/safeMode.js\":\"fa219866658387e8\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/scheduleIdle.js\":\"0abf9294da001865\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/screenWakeLock.js\":\"5dd101da37e08387\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/selection.js\":\"291927c1778c41f0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/softKeyboardGrab.js\":\"f02749700712ffba\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/startupTimeline.js\":\"49102be753943575\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/state.js\":\"72bdc586b4544632\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/string.js\":\"eecf573b37128692\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/surfaceZoom.js\":\"7ad70d3e107a6076\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/time.js\":\"fdcc2da3e02aa241\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/toast.js\":\"25449750fd2189a3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/toggleStore.js\":\"0a6760845db678cd\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/untilStopped.js\":\"adff3b49e48899ac\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/userActivity.js\":\"e45fada08c090920\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/viewTransition.js\":\"b8328e535f544111\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/viewport.js\":\"03504093db6550f2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/webLock.js\":\"8af6e9883c7d8744\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/workspaceRecovery.js\":\"15ed0c9e99aa402d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/workspaceSnapshotStore.js\":\"6bb9db5466aeba17\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-compiler-runtime.js\":\"7ba0f8baf06af7ba\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-client.js\":\"f4f313336214c5bc\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-server-edge.js\":\"d03c00712d45dec8\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-server.js\":\"4ef6d7169aa2e766\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-static-edge.js\":\"408a8b570d5e7826\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-static.js\":\"d492886cd51691b5\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-test-utils.js\":\"92738ce255059f16\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom.js\":\"daa0c3f2def84168\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-jsx-runtime.js\":\"dece0fa0d6bebf58\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react.js\":\"8e24bbb4f8955198\",\"/knowledge-medium/pr-preview/pr-1858/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1858/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1858/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
