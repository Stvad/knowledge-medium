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
		buildId: "c6c2646b5c5f-e3d61043",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/\":\"d2fd3bb32f01c383\",\"/knowledge-medium/pr-preview/pr-1858/index.html\":\"d2fd3bb32f01c383\",\"/knowledge-medium/pr-preview/pr-1858/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1858/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1858/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1858/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1858/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1858/assets/FacadeVFS-D1gtmMk-.js\":\"4406a4c7cf2deaf5\",\"/knowledge-medium/pr-preview/pr-1858/assets/OPFSCoopSyncVFS-CywVYhU5.js\":\"b34a484d4cb79952\",\"/knowledge-medium/pr-preview/pr-1858/assets/OPFSWriteAheadVFS-Bjjd1FFP.js\":\"e2b075bdfda4c8f3\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-DVCVkV2A.js\":\"75b6b421efece65f\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-async-B0bti-FC.js\":\"93d1433e6c6cae8f\",\"/knowledge-medium/pr-preview/pr-1858/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1858/assets/worker-B_BSxPQu.js\":\"cf10fb08ce41fd92\",\"/knowledge-medium/pr-preview/pr-1858/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1858/chunks/app-BLHUkaWi.js\":\"e0a8eeb32b004fc9\",\"/knowledge-medium/pr-preview/pr-1858/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1858/index.js\":\"b4471952a6fc0f43\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1858/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1858/assets/AccessHandlePoolVFS-qUoEO_Zj.js\":\"16fb83e7eccc95ca\",\"/knowledge-medium/pr-preview/pr-1858/assets/IDBBatchAtomicVFS-qCNJGVRE.js\":\"f0dc67ba9f99fd3f\",\"/knowledge-medium/pr-preview/pr-1858/assets/MemoryVFS-sTOowopE.js\":\"8303ca91f4ae3caf\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-3vYLeVVH.js\":\"a02ddd248b461e83\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-async-BVICo-I5.js\":\"a3982fd8b70a6559\",\"/knowledge-medium/pr-preview/pr-1858/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1858/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1858/chunks/AccessHandlePoolVFS-X5XiMD7w.js\":\"c2fbe8b62c5313d4\",\"/knowledge-medium/pr-preview/pr-1858/chunks/FacadeVFS-Qd0eAsFX.js\":\"7ab29dc7ec163bdb\",\"/knowledge-medium/pr-preview/pr-1858/chunks/IDBBatchAtomicVFS-BAROSo7G.js\":\"554b626d010795bf\",\"/knowledge-medium/pr-preview/pr-1858/chunks/MemoryVFS-CEb9uHmg.js\":\"819c2b2bcfaaf2c9\",\"/knowledge-medium/pr-preview/pr-1858/chunks/OPFSCoopSyncVFS-CUe11GuU.js\":\"dc295b207f426a69\",\"/knowledge-medium/pr-preview/pr-1858/chunks/OPFSWriteAheadVFS-ogoNy75Y.js\":\"ca1ca29bd2282bda\",\"/knowledge-medium/pr-preview/pr-1858/chunks/Preview-CNKrUooF.js\":\"d32ef521b4979bfd\",\"/knowledge-medium/pr-preview/pr-1858/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1858/chunks/card-C6Pa7vQl.js\":\"97257b03845f80d6\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1858/chunks/dist-CFRtMaV6.js\":\"2b57a6c309198e31\",\"/knowledge-medium/pr-preview/pr-1858/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1858/chunks/mc-wa-sqlite-async-CEgoi9Ur.js\":\"c3aa26642314fc11\",\"/knowledge-medium/pr-preview/pr-1858/chunks/mc-wa-sqlite-jpKCg9Q2.js\":\"65507a44fdc730be\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-5R5e-nVk.js\":\"3bb2341a261d560c\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-BGGMpv6P.js\":\"d1417f0567bf1c4a\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-Bzo9ebfJ.js\":\"4fc3541c86c523a7\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-CbOh0ksd.js\":\"718015a6407a2964\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-CmUz7qiq.js\":\"361f18547be2292c\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-DJw-FNdD.js\":\"469cd1db64560d83\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server-legacy.browser.production-fkbEw-cm.js\":\"73055dc29ca5b302\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server.browser.production-DIKpdodi.js\":\"af1779ab6e324fd2\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-dom-server.edge.production-DQWm6-Ji.js\":\"4641892ca45f88fc\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-oLf64swc.js\":\"223f3ef438090083\",\"/knowledge-medium/pr-preview/pr-1858/chunks/react-pQFWyeRy.js\":\"860b40e57802522d\",\"/knowledge-medium/pr-preview/pr-1858/chunks/server.browser-DKZ5yt_y.js\":\"e4641d43462dc818\",\"/knowledge-medium/pr-preview/pr-1858/chunks/textarea-lcsQiwo7.js\":\"da9bf140b81ea2e1\",\"/knowledge-medium/pr-preview/pr-1858/chunks/ui-DrMjc_xN.js\":\"3e3b04a3a3365114\",\"/knowledge-medium/pr-preview/pr-1858/chunks/wa-sqlite-async-gz4viZnp.js\":\"af5d0c9d8d1a5898\",\"/knowledge-medium/pr-preview/pr-1858/chunks/wa-sqlite-dukafiqG.js\":\"0fee3e9d9d76a2a7\",\"/knowledge-medium/pr-preview/pr-1858/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1858/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1858/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1858/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1858/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1858/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1858/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1858/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1858/src/App.js\":\"cf318d0660b079ec\",\"/knowledge-medium/pr-preview/pr-1858/src/appUpdate.js\":\"56c1b069da1e0f2d\",\"/knowledge-medium/pr-preview/pr-1858/src/appVersion.js\":\"70eff19f724aa4c7\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/initialLayout.js\":\"8ff82cd9bd49f2ed\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/openWorkspaceData.js\":\"46d0a21211729240\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/resolveWorkspace.js\":\"a81e2c36db95af4f\",\"/knowledge-medium/pr-preview/pr-1858/src/bootstrap/workspaceBootstrap.js\":\"377699c710086dfd\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockComponent.js\":\"a2a59574b870bb5b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockCrumbs.js\":\"cd01c70e4b289b56\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockEditor.js\":\"3500017884016583\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockLoadingPlaceholder.js\":\"4932938b93a7f4c1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockProperties.js\":\"ebfdf0687df2869d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/BlockSearchPicker.js\":\"587d899b6852ce32\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ConfirmBulkDeleteDialog.js\":\"09ef96765e9b348c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/DividerHandle.js\":\"03be8d8dc4b84408\",\"/knowledge-medium/pr-preview/pr-1858/src/components/DraftEditor.js\":\"6420bfe3402a46d7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/GutterPill.js\":\"4a07affd4b23d39c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/Header.js\":\"084088e413c755ce\",\"/knowledge-medium/pr-preview/pr-1858/src/components/LazyBlockComponent.js\":\"a01d6354bf9fdbb3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/Login.js\":\"2a260959595a688e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ZoomableSurface.js\":\"0707dd1296a70878\",\"/knowledge-medium/pr-preview/pr-1858/src/components/editModeKeepalive.js\":\"91d1ac3e00efbcae\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fecabcc89983c3fa\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"788c8e8e4fbd4ca2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/RefPropertyEditor.js\":\"21835080c49c1097\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/RefTargetTypePicker.js\":\"cbc41b0a985916b9\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/SelectPropertyEditor.js\":\"cf3e49cbbce43a6f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/TypesPropertyEditor.js\":\"68408328a9b7bde0\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/defaults.js\":\"de2ee89191eb1351\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/kernelValuePresets.js\":\"11cc7a8e745cca28\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/selectablePresets.js\":\"9e4d8d80e8dcd1a1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyEditors/typesPropertyUi.js\":\"35ba3b6e9df2980e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/AddPropertyForm.js\":\"ca7add9ca335af8a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/PropertyPicker.js\":\"2426df5177b433e8\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/PropertyRow.js\":\"47267ab7e5c325a3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/Rows.js\":\"e114690fbd878f4b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/actions.js\":\"49759a9f1b61c2dd\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/declarationOnly.js\":\"daa5e0809fd5b82b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/layout.js\":\"6de91454db1a1503\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/model.js\":\"e64e422711a5000a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/shapeUi.js\":\"ff755fabe5968222\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/shapes.js\":\"96eea076a29aa971\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/usePropertyEditingActivation.js\":\"02c7056a7dfe7747\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanel/visibility.js\":\"f443630a7d875c90\",\"/knowledge-medium/pr-preview/pr-1858/src/components/propertyPanelSections.js\":\"0427cb9197c5d6da\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockEmbed.js\":\"3f1f49bfe33c1ee1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockLink.js\":\"db9833f0774bf494\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/BlockRef.js\":\"5f341646f1433645\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/ReferenceLink.js\":\"4574f13fe89734b2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/cycleGuard.js\":\"6bd01b544801803d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/cycleGuardContext.js\":\"a16e6b1c7d000f11\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/linkInteraction.js\":\"65e3861848636e2d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/referenceLayout.js\":\"90bced286c51f78b\",\"/knowledge-medium/pr-preview/pr-1858/src/components/references/useBlockRefAncestors.js\":\"726b2112e79e95e1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockGutter.js\":\"6f3dea5af7bf571c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockInfoDialog.js\":\"e6437663326a269c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BlockTypeBlockRenderer.js\":\"7ee46f80903ff28a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/BulletHoverCard.js\":\"de3789eafad53a4d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/CodeMirrorContentRenderer.js\":\"429c9443c526fb87\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c8fddb939d9c2fc9\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/ColumnResizeHandles.js\":\"b1e3e4975284e4ed\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bed4d541799ac2bf\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/DefaultBlockRenderer.js\":\"dd5bff66cad1aae2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/LayoutRenderer.js\":\"1cbba2dcf8272f30\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/MarkdownContentRenderer.js\":\"610a3b13bcfeb3f2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/MissingDataRenderer.js\":\"3bfc6b89ddeb52d1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/PanelRenderer.js\":\"bc505d4418b2036e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/PropertySchemaBlockRenderer.js\":\"075a7ac918e923a6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/TopLevelRenderer.js\":\"acbefd8984909dfd\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/blockGutterMode.js\":\"c83c049cff2455b3\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/blockTitleText.js\":\"562e57996e3b9078\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/fieldCreationKeydown.js\":\"bfabe6e06dfc9791\",\"/knowledge-medium/pr-preview/pr-1858/src/components/renderer/layoutRootContext.js\":\"b298524fbf884750\",\"/knowledge-medium/pr-preview/pr-1858/src/components/typeChip/TypeChip.js\":\"4d47097bfc836fa4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/typeChip/chipStyle.js\":\"7eddf967187b3e27\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/anchored-floating.js\":\"d1ebafd589489c78\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/button.js\":\"c7f02e37ea914f56\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/card.js\":\"4fa1ecf6102e0634\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/checkbox.js\":\"84200f4c799aa39a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/collapsible.js\":\"df15a007691c0fc8\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/command.js\":\"a6f925549766fe42\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/context-menu.js\":\"aa504ff6e2ba3ec6\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/dialog.js\":\"9f118d48cc830fe1\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/dropdown-menu.js\":\"92626186bc6ed58e\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/floating-listbox.js\":\"dc60f9068060ac3c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/index.js\":\"ab620bb0d66d9376\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/input.js\":\"c654985eed472840\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/kbd.js\":\"15e0b21a34cca4af\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/label.js\":\"9089a1da41e2c43c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/ui/textarea.js\":\"fccd82be57970258\",\"/knowledge-medium/pr-preview/pr-1858/src/components/useEditModeYieldKeepalive.js\":\"579350a2edd12c96\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/BootFallback.js\":\"df9f04d610014b5c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/FocusedRowLazyMount.js\":\"9e90c9319eadb8d7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/LazyViewportMount.js\":\"9d045faafafab3a2\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/LocalDbCorruptionFallback.js\":\"bb921944f2e14581\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/error.js\":\"61b1adcc159e82d7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/lazyMountRegistry.js\":\"6603f9c58739aaea\",\"/knowledge-medium/pr-preview/pr-1858/src/components/util/suspense.js\":\"05e3019198c1359f\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/CreateWorkspaceDialog.js\":\"0caca1f723bff644\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/PendingInvitations.js\":\"9df821a863173758\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/SyncProgress.js\":\"dc64522ece91443a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/UnlockProgress.js\":\"d051c5789c2cbdd4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceKeyGate.js\":\"33902687f6524f4c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSettingsDialog.js\":\"4e9feb55609aff20\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSwitcher.js\":\"88fcf16101633465\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/WorkspaceSyncGate.js\":\"2a924e45ae9855eb\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/ConversionFlow.js\":\"c48da593ddcc350a\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/ConversionFlowHost.js\":\"cfb69127973f5069\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/EncryptionSection.js\":\"fb7f00d39da0da58\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/attachmentPrompts.js\":\"99fd827627dbf745\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b156709f2934f4e4\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/conversionFlowDeps.js\":\"f2fec77557b3558d\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/conversionFlowStore.js\":\"e3c3652d8c2c06fc\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/flowUi.js\":\"caa8fb56989c8b00\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/conversion/useConversionRun.js\":\"03fd270e075eadd7\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/keyUi.js\":\"91982eca3bd8bd0c\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/useCloseOnKeyLoss.js\":\"485123ee0930bb29\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/useCloseOnServerE2ee.js\":\"84f06a0526d76906\",\"/knowledge-medium/pr-preview/pr-1858/src/components/workspace/workspaceUnlocked.js\":\"374221146c361487\",\"/knowledge-medium/pr-preview/pr-1858/src/context/backgroundSubtree.js\":\"1b96694b0f7eafc5\",\"/knowledge-medium/pr-preview/pr-1858/src/context/block.js\":\"6d1256385f797b92\",\"/knowledge-medium/pr-preview/pr-1858/src/context/layoutWsContext.js\":\"f2c3b073a7285856\",\"/knowledge-medium/pr-preview/pr-1858/src/context/propertyDisplay.js\":\"451484198043bbec\",\"/knowledge-medium/pr-preview/pr-1858/src/context/repo.js\":\"a1b1cc86340c3e6e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/aliasClaim.js\":\"2d72a3c23ae371fa\",\"/knowledge-medium/pr-preview/pr-1858/src/data/aliasSeatNamespace.js\":\"42344baefcabeb63\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/blockData.js\":\"58214c71b0135f9d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/blockType.js\":\"73caeef9607aa9b9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/changeScope.js\":\"09fc994c9e1b0222\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/codecs.js\":\"43454f7675163b1e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/derivedData.js\":\"e87cf1f04f84ba43\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/errors.js\":\"dedc249d46181b17\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/events.js\":\"6f17bbc98506ddda\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/handle.js\":\"42c97c3e64a31262\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/index.js\":\"c3359db3769cc89b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/mutator.js\":\"bbdfe3f92e833e5a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/processor.js\":\"56f4bdddb6aaa82e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/propertySchema.js\":\"bd32c2dc16db6912\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/query.js\":\"ee74d81aed74a183\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/sameTxProcessor.js\":\"e2ca194e0e9975bb\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/schema.js\":\"42c97c3e64a31262\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/tx.js\":\"42c97c3e64a31262\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/typedBlockQuery.js\":\"57a8a4094410a474\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/user.js\":\"c6be83c0276d6365\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/valuePresetCore.js\":\"fd8dde660c18a8b6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/api/valuePresets.js\":\"08d7d85e6dc730f4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/attachmentCleanerIOVerb.js\":\"795ca18e0919cb75\",\"/knowledge-medium/pr-preview/pr-1858/src/data/block.js\":\"ffded224ff968139\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockCache.js\":\"a471babefca592af\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockId.js\":\"ce4d58b97285efd8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockLiveness.js\":\"c356844de2e7c0bf\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockMerge.js\":\"a4e1951b53471434\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockSchema.js\":\"270bb17c79b55ecb\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockTypeLookup.js\":\"195392403ee82aae\",\"/knowledge-medium/pr-preview/pr-1858/src/data/blockTypes.js\":\"9959904300c8e67c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/clientContext.js\":\"570e619e09ee9148\",\"/knowledge-medium/pr-preview/pr-1858/src/data/dbFileSiblings.js\":\"fc55eeb8a921e390\",\"/knowledge-medium/pr-preview/pr-1858/src/data/definitionSeeds.js\":\"ef6a4bc427b9d047\",\"/knowledge-medium/pr-preview/pr-1858/src/data/derivedIds.js\":\"de9fed159c820a14\",\"/knowledge-medium/pr-preview/pr-1858/src/data/drawnSubtree.js\":\"6049169c6d022f15\",\"/knowledge-medium/pr-preview/pr-1858/src/data/facetBridge.js\":\"1429c87116611a24\",\"/knowledge-medium/pr-preview/pr-1858/src/data/facets.js\":\"cd2a34189b9ba5c0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/globalState.js\":\"c5def238fc71739b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/aliasClaimRederiveProcessor.js\":\"4dcb1ae5cb94e67a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/ancestorBatch.js\":\"75792bf4c9c27a48\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/blockTypeTypeifyProcessor.js\":\"69ebdb8ac64a9f29\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/clientSchema.js\":\"1b585919d588bedd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/commitPipeline.js\":\"bd258c93cb70b6e1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/devAssertions.js\":\"bcc5684fae2f0e96\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/firstSync.js\":\"f71662f8787b2ed5\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/freshInitialLoad.js\":\"7f1efe9c1c5788e3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/graphBackfillClaim.js\":\"ec465421b60a0218\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/handleStore.js\":\"ce8a3af2117b0ecd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/idleMarkerJobs.js\":\"63e2fe35a2612de4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/initialDownload.js\":\"784a3055457603d1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/initializeClientDatabase.js\":\"b8a0931bc8d12fd5\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/jsonCanonical.js\":\"19fda12b4f52bdb3\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelInvalidation.js\":\"1ed1f9a92693c05c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelProcessors.js\":\"077a4d7f45b378af\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/kernelQueries.js\":\"6727f31a8f2dac90\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/mergeTypeMembershipProcessor.js\":\"5ffa9aa5cbf1c9fe\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/normalizeReferencesProcessor.js\":\"59aa4d70a97b5e11\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/poolInstrumentation.js\":\"5db2dc51ec6da441\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/processorRunner.js\":\"a6988eb563e8033c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyCellBackfill.js\":\"57c561facddd5f0c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyChildMint.js\":\"e3e15778b6a41ef9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyChildrenProcessor.js\":\"af25d92ab31d507b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4c7bc435793b4c52\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyDefinitionSynthesis.js\":\"342e64da9dfd0311\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyKeyScan.js\":\"73c3d8877654fac0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertySchemaResolution.js\":\"c9bd6e6088a67a71\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/propertyValueEdits.js\":\"4b74f1f7a150f6bc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/raiseProtocol.js\":\"78374fea51174db6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/readBatch.js\":\"685797dd4cbb6254\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/refProjection.js\":\"857795ac2b9c9330\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/referenceTargetLookups.js\":\"9c00e9b4897e10d9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/referenceTargetProcessor.js\":\"7bf6ed35475048dc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/replayMerge.js\":\"501965dd6c97c5a2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/sqlBinds.js\":\"2eda2834dd791a35\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a62fe529d75c46de\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/arrivalProcessors.js\":\"073e1c29705b81d7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/invalidate.js\":\"e46ddb7897c104e0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/materialize.js\":\"3a204848f907c0f6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/observer.js\":\"1c66402426ee4655\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/syncObserver/reconcile.js\":\"4af5b55a004348c8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/timingMetrics.js\":\"71fe853b4c42505b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/treeQueries.js\":\"2e0acc500788127c\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/txEngine.js\":\"5da8de0c7086c3a2\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/txSnapshots.js\":\"3a5582735e4b2ce7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/typedBlockQuery.js\":\"a12f5a69fb431b4b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/internals/undoManager.js\":\"b1edec85ebdc2fb8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/invalidation.js\":\"3a9023259e8e43a7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelDataExtension.js\":\"3d57b78d6593ce68\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelPage.js\":\"d2728139aafd2542\",\"/knowledge-medium/pr-preview/pr-1858/src/data/kernelValuePresetCores.js\":\"af03c52b7d150012\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbCorruptionSignal.js\":\"19e249eb4c253998\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbStorage.js\":\"8f66ee772f66a40a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localDbVfs.js\":\"c27beadbc02a17c4\",\"/knowledge-medium/pr-preview/pr-1858/src/data/localSchema.js\":\"ff58496cc559c04d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/maintenance.js\":\"63021c52a1794637\",\"/knowledge-medium/pr-preview/pr-1858/src/data/mergeProperties.js\":\"b4e6e8c8b4426a72\",\"/knowledge-medium/pr-preview/pr-1858/src/data/metricsConsoleHook.js\":\"68aa537d024e455f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/migrationsPage.js\":\"33fb0c8ed36f5685\",\"/knowledge-medium/pr-preview/pr-1858/src/data/mutators.js\":\"39298de5b70d047b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/orderKey.js\":\"40e1a18f7a7d9615\",\"/knowledge-medium/pr-preview/pr-1858/src/data/orderKeyPlacement.js\":\"c1e9bf4fa491e92a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/outlineSurface.js\":\"410c3ea82b900e3f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pendingEditorContent.js\":\"9fd5274a892c96ba\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pendingUploadsSql.js\":\"717482c9446d2cce\",\"/knowledge-medium/pr-preview/pr-1858/src/data/pluginStateExtensions.js\":\"055fa3451ecc0c16\",\"/knowledge-medium/pr-preview/pr-1858/src/data/powerSyncLogger.js\":\"248681a7ad0ba36a\",\"/knowledge-medium/pr-preview/pr-1858/src/data/projectorRuntime.js\":\"a76d660a31ed2060\",\"/knowledge-medium/pr-preview/pr-1858/src/data/properties.js\":\"3683bb9eed733ed9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertiesPage.js\":\"c98ee1c32aae2630\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyChildren.js\":\"498555d546c7a405\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionFanout.js\":\"ef2c3540d87c2561\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionMetadata.js\":\"9ed1aa4310b4b457\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDefinitionRegistry.js\":\"9456ff513a68f824\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyDisplayMode.js\":\"c99d7c1d5232eac1\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertyRowCreation.js\":\"fac610efa28721cd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertySchemaCreation.js\":\"5946451a9a779424\",\"/knowledge-medium/pr-preview/pr-1858/src/data/propertySeeds.js\":\"c8d402d6c7a8b6c7\",\"/knowledge-medium/pr-preview/pr-1858/src/data/recentsPage.js\":\"6328f83be03cb11f\",\"/knowledge-medium/pr-preview/pr-1858/src/data/referenceBlock.js\":\"1d59a5868b0cdd04\",\"/knowledge-medium/pr-preview/pr-1858/src/data/rejectedUploads.js\":\"53c6520ead425381\",\"/knowledge-medium/pr-preview/pr-1858/src/data/releasePowerSyncConnection.js\":\"f343ebe34453b9f9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/repo.js\":\"f2c7c1953be41bb0\",\"/knowledge-medium/pr-preview/pr-1858/src/data/repoProvider.js\":\"589822d1e4938b47\",\"/knowledge-medium/pr-preview/pr-1858/src/data/rowProperty.js\":\"ff417a3e69076403\",\"/knowledge-medium/pr-preview/pr-1858/src/data/searchFilter.js\":\"3a2ca1ddbf3841a6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/seedIdentityLedger.js\":\"4e47506b8c363575\",\"/knowledge-medium/pr-preview/pr-1858/src/data/stateBlocks.js\":\"6c7ba0cdd956cdcc\",\"/knowledge-medium/pr-preview/pr-1858/src/data/structuralEditPolicy.js\":\"3ff834edbac6793d\",\"/knowledge-medium/pr-preview/pr-1858/src/data/subtreeDelete.js\":\"82186bee13227023\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncStreamLock.js\":\"29bd4fc01f66e252\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncedTableSqlRecognizer.js\":\"56bc0eb48d92b932\",\"/knowledge-medium/pr-preview/pr-1858/src/data/syncedTableWriteGuard.js\":\"2ea5325b7529e400\",\"/knowledge-medium/pr-preview/pr-1858/src/data/targets.js\":\"9fc541669b7531ec\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeColors.js\":\"97c51485a4d9ec43\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeDefinitionMetadata.js\":\"c2f0b9dfc9cd0e5b\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeDefinitionRegistry.js\":\"e50404260a4c8628\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeExtraction.js\":\"aec28a9900b1d412\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeInitialValues.js\":\"37b8beae96fd3d2e\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typePropertyGroups.js\":\"0a81b439f1eef314\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeSeeds.js\":\"3aa8e0eb40fb6d17\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typeTagger.js\":\"e65c57f85a8b72bd\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typedRecords.js\":\"389ecae8b2698eb9\",\"/knowledge-medium/pr-preview/pr-1858/src/data/typesPage.js\":\"b91d09ce84136c83\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userPrefs.js\":\"eb75ebe85ede2bc8\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userSchemasService.js\":\"d46b88ecdf2583af\",\"/knowledge-medium/pr-preview/pr-1858/src/data/userTypesService.js\":\"20011648bd31c8df\",\"/knowledge-medium/pr-preview/pr-1858/src/data/valuePresetRegistry.js\":\"4c5d3286968325eb\",\"/knowledge-medium/pr-preview/pr-1858/src/data/visibleChildren.js\":\"180235b1903204e6\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceConversion.js\":\"cb13091b3b203b98\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceFirstSync.js\":\"190e52c5d5f62977\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceIdNamespace.js\":\"4322851eab420c48\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaceSchema.js\":\"52d1cded5b143165\",\"/knowledge-medium/pr-preview/pr-1858/src/data/workspaces.js\":\"8dcc8a7432c5a070\",\"/knowledge-medium/pr-preview/pr-1858/src/data/writeAheadLog.js\":\"e95f8e9d2cb535fb\",\"/knowledge-medium/pr-preview/pr-1858/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/BlockPasteShellDecorator.js\":\"dcf8b058ded7c41c\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/atTrigger.js\":\"5de56ad3157231e1\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/autocomplete.js\":\"2b80a68f1641bd8f\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/codeMirrorExtensions.js\":\"c257aca3a3784ed2\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/contentFlush.js\":\"fd9ef9488de58c21\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/defaultInteractions.js\":\"cbdaba0a2dc9977d\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/editSettleSignal.js\":\"f22c988bc889d70c\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/insertImage.js\":\"f05d1a7d761da51f\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/referenceCompletionRange.js\":\"3e50799b5bd0cf25\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/referenceTargetTypes.js\":\"1fa87ba1cc9bf429\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/syntaxContext.js\":\"f169dbda43e90891\",\"/knowledge-medium/pr-preview/pr-1858/src/editor/triggerMatch.js\":\"52a382cafcfec017\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/AppRuntimeProvider.js\":\"c5f35131bc4a1499\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/BlockFocusShellDecorator.js\":\"546b7ad93740ec9f\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/ExtensionRenderBoundary.js\":\"6f77e62cb78a4584\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/PanelContentRecovery.js\":\"880aa85eec6b3724\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/apiCatalog.js\":\"100cdbb9ecb2cf31\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/approveExtensionHere.js\":\"9b743ef2d536f7ce\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/armedCutAppMount.js\":\"de103cd7b0280bd3\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/batchableKeyedStore.js\":\"354ab538d2dfc1a3\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/blockInteraction.js\":\"2c4ef9a777297492\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/blockSelectionAction.js\":\"dd092ecf537ab278\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/compileExtensionModule.js\":\"93b7637d1605c406\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/compiledModuleCache.js\":\"ece50e35038bd7bb\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/continuousGestures.js\":\"e9ab790cf3a83485\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/core.js\":\"16f8632da033ed37\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/defaultRenderers.js\":\"3ac0376dbfee07c9\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/definitionFanoutAppMount.js\":\"984712f156556f48\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dialogAppMount.js\":\"47f0854e643dfab6\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dynamicExtensionSeeds.js\":\"02c6bd1d6016e1ea\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/dynamicExtensions.js\":\"8d343114c6902d75\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/exampleExtensions.js\":\"645fea5885293871\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionApprovalStatus.js\":\"191d1c5792ce7490\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLoadErrorToast.js\":\"cc8a00b364acd695\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLoadErrors.js\":\"9aca8b6e31fffbb1\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionLookup.js\":\"224589baf022e331\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionToggles.js\":\"ed474475c3a6acda\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/extensionUtilitiesCss.js\":\"78a884a2d42bc011\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/kernelPageDeletionGuard.js\":\"062ae51b98e5be0f\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/liveRuntime.js\":\"27a06ba3afdba285\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/openExtensionsSettings.js\":\"4a381aedc3edd9e4\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/overridesCache.js\":\"cd612416a8197256\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/pluginIds.js\":\"95e55ed62787063d\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/processorRejectionToast.js\":\"1f3cafd619c15f62\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/runtimeActions.js\":\"716331d97f7480d9\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/runtimeContext.js\":\"f5b0dba25b50f3d0\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/staticAppExtensions.js\":\"11b15964f1e76bcd\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/staticDataExtensions.js\":\"6abc7ddbdfcb16ca\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/toastAppMount.js\":\"21a89880e15b1dbf\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/useOverrides.js\":\"3e06f55a72218d1d\",\"/knowledge-medium/pr-preview/pr-1858/src/extensions/useShortcutSurfaceActivations.js\":\"6e5bb1df19a4de5e\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/discoverToggleTree.js\":\"024bccdc60c0cf6e\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/facet.js\":\"57e06b72acaa6d23\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/resolveAppRuntime.js\":\"a7acde032150a161\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/runtimeEvents.js\":\"21646ff59058383e\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/togglable.js\":\"62e2dab3cb380c45\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/variantFacet.js\":\"b5e945e07554b93e\",\"/knowledge-medium/pr-preview/pr-1858/src/facets/verbFacet.js\":\"f666542aa5c06ab7\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/block.js\":\"6affd0b30b85ebfa\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/focusedChild.js\":\"ccb6b002622ee954\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/propertySchemas.js\":\"08c81b4227daebee\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/typeRegistry.js\":\"17323f28f8773d0e\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useAncestorCrumbs.js\":\"9b193b96f44e0163\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useAutocompleteListbox.js\":\"28a6dc3eaba0c84c\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useDebouncedSearch.js\":\"73906b3de20ef8ad\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useDebouncedValue.js\":\"2171f1d4395f66a6\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useIsFocalRender.js\":\"7a51c31eb969aefc\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useIsReadOnly.js\":\"fb5ace1bfb40b767\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useMaterializeBacklog.js\":\"0112b7120c40760d\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useMinuteClock.js\":\"a00762b319142b63\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/usePanelLayoutProjection.js\":\"27b6cfd495450ede\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/usePendingInvitations.js\":\"550d19269fae96e2\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useRendererRegistry.js\":\"3a5d5aca66609d92\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useRetainedFieldRows.js\":\"29eb895acf9f80cc\",\"/knowledge-medium/pr-preview/pr-1858/src/hooks/useWorkspaces.js\":\"cd1f63555936ecba\",\"/knowledge-medium/pr-preview/pr-1858/src/lib/utils.js\":\"b52606a8552f6a1f\",\"/knowledge-medium/pr-preview/pr-1858/src/main.js\":\"a31b9aed5e71a4e1\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/MarkdownImage.js\":\"391a5ae1d5e3f007\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/blockSeparators.js\":\"9a1edeb055c5d8ae\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/context.js\":\"7d209c9b2fa431dc\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/defaultMarkdownExtension.js\":\"d9ea7e6a4a28dafe\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/extensions.js\":\"3f7df2fc35b42564\",\"/knowledge-medium/pr-preview/pr-1858/src/markdown/renderMarkdownHtml.js\":\"7208a78818e47351\",\"/knowledge-medium/pr-preview/pr-1858/src/minimal-editor.js\":\"0f9078bbe6428d8e\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/armedCut.js\":\"f8dc8eaa7b24f41c\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/captureMediaVerb.js\":\"ff627ec52181a065\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/clipboard.js\":\"0f3c5e872fed0d81\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/decision.js\":\"1d8f604a69fca7d3\",\"/knowledge-medium/pr-preview/pr-1858/src/paste/operations.js\":\"293a879091631238\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/account-header/AccountHeaderItem.js\":\"60f5094ebc5ef121\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/account-header/index.js\":\"c87a500d8c747946\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ba657bcead35470d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/askAgent.js\":\"078b0bad9b8baca4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/askedStore.js\":\"bc76f21ff238b90d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3c4aad205082b99e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/chipState.js\":\"a4a7be88593e13cd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3c9af91ecdd7da6e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/index.js\":\"75156da6ed9fa04c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"05bd946652a73a77\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-dispatch-companion/schema.js\":\"0493d998429e85b4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7157ed5bc3439081\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a66e451ab884d2ea\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/addMedia.js\":\"ca9f69f9e8c8c8a1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3480d189b6992d91\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/block.js\":\"c6c14ba29edf4d84\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/context.js\":\"c754756d09f16b91\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/displayIds.js\":\"60b655974c615134\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/index.js\":\"beba938a87d77e2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/outline.js\":\"1726e2c6923772f6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/properties.js\":\"eab812d416c937e6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/refs.js\":\"b7ed2f9022c0ba52\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7aee11244f8ba89a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/search.js\":\"d62452c99c3c55fa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/shared.js\":\"fbfcb28c99bbcf5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0cc92ce2f59a65b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentViews/text.js\":\"8b2457c849f6dcf5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/agentWrites.js\":\"f6da92ed822223aa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/authoringCatalog.js\":\"9edc3addb5360f18\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/blockRefTargets.js\":\"10c7c2eccac5955c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/bridge.js\":\"5675b2dabae46dd6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/bridgeLoop.js\":\"8d010c01d5d2c28c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/changeHistory.js\":\"26afe28b8ebd7b74\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/commands.js\":\"dcd06e7d22669927\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/commentsCommands.js\":\"13d33880d2f38875\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/dataExtension.js\":\"8c3df11be9a2ac55\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/dataModelGuide.js\":\"2c488ebd28300eb7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/describeRuntime.js\":\"4f574f8390896d40\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/extensionLint.js\":\"b1a41104a90e32e9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/grainAudit.js\":\"b2402597b823c859\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/healthCommand.js\":\"3c0707db54d2d1d0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/index.js\":\"5e65deb114243304\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/presetIdentity.js\":\"35b36e4afe270a00\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7c9752331881d291\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/readMedia.js\":\"db79aa3ac0d562bf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/schema.js\":\"d5222d0c5b738bc1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/serialization.js\":\"a76256cb07e7b558\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/targets.js\":\"49736b259dfc012f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/tokens.js\":\"6a6315e91b3ae5de\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/watchEvents.js\":\"6044c8f39655323f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/workspaceGuard.js\":\"1b1619e7c0424bc0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/agent-runtime/writeCommands.js\":\"cb2aecf48adcf894\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/AliasCollisionToast.js\":\"23081940138c5153\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/DuplicateNameBanner.js\":\"471cffb36dc73a60\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/collisionMerge.js\":\"f5e07cce1293dd71\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/dataExtension.js\":\"3baa06d268699eaa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/index.js\":\"d1e91a89c3f0fa13\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/mergeCollisionAction.js\":\"11a18a7382ac4460\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/pageStyling.js\":\"4921360b314c4f28\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/rejectionToast.js\":\"1da7611125bae702\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/alias/syncProcessor.js\":\"ccd8a2c33c44fbae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/actions.js\":\"da727ae8c6bf2f1e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/addComment.js\":\"8e4ed73a7dc43d15\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/anchor.js\":\"8bcb7b2d9d550e29\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/anchorState.js\":\"6e2397a468a212ee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/commentLinks.js\":\"354fb0ae57ab0252\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/confirmThreadDeletion.js\":\"26966496c9ade69b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/container.js\":\"17e370df35fe7835\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/dataExtension.js\":\"e118639467a63128\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/deleteComment.js\":\"633aa1bfb58b76cf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/highlights.js\":\"8573a0fc81ba995d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/index.js\":\"800dbb93639e116e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/linkedCommentsPill.js\":\"eafb112d6acd7a94\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/margin.js\":\"1dbabd3d72a00f9a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/marginSchema.js\":\"1f6b6b59e685f95e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/newComment.js\":\"0915af5140c07482\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/ownThreadPicker.js\":\"78ef8eaebdce8c0d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/placement.js\":\"d4d3b0042036b9c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/queries.js\":\"eb0ed02fdb6fae73\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotePosition.js\":\"176ddbccd0bd8052\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotedIn.js\":\"c089d3adf5f26696\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/quotedRange.js\":\"24f7757ff2f8c736\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/rangeRefs.js\":\"237f1adf3f380b30\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readHighlights.js\":\"58cffb06f0603b1f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readSelection.js\":\"cfad2db43ed88f2a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/readSelectionUi.js\":\"68a4ab3276cac556\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/reanchor.js\":\"f68db01dee219828\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/schema.js\":\"a440d31ed63980b6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/scope.js\":\"19b5ecb8cb5e4510\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/scopeThreads.js\":\"e14368cfc96c87be\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/splitRetarget.js\":\"8f6902d7bf405305\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/suggestionCard.js\":\"74ecd0b079a1140a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/suggestions.js\":\"41fc2cafa36a7aa6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/summaries.js\":\"dacf47da5173c201\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/summaryBatch.js\":\"f5b4914cbc72e888\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/surface.js\":\"53da4282c1724180\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/threadNavigation.js\":\"08b9e5516242f539\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/threads.js\":\"647aeee7a43493ba\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/ui.js\":\"6377a9d80ee5c8c5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/annotations/uiStore.js\":\"1e1768990dd0904b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-intents/appIntents.js\":\"f4c864d2ef0255d3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-intents/index.js\":\"6b25275b1183270e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-update-prompt/index.js\":\"c10b1fc3b889513d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/app-update-prompt/status.js\":\"2d3f515cd1099160\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4397eef05c51e6db\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaBlockRenderer.js\":\"6e5ace126cd3b40f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaDownLaneReplicator.js\":\"364256604515b49f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/MediaUploadReconciler.js\":\"afa74149c50d7470\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetDownLane.js\":\"b1a09e53500324a4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetResolver.js\":\"9ab01b1f75a146d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/assetUpload.js\":\"e8cba2c7c5ab787a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/attachmentCleanerIO.js\":\"54a1b4e9c5262f2a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c19e5f6c3da3175f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/blobStore.js\":\"66927ee7714a5cb5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/byteStore.js\":\"4e5dd3d021ab5ee3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/cleanerIO.js\":\"bb42af7f072405d6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/cleanupAttachments.js\":\"f406854be54ea163\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/dataExtension.js\":\"63b5bb70e164939b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/downLane.js\":\"689725231cc644fa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/index.js\":\"d658289008637286\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/insertImageContribution.js\":\"92eb5b01abc6a948\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/laneArming.js\":\"7578800ed0b231b1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/laneLock.js\":\"41257a2c839b7daf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaBlock.js\":\"d8aaf08093d22603\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaCapture.js\":\"8114fc79e1d0645b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaLanes.js\":\"b66a07e29b9a6f62\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaViewers.js\":\"02ec6a3f1d3acfa3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/mediaViewersFacet.js\":\"c03b4a211d796f37\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/pasteCapture.js\":\"b675e776e8263fd1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/resolver.js\":\"4a5ce50967aa147a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/retryUploadsAction.js\":\"9b92413755477724\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/storagePaths.js\":\"ecb6d0592b49c0a3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadDrain.js\":\"0ce36fb6458e9d8f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadLaneStatus.js\":\"7d2802fa59604c92\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadReconcile.js\":\"662a9454bcb0bb15\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadRecovery.js\":\"1430561400eac71c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/uploadStore.js\":\"073742114d6b0d38\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/attachments/useAssetObjectUrl.js\":\"d9051349cc93f114\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5bca99b26c5f719e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/BacklinksViewSection.js\":\"820780169e36fd9d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/facet.js\":\"91f720d8490f5a1c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/index.js\":\"53e0bbeab46e2780\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks-view/prop.js\":\"47f4cf56fb6fad9c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BacklinkFilters.js\":\"07451fdf1bd85e56\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e0d39442cba78998\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/BlockEntry.js\":\"de777091dd04e1d6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/LinkedReferences.js\":\"e72a00778a2db3a9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cc4925b555c8bf2c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/dailyNoteDefaults.js\":\"3d61302b52b23282\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/dataExtension.js\":\"45dca7811440cb96\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/edgeExclusions.js\":\"ee66d1c3ea9cc42b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/filterProperty.js\":\"47788959f6230358\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/index.js\":\"b2dd7be199cc4ab6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"208fda237ea62ec6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/applies.js\":\"f3d9f31ba808fc2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/countQuery.js\":\"58e14a6c969e4ae7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/expansionStore.js\":\"21efc0c164e4effb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/index.js\":\"4a3264a69dc5c45b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"671d97b4e7dd6824\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/presentationInvalidation.js\":\"51f577f37491e5ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/propertyEditorOverride.js\":\"f288f75ae840c727\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/propertyFilter.js\":\"b82a864f61fb557a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/query.js\":\"ed6ff29518d875fa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/resolveFilter.js\":\"445d9465b9381d07\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/sourceBatch.js\":\"e1e39471a83085fb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/sources.js\":\"33cf2bd87ab56436\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/useBacklinks.js\":\"6145f7728f011104\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8145e4dc389cde0a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/BirthdayCelebration.js\":\"31345aac6ed9a4c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/BirthdayOverlay.js\":\"b7acb3fbf59c8d64\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/gate.js\":\"7fdd70e35de97b24\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/index.js\":\"10f31735461aefd8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/birthday/wolfTheme.js\":\"f5071d1e6b258b44\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/BlockDragLayer.js\":\"2b363cb9d1fd5321\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/dragController.js\":\"2826c7c5ab6952b5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/dropTarget.js\":\"13ad87d756b1aeec\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/index.js\":\"1a24b878b775a682\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-drag/projection.js\":\"be92eb41735a349c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-info/BlockMetaCard.js\":\"2c5da1a675682114\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-info/index.js\":\"4d1ff1425af1f4ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/AddTagDialog.js\":\"8aa55490de959f24\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"159fa95c9e60b358\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/TagNameIssueHint.js\":\"e1b243a345c4812e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/addTagAction.js\":\"a54ad267f0727f48\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/appendTag.js\":\"da40ebcbcb3473fe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/config.js\":\"d5ae58974d488c7d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/dataExtension.js\":\"91af6dd708395954\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/index.js\":\"418806b82becdefa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/block-tagging/propertyEditorOverride.js\":\"365a007b2decac5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6f95c39e61d240c0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ea6b18e609ffba8e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c2952a2779a3bfe7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"bfa34ead83bf4a96\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"549f65d23c79d1e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/index.js\":\"846f11156d743db3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5ecc906e593448b0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/CharacterCountItem.js\":\"75801d1e38a97945\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2dfb00dceb6989ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/actions.js\":\"baf00db63da8fe04\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/blockType.js\":\"de03c7c0afefafcc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/charCount.js\":\"e991c76f10975561\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/dataExtension.js\":\"b0193391428a7145\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/index.js\":\"9d252ba5c1e45b32\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/profiles.js\":\"58843b3b8a2113e1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/properties.js\":\"69289e1fbacdbc79\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/character-counter/textCounts.js\":\"ab8abfca83510242\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/colemak-keybindings/index.js\":\"71abb98a59485338\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/CommandPalette.js\":\"dd36bf06e5acc5bd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/HeaderItem.js\":\"13fa4c2474141ffd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/context.js\":\"e101ae284d749210\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/index.js\":\"b6dac98437c20ef8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/selection.js\":\"bd78603c899cd347\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/toggleStore.js\":\"59dfbaaa4effcf1d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/command-palette/useCommandPaletteActions.js\":\"f3c7fdda909041b1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/ContributorBadges.js\":\"8cf4b4e370fb07e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/author.js\":\"190853f1c3576386\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/codeMirrorExtensions.js\":\"c7360da11010df2b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/dataExtension.js\":\"082a92f93c61f67a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/index.js\":\"0fbb576d7e35b424\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/mentionAutocomplete.js\":\"88fd021ffd9949ef\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/processor.js\":\"77c1871f6fe72652\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/profiles.js\":\"29cf98cba95f16d2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/queries.js\":\"c004d30fa3199804\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/contributors/schema.js\":\"e03a5eb3a7896a31\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3d4f1ce7b864ff34\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7fe5e1262d14a18b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/index.js\":\"23366f80a3537ff9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"206a430c4cc2accd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d2d138f054fbf1fc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/CalendarGrid.js\":\"050b66b45bc43cfc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DailyNotePicker.js\":\"a8abd7335b22e811\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3b649aa1a33cc84b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateNavDecorator.js\":\"9a4f5443b8ed668d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/DateScrubOverlay.js\":\"340ba49a46d3bb71\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/HeaderItem.js\":\"48507e6d6f4d949f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/ReschedulePicker.js\":\"16adebc106d93c48\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b7c3ef5f24993552\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/actions.js\":\"3fb89bd66a01e6ff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/blockDateAdapter.js\":\"546f266e1363cf9c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/calendar.js\":\"a747a1e234fa885b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dailyNotes.js\":\"34c60252bba54c2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dataExtension.js\":\"e64f1db0cb66d31d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubActions.js\":\"281e2d267ae55bf7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubGesture.js\":\"71fe15051f9a0acc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubGestureActions.js\":\"dbc4118ce303f43c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dateScrubRecognizer.js\":\"54e697c6158d7198\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/deletionGuard.js\":\"3bbb5cdac23e4b6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/dueQuery.js\":\"c820b33d12b3be3f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/index.js\":\"1d2999501b70ab59\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/landing.js\":\"24e0ae621cfb2712\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/localSchema.js\":\"bba7a6cd190954c8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/referenceDateAdapter.js\":\"42047db3519edada\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/rescheduleAction.js\":\"c4b3bad24ea74978\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/schema.js\":\"534781b8786d75b5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/spreadBlockDates.js\":\"6574acf63ae9066a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/spreadDatesAction.js\":\"3acf131c34a7c889\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/today.js\":\"d8f22856c8a5e430\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7dbff20ac075fab8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"716c456ebda79f9e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/audit.js\":\"1e93c4ce3c706b4e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/auditAction.js\":\"769fe9f51d8ec291\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/auditRanges.js\":\"e7b0f62a23f6ecdb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/diagnosticsSource.js\":\"1fffda0e0f08dde4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/divergenceScan.js\":\"a58c1122368c55ce\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/index.js\":\"dcbc059456163009\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/propertyChildrenChecks.js\":\"12b208d7a47780e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/referencesMirror.js\":\"0def9320570c3ad8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/rowJson.js\":\"f3fb62c2b870af22\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/schedule.js\":\"ef5a4aa444a98f28\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/data-integrity/store.js\":\"0442fe7d4c353ac2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/action.js\":\"159714dee34a8337\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/index.js\":\"9a2d6d99dac98475\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-maintenance/plugin.js\":\"2a2a1247039853ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8d3bef1b741dd599\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/actions.js\":\"94057f1d2cc1bb32\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/changeMarker.js\":\"dc370e33053eb0c6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/diagnostics.js\":\"aaff00c8ca46fd40\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/fileSystemAccess.js\":\"d58c0cba2e414666\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/filenames.js\":\"aeb3d1de410e5ee2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/index.js\":\"fab14f4618ac0f53\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/mirror.js\":\"7f6a6171a0c9e62e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/runLock.js\":\"8dc79796b747425e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/runtimeHealth.js\":\"bb0a6ad39004fdd3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/schedule.js\":\"a554507e983bb15d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/db-mirror/store.js\":\"f1b17fe6707186e4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/default-themes/index.js\":\"ed8a7c5685ba4ad8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/default-themes/themes.js\":\"c1246c49ab3fd62a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/diagnostics/facet.js\":\"3cbe66fb0b6f6c30\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/diagnostics/useDiagnostics.js\":\"ef41124b4d3ba5e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/dismissals.js\":\"91023df6e3ad0740\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/index.js\":\"733a168cecf10a34\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/status.js\":\"02b0809293d3f961\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extension-prompts/store.js\":\"e7a91ab0e972041d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"170cd777cb0ae206\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7e97f21f4a705098\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/actions.js\":\"afe1c45a4355785c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/config.js\":\"5bbbd7392abd65b1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/dataExtension.js\":\"c81a44905650b1b3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/effect.js\":\"b8dd9b04819491e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/index.js\":\"e65d12ece061f28c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1033dc15fc7c79bd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extensions-settings/useToggleTree.js\":\"61c43a329b976d77\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/ExtractTypeDialog.js\":\"075a8bf4ee6fe39e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ab7ce502dfe2ffa1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/PropertyShapePicker.js\":\"ab1119e16073f47c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/action.js\":\"3a049a519ad78921\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/extract-type/index.js\":\"77d59f2cde1e9b69\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/FindReplaceDialog.js\":\"bb37e98148535d61\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/HeaderItem.js\":\"5e31faaa7697d43f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/dataExtension.js\":\"f6f2c5146bce3cc7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/index.js\":\"4f13d89d9c7d80c3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/search.js\":\"2ed82ccc1c061975\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/toggleStore.js\":\"1392113081d2a685\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/LocationPropertyEditor.js\":\"4b7d892022934f3a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/MapView.js\":\"adb2152c71cb121d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/blockTypes.js\":\"c1d8ba68a37b2cbb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/codeMirrorExtensions.js\":\"4f510a3687ddb27a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/createOrFindPlace.js\":\"68ef1c2e91818a16\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/currentLocation.js\":\"e2df14ca896e7ce6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/dataExtension.js\":\"b878d8d805069bc7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/geoContentDecorator.js\":\"d6ed3eed200e0841\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/googlePlacesClient.js\":\"5ca9a0961a76729d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/index.js\":\"e3a746239d848720\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/locationsPage.js\":\"63254661770f2217\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/mapViewport.js\":\"9b204b70d2f3e0fa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/pickCurrentLocation.js\":\"389b7c71f003fc01\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/placeAutocomplete.js\":\"9b5a07214bf1d1b9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/placeNameCollision.js\":\"6a4bc446d7ab397c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/properties.js\":\"d0872ab28dadb158\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/propertyEditorOverrides.js\":\"c12db5bf6efac7f7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/query.js\":\"24bb76912a5135fb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/geo/usePlaceSearch.js\":\"c7c8031b1bd79ba7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c3d025d3ce932fc1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c4397b743e00327b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"06bce99b1f1e6c90\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/config.js\":\"9244344dd1682b6b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/dataExtension.js\":\"c4729263f0b6e6ee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/facet.js\":\"aab460fce14205ab\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/grouping.js\":\"6fca06a3b2785360\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/index.js\":\"319f8e5768cf147a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ca6d4073a1e94990\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/query.js\":\"61767ace5eb921b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/resolveConfig.js\":\"ed1ce5b04972ab15\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"516d96ac4d581b8d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4695e4b7ab98dd43\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/HtmlDocumentContent.js\":\"8dac9721aa75de2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/HtmlFrame.js\":\"007fe9da710ab0f3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/actions.js\":\"f5e5d6238319848b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/blockType.js\":\"7064c71c66d42a97\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/confirmRunScripts.js\":\"be982a4f8078d0df\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/dataExtension.js\":\"e6555153511c366f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameAnnotations.js\":\"a998ebfee97d702f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameDocument.js\":\"8b73331d03695e49\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/frameTheme.js\":\"3e3d8eb693740f1c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/index.js\":\"7f271f098e942be9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/scriptConsent.js\":\"af7c7b0c7d56654c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/sourceMap.js\":\"6c947143dcb88507\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/html-document/useDocumentScripts.js\":\"2729e3ea6e382c91\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/index.js\":\"aa81c27244488cd3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/record.js\":\"ba933f1e60dbbb28\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/recordStore.js\":\"9a10cdfdfd174f07\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/responsiveness.js\":\"4d97a6bb1d388e62\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/schedule.js\":\"3a9510c4f1e114c2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/interaction-metrics/sessionContext.js\":\"cfbb1e6d8b553c52\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"496ee5bc81212ee5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d6ff7a50f4225ae2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/actions.js\":\"266d561ace6eb544\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/config.js\":\"6aeb6107a7304e71\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/dataExtension.js\":\"6618d546a631317b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/effect.js\":\"12e417b1e2aae559\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/index.js\":\"6ab7ba254150d5d4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/keyCapture.js\":\"a0302cf763335939\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/overrideStore.js\":\"525c2686cbd39cc5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"357a077941460b5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/HeaderItem.js\":\"806fd0f1fa23e08d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/LeftSidebar.js\":\"396ce574626993e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/actions.js\":\"0a12023a9111f3e4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/facet.js\":\"411cdf3c807a840e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/index.js\":\"f20ec6cfc9770f95\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/shortcuts.js\":\"a7008d31e4d736b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/left-sidebar/toggleStore.js\":\"f7d250c9a30aeaa1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/MergePicker.js\":\"2a096b063286812e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/index.js\":\"2885015cc23ae75a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/mergeAction.js\":\"9924f5417b4c52d8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/merge-blocks/strategy.js\":\"80d323aff16296b3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/Button.js\":\"0d9ae2e32be07f81\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3fcf537532fde862\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1c0841951e321803\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/facet.js\":\"bc16d4517382289a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-bottom-nav/index.js\":\"786cca932bb09dbc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7cde4eac8c92982e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/actions.js\":\"b261c10fb32872ef\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"52e76f0711a66845\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/facet.js\":\"01426ed3fa8d6d9a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/mobile-keyboard-toolbar/index.js\":\"260ebea889290b8b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2e70a6a7333ff3b1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/blockSubtreeMembership.js\":\"45ae99378ae71f2e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/contextMenuItem.js\":\"bc1948ff0482aaed\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/index.js\":\"6bc79a104f13ae29\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/moveAction.js\":\"056f30b08e58b8e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/moveBlocks.js\":\"00fdf714228eae10\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/move-blocks/selectionAfterMove.js\":\"d333b9b415c43cff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/TutorialBanner.js\":\"cf8a40421fd63f60\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/action.js\":\"ea5bb9d34788988d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/bannerDismissal.js\":\"e8379b439af3bb90\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/documents/cheatSheet.js\":\"73753f3c82f87a30\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/index.js\":\"b502d7494b25af0a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/keys.js\":\"f1885217d6e5f233\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/landing.js\":\"d8192b8966bc4064\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/outline.js\":\"f5a35d0a96955c45\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/onboarding/seed.js\":\"92dc4fba07126020\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b37b7a3eadc8803d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/analyze.js\":\"e5423936c1592904\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/diagnosticsSource.js\":\"315e39859011a601\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/index.js\":\"36204ea48f7f517e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/load.js\":\"4c796d6e06d673b7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/monitorRun.js\":\"c84fa47ffea41cdf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/schedule.js\":\"50ad750485927110\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/series.js\":\"09f8dfe3d58a1bec\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/store.js\":\"5f2b8797dda0c17a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/trendAction.js\":\"ad7fc7ee771f5df8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/perf-monitor/verdict.js\":\"ae7fb66a48a152a6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/clickToEditAction.js\":\"db9625d171b852d7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/index.js\":\"198b82d3d393bf43\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/plain-outliner/interactions.js\":\"d37f04d62fb5a6fa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d7163ae7baf507a5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/MigrationGate.js\":\"c9dedca44170bc40\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/MigrationGateDialog.js\":\"cea409e176c81005\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/action.js\":\"92e1dda16fa21192\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/index.js\":\"3a9821ce6eb13c1e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/localRunMessage.js\":\"c1ba3fe120b8a379\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/plugin.js\":\"4b1ade16b52da8d0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/progressReport.js\":\"e7cd7f4102b0fa2d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/properties-migration/sweepProgress.js\":\"f0882d777686d0a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/FieldRowRenderer.js\":\"1adcb7303b258e76\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/ValueRowRenderer.js\":\"fbd3c27656d36929\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/actions.js\":\"5b262cdaf764333a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/autocomplete.js\":\"a1cff137d9bf1845\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/fieldRow.js\":\"2f24c2a3dcdeefea\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/index.js\":\"1c6559ee0a9a7194\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/referenceWarning.js\":\"816bcbf00cfee689\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/valueAutocomplete.js\":\"7bcc5b969a372bf2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/property-rows/valueSchema.js\":\"0224f2bd661e1875\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/HeaderItem.js\":\"19019c760afaa75d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/QuickFind.js\":\"a6920a54128dbba6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/index.js\":\"f8d08a58c777796c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/recents.js\":\"485ea0ea7776e690\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/resultItems.js\":\"676d83657fc7d733\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/selection.js\":\"2d422798ff6c4b76\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/quick-find/toggleStore.js\":\"6935853dfcce49e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/HeaderItem.js\":\"d84b054866e9c7a1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/RecentsPageBlockRenderer.js\":\"514ce42d90908e2a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/grouping.js\":\"a86a02df51e41c68\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/index.js\":\"2da14e187a2461a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/recents/target.js\":\"e666a2f8c607e245\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/codeMirrorExtensions.js\":\"22982571d23df4f9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/contentPrefill.js\":\"c5ad4942010cc255\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/dataExtension.js\":\"05e4af6e716defa2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/index.js\":\"235cb66cdfc96d49\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0ad4bb7b8af61864\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/invalidation.js\":\"fa438edf0ca67687\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/localSchema.js\":\"aa7c47288f4b7c51\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/blockrefs/index.js\":\"e08f208b742e21a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3a90f596600c2e15\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/index.js\":\"39d181478432d80f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/referenceNode.js\":\"bbda9d6697620635\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6e8ad14775359356\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"283d08855edd2d83\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/index.js\":\"7a3ffff92892a524\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8d509792771dd3c3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"aecb6fc3003be5e8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/mergeRetargetProcessor.js\":\"ddd58ad0ba2ac7f1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/parseFence.js\":\"fb162c9cebb993bd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referenceParser.js\":\"6cf40c28e642dd93\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referenceProjection.js\":\"0939b65ede8c1021\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/referencesProcessor.js\":\"17c6a18c69910bc0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/renameProcessor.js\":\"1112f7e9c2f6b615\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/references/spanReplacement.js\":\"52b11dee03c47c0f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/htmlToOutline.js\":\"132a0cacb8690d68\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/index.js\":\"a1394ba2ce2b4ba6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/normalizeClipboardDom.js\":\"150f27cf4d90901e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/rich-paste/pasteDecision.js\":\"741f128e99d59064\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/action.js\":\"69cacd46dd8fddc5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/blockIds.js\":\"4213fd7c7ada2551\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/content.js\":\"ace65c54d5123203\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/effect.js\":\"f1c62f8d95c1b5cf\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/ids.js\":\"07abf1fde5a4c857\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/import.js\":\"7d11eb1b68de504f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/index.js\":\"f6cc2018694a2953\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/plan.js\":\"f23cab2aa6a60219\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/plugin.js\":\"3a5aedce685943d3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/promotion.js\":\"bb670d00dfe0fd07\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/properties.js\":\"8ba66315ff780c8a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/references.js\":\"d3e7f5420d8a320f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/report.js\":\"3c723efbbbc3ce83\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/roamMemo.js\":\"4196ec9dcb7281b6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/runtime.js\":\"b1b83d6c405ed6e9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/schemaReconciliation.js\":\"975444b12c015eba\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/srsMarkers.js\":\"f30a5c27411a51b6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/todo.js\":\"1b91b6cad52dcffc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/typeCandidates.js\":\"076d82875e030ee1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/roam-import/types.js\":\"75285fdd84ec5c05\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/search-health/index.js\":\"034a08a059012ff3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/search-health/store.js\":\"ca73cf98702d5ab3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/HeaderItem.js\":\"411bb4af125d782b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6e9d4ccd12ab92fb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/index.js\":\"25e886c3aa9dd0c3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/model.js\":\"6d7199501555cb47\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/toggleStore.js\":\"9dda5fd077932d23\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/shortcut-help/useKeyInspector.js\":\"cfd7e42b3bfd95e5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"89d9215fd39ee6d9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/ShellDecorator.js\":\"425e1d26943fe013\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/actions.js\":\"45604397d9562ea1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/exclusionsFacet.js\":\"78947b650a53bfb7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/index.js\":\"0a18b3b657405495\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/shell.js\":\"04e02da3d4946be2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/surface.js\":\"5f66585f9f3aa271\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/spatial-navigation/walker.js\":\"8e233c33590dddea\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3f64a4f1abc3f02e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/dataExtension.js\":\"4c1eb3b1e3dc567d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/index.js\":\"aa322ba763308f39\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/indicator.js\":\"f5a3872c17a54108\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/moveSrsState.js\":\"8aef5ca67fb24cbc\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"65a5569c2ffa468a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/scheduler.js\":\"f8df59a41e182e44\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/schema.js\":\"ab3e867bca12ee8a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"49cd66e9d3846bab\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/srsClipboard.js\":\"55b0c26e94135cc6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"311f05b510d8f061\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d6ca149980145f1a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/DeckPicker.js\":\"8c74f19f3378f107\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewControls.js\":\"d841caf5dc9e4b23\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewDeckRenderer.js\":\"fee73f03e031a170\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/ReviewSession.js\":\"80819132ed336c0a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/actions.js\":\"7c66a3c077f0afdd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/archive.js\":\"71952dbf77fbcae8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/dataExtension.js\":\"70952f21afb69946\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/deck.js\":\"fcf0dccfb906c5e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/dueQuery.js\":\"641ae834c3d36a06\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/gradeDecision.js\":\"7b28181ceec9dcf3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/index.js\":\"f827b567b096b432\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/keyHints.js\":\"af6e3026d2801c6f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/reviewCardLayout.js\":\"37ea74b606f86599\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/reviewProgress.js\":\"25bb0cdc0378bb54\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/schema.js\":\"4fa61551f0f28e5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/srs-review/useDueCards.js\":\"fb588990de66e8ac\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/startup-metrics/index.js\":\"a1faf13c6d8a3755\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/startup-metrics/record.js\":\"fa1848061664fd5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/index.js\":\"0ed0f2bfbd827dc6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/persistenceStatus.js\":\"c70b9ce6ff0d2ae2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/storage-persistence/requestAction.js\":\"12d1cdf2c9298ff7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/TypeChipsDecorator.js\":\"15863d768b541948\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/codeMirrorExtensions.js\":\"43af88ddb5afabf4\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/index.js\":\"c08836ff4fdcd083\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/supertags/typeAutocomplete.js\":\"8462b4c4d9a51faa\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"fad96854d344f83f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/actions.js\":\"19f5f4936f9e79c5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/anchor.js\":\"8fee9e82584a2dda\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/events.js\":\"9b12adc47c42e39e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/gestureActions.js\":\"0add9a9c2abe33b8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/index.js\":\"1a53048ead345519\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"49bea1f3f85c4327\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/collect.js\":\"2285f60d23faf599\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/index.js\":\"cf135c194a6c66e2\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/sync-metrics/record.js\":\"125f7036e50d3365\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/RejectionDialog.js\":\"b0c6cda102e7852f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b00ae0a13a952b0c\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/index.js\":\"01ed4ecf30a8018a\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/model.js\":\"5d78de1bf8c24bbe\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/queueCounts.js\":\"e5c47a81b10301a0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/rejectedHelpers.js\":\"97fdfd274b0ad5ef\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/rematerializeAction.js\":\"485c755adde11736\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/system-status/useHysteresis.js\":\"f626b29a2701c878\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/ColumnHeaders.js\":\"edaf12535a0d2e58\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/QueryUi.js\":\"35022148eb8f4c69\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/TableLayout.js\":\"94a4318d11a0c277\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/actions.js\":\"abb0a0c3717a4300\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/cellEdits.js\":\"7008f7fc22b8d207\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/columns.js\":\"f619c7f1b67dee6d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/controller.js\":\"a31da8c2df361ed3\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/convert.js\":\"7a5e7a9899c74edd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/dataExtension.js\":\"f0a80e1584c4d859\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/index.js\":\"4c7c009e1fdd6b2f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/keys.js\":\"e90b4dd21c2f9b7f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/model.js\":\"ae964c10dfc9ad20\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/navigation.js\":\"5bcc2a361026d15f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/backfill.js\":\"a98b1671aa4745a7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/completion.js\":\"d41544dc6904bf5d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/format.js\":\"b574abb0016e60d7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/parse.js\":\"f004f45972f816e6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/queryValue.js\":\"631456c544b394d1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/query/source.js\":\"ef8443cac24f76a1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/registry.js\":\"8fe09d2c91f32fdd\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/rowGutter.js\":\"aaa5b27accfb37d7\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/rowVerbs.js\":\"f4a4d3bf21a44a31\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/schema.js\":\"24783638e9a536a6\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/tables/sort.js\":\"cb42ed4005eb8a24\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/effect.js\":\"d96ebb86582fce5f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/index.js\":\"759642aec955f004\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/theme-toggle/theme.js\":\"58ab932a95957add\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/actions.js\":\"015046b861e79261\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/dataExtension.js\":\"ed6551bc1632a810\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/index.js\":\"8fc0a2e5d50a214f\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/todo/schema.js\":\"362d5b137cd94ad0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1d9737427ab10b7e\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/actions.js\":\"eaf8ebed268fe894\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/defaultItems.js\":\"e77a9869e46d349b\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/facet.js\":\"d886ba2a962885ae\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/holdRecognizer.js\":\"1c822c5f4a64756d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/touch-selection/index.js\":\"521b27d2ad7235d5\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/UpdateIndicator.js\":\"6e4837589cce26d0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/index.js\":\"02866033ab089de8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/update-indicator/loadTimes.js\":\"558c14b8e49a4b64\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoNotesRenderer.js\":\"7d36c21fa81640b9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoPlayerRenderer.js\":\"d1226d15e5027979\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/VideoTimeStamp.js\":\"64447cf8231341ad\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/actions.js\":\"71089ede30568495\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/index.js\":\"fff3c8e2f910c6f8\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/markdown.js\":\"8cf21ac4f2cf8610\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/notes.js\":\"a0fe249fc441f5e0\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/registry.js\":\"acdff5b0cca2e925\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/remark-timestamps.js\":\"fc16316b5d8b485d\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/video-player/view.js\":\"cc3a8b4072b304ee\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/LinkHints.js\":\"a70a01222f569237\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/index.js\":\"becf2cec45df92b9\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/model.js\":\"30a70f633fbb9901\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-link-hints/settings.js\":\"af0d0920b09adfe1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/actions.js\":\"cc542498bb04d2d1\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/index.js\":\"297af815d18daacb\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/vim-normal-mode/interactions.js\":\"7e354db05ac854ff\",\"/knowledge-medium/pr-preview/pr-1858/src/plugins/workspace-header/index.js\":\"3b0f35ac40f82bf0\",\"/knowledge-medium/pr-preview/pr-1858/src/registerServiceWorker.js\":\"996523cc0ae26a62\",\"/knowledge-medium/pr-preview/pr-1858/src/requestPersistentStorage.js\":\"f0e467a0f74c71c0\",\"/knowledge-medium/pr-preview/pr-1858/src/services/authRequestDeadline.js\":\"14fb091839ea52a3\",\"/knowledge-medium/pr-preview/pr-1858/src/services/authStorage.js\":\"0a978e9267b9c715\",\"/knowledge-medium/pr-preview/pr-1858/src/services/powersync.js\":\"7a3ad132b381415d\",\"/knowledge-medium/pr-preview/pr-1858/src/services/supabase.js\":\"b05d2192a30ae06d\",\"/knowledge-medium/pr-preview/pr-1858/src/services/uploadErrorClassifier.js\":\"0e02e1f221709d6e\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/ActiveContexts.js\":\"cbc8ae976ba27709\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/HotkeyReconciler.js\":\"1b263b0c6d8f89c8\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/WipeLocalDataDialog.js\":\"79725e1c6ea51b7c\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/actionDispatch.js\":\"8fb3767b81f6a157\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/actionRefItems.js\":\"2454ec9292846088\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/applyKeybindingOverrides.js\":\"c4171c70bb08d1b6\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/blockActions.js\":\"d40674ddf6b0a200\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/blockMergeGesture.js\":\"e324ca82d8f53b6b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/canonicalizeChord.js\":\"c50c92befe033bd6\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/defaultContexts.js\":\"686b2816954f8608\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/defaultShortcuts.js\":\"5e9777cb9b5ebbd6\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/effectiveActions.js\":\"1e2ce33735954976\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/gestureAction.js\":\"e71cf50ebe621f16\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/gestureBinding.js\":\"199d7f6c24512fad\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/holdRegistry.js\":\"551050ac5b1c8362\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/keybindingConflicts.js\":\"bfec3160b6097592\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/keybindingOverrides.js\":\"d6be9e72ea67547e\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/pointerAction.js\":\"ae38c18c6aa05d9b\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/resolve.js\":\"d76ad3844b58359a\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/runAction.js\":\"a1cc1bd1ed14b762\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/sequenceMatcher.js\":\"e30d134f0d58f8b7\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/types.js\":\"45db67717c6dbc1d\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/useActionContext.js\":\"67a316d02c267a4f\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/useActionDiscovery.js\":\"d48b897e186f8218\",\"/knowledge-medium/pr-preview/pr-1858/src/shortcuts/utils.js\":\"8a5b548b034a414b\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/bootStore.js\":\"7593f89ee360d43e\",\"/knowledge-medium/pr-preview/pr-1858/src/sw/previewDatabases.js\":\"17659fd5c73bd699\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/byteTransform.js\":\"7648ecc940bf75a3\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/attachmentCleaner.js\":\"e9bee78dd93ab01f\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/attachmentParts.js\":\"add20898a17790c1\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/bundleParts.js\":\"b9ebe227e75e4a9e\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/bundleRecord.js\":\"e6edee44d1a9a20a\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/manifest.js\":\"9a2e7a35279910c6\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/takeBundle.js\":\"14529003a88588f1\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/bundle/verifyBundle.js\":\"10a4281c26bd3601\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/cleaningStage.js\":\"b1c1735b2fee5f9b\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionKey.js\":\"a1b2a69225a77d1c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/conversionServer.js\":\"edd3d65f6897c37c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/flip.js\":\"dbdca5bbd8ac1dab\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/flipAttempts.js\":\"7341d999842e481d\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/pages.js\":\"7585194ee8730aeb\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/preflight.js\":\"78bd391854ebf0da\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/reseal.js\":\"b272869cc8fdf840\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/runConversion.js\":\"98bda900825e6c7e\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/runLock.js\":\"f3d8cd3189f25437\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/sealing.js\":\"5a4dde1970ef59b7\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/sealingStage.js\":\"1c5bf8a7ad230990\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/stage.js\":\"ae9600ea4dcca8ba\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/conversion/verifyReseal.js\":\"3097708cd50c8d00\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/aad.js\":\"e10e7c4a38325541\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/aead.js\":\"3820b49009eadf70\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/base32.js\":\"465515ec00c7da54\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/base64url.js\":\"faf6acf8f93a3a8a\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/binaryEnvelope.js\":\"3516d68dae6fc9c1\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/byteAead.js\":\"729122b2286da215\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/canary.js\":\"f7a628b06b70622d\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/contentHash.js\":\"c02c855ded83f437\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/contentKey.js\":\"4f0d58d97c40a052\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/derivedIdNamespace.js\":\"e60872cc43d2fda9\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/envelope.js\":\"81c273231d392106\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/hex.js\":\"7983e2fc7540adda\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/sha256Hex.js\":\"35b893d28162a165\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/crypto/workspaceKey.js\":\"2e18981307c515b8\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/conversionState.js\":\"47d6c90f809b8432\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9bd950a4369684f0\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/pastedKey.js\":\"c1ac9529a8e3c3ba\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"975da1a26874840c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/flows/upgradeWorkspacePin.js\":\"40d2d9ea4cf38508\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/keyStore.js\":\"71f17cfd3145712a\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/mintWorkspaceKey.js\":\"e462d13bd0799133\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/modePin.js\":\"d4391bbd075b279f\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/openWorkspaceKeys.js\":\"81ea23c19cb4db22\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/resolveWorkspaceEntry.js\":\"751d1521e8f5fa9f\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/resolver.js\":\"4382c4994fb31d0c\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/keys/workspaceAccess.js\":\"d491bb37608b3c09\",\"/knowledge-medium/pr-preview/pr-1858/src/sync/transform.js\":\"b3ab43e6ab51fa3e\",\"/knowledge-medium/pr-preview/pr-1858/src/themeBootDefaults.js\":\"7aa974e1ee8691a4\",\"/knowledge-medium/pr-preview/pr-1858/src/types.js\":\"05b5ac6b19887d0f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/ClientLocalSettings.js\":\"4773c86062a5743a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/abortableSleep.js\":\"c9e5dea9822a091e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/array.js\":\"199f24e19f6d5671\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/backlinkAutocomplete.js\":\"1c17c2ff3af84d71\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/blockCrumbs.js\":\"a37fb04613b1db6f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/blockrefAutocomplete.js\":\"8bd8cdf010279001\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/cadencedIdleJob.js\":\"cb8363d9ba886752\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/callbackSet.js\":\"595788d8b95ad884\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/clientId.js\":\"0a5856fea5599562\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/codemirror.js\":\"4eb0cc9bfb82c130\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/codemirrorCompletion.js\":\"fbda8a2b4d41d1a0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/copy.js\":\"0578dcc5ae65d0e9\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dailyPage.js\":\"819fa8f15f9d9e39\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dbForensics.js\":\"b50368d3823112df\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dbForensicsHooks.js\":\"640f59861bf10e89\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/deleteBlockThroughUi.js\":\"f9d92388470192ee\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dialogs.js\":\"cf9ca107e51378ea\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/dom.js\":\"83993d9dbd465b8f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/downloadBlob.js\":\"1e53d31b986002f4\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/exportSqliteDb.js\":\"5bc939f2c7f4d74d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fileSystemAccess.js\":\"307251c7b8138648\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/flipSlide.js\":\"173fa6d1bfa2b0d6\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fnv1a.js\":\"8453647baacd9be3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/formatBytes.js\":\"565072fa7dc88f09\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/fuzzyRank.js\":\"b597d7fbfa17e2c3\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/idbKeyedStore.js\":\"ff69c2491f6547cc\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/idleCallbackPolyfill.js\":\"dba42a326ca4e0e6\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/keyboardAwareScroll.js\":\"f1824500a6c9946e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/keyboardViewport.js\":\"3e1569cd9b68afb4\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/lastWorkspace.js\":\"7e22f9f39ed58982\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutColumns.js\":\"95fd326373a01782\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutSessionDom.js\":\"f32a024810b49d5b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/layoutSessionId.js\":\"13839d8c34dd3aeb\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/linkClickGestures.js\":\"8a5bdc963f113c13\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/linkTargetAutocomplete.js\":\"7052543f1b8c2228\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/localDbCorruption.js\":\"2ccfbc464d7f0e98\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/localDbRecovery.js\":\"4718422b269eec67\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/markdownParser.js\":\"d59a40fb4457f74d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/memoize.js\":\"6d9cfae21c7a2c46\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/nameFieldCommit.js\":\"81ca136e6c27930f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/nameList.js\":\"d572a022e08cff17\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/navigation.js\":\"4b752ab4ffc56a8b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/omnilinerNamespace.js\":\"f64c353964090f04\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/opfsPageScan.js\":\"712b1b153d122e47\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelClearance.js\":\"42413613eb965909\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelHistory.js\":\"cbf19e587993ab2d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelLanes.js\":\"ffd514d1ee1d5c2b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelLayoutProjection.js\":\"96df96a11aacc25a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelScrollAnchor.js\":\"f45846bfa6f7de96\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/panelUrlFlags.js\":\"bd74e339c65344b1\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/platform.js\":\"ad0550deca19e6e2\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/pluralize.js\":\"baf15fa3cde4d6e8\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyCreation.js\":\"d632017a3105c2a4\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyNavigation.js\":\"d41e7d33dece8357\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/propertyValueContext.js\":\"7d3b5d5cb3665b37\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/react.js\":\"f991433805416eae\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/relativeDate.js\":\"1f07aa76b65f124e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/relativeTime.js\":\"d23cd27dd57886e7\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/renderScope.js\":\"15cb1ea836ea3648\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/resolvedThenable.js\":\"9f3bc9850c139288\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/routing.js\":\"111b76806db26367\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/safeMode.js\":\"8e0547de49fa5895\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/scheduleIdle.js\":\"5d204d1e595183ce\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/screenWakeLock.js\":\"208e5b076129a100\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/selection.js\":\"d206201742f18114\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/softKeyboardGrab.js\":\"961fca823739a8fe\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/startupTimeline.js\":\"220d0fbdf892840b\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/state.js\":\"9d6d8ee39ab7d182\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/string.js\":\"2ce29c51aafe6374\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/surfaceZoom.js\":\"2a78bd17cd61c86e\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/time.js\":\"86e5b6028ecc6ee0\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/toast.js\":\"afd75f6a0b6c13bc\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/toggleStore.js\":\"39169173f71f0adc\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/untilStopped.js\":\"a58f11eec1c361d5\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/userActivity.js\":\"c8846c7a5132062d\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/viewTransition.js\":\"bff2126f08dbfe9f\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/viewport.js\":\"0ba51d76c2943c34\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/webLock.js\":\"cf4bd0713f7ba91a\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/workspaceRecovery.js\":\"5fb4e545d9c3d6d9\",\"/knowledge-medium/pr-preview/pr-1858/src/utils/workspaceSnapshotStore.js\":\"ce8127678bd5868f\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-compiler-runtime.js\":\"0f5a33af650d5d54\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-client.js\":\"0df48db4b3586f05\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-server-edge.js\":\"15d3b58e6c5a3ae0\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-server.js\":\"198df340bf4930a0\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-static-edge.js\":\"d9bb398e9c19da76\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-static.js\":\"628471590989c337\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom-test-utils.js\":\"b8836109a63ddf8b\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-dom.js\":\"45b0d4a3a04a02cb\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react-jsx-runtime.js\":\"a4a73adc7cab2e32\",\"/knowledge-medium/pr-preview/pr-1858/src/vendor/react.js\":\"503443b1704b19eb\",\"/knowledge-medium/pr-preview/pr-1858/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1858/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1858/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
