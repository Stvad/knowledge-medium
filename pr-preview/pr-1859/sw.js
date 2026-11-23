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
		buildId: "cf43e972bb3c-f1ef37b8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/\":\"1e87780e09af202d\",\"/knowledge-medium/pr-preview/pr-1859/index.html\":\"1e87780e09af202d\",\"/knowledge-medium/pr-preview/pr-1859/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1859/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1859/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1859/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1859/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1859/assets/FacadeVFS-n1B3oGgz.js\":\"2e39e506909a8448\",\"/knowledge-medium/pr-preview/pr-1859/assets/OPFSCoopSyncVFS-DCcQkQJ1.js\":\"5b1b7c3d28f1940f\",\"/knowledge-medium/pr-preview/pr-1859/assets/OPFSWriteAheadVFS-BkD6pB7D.js\":\"692b958b7d9302a3\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-BJcEG88H.js\":\"7aa867852361794a\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-async-BMri4MLr.js\":\"3491023f3edf3e73\",\"/knowledge-medium/pr-preview/pr-1859/assets/worker-D145vx3w.js\":\"7451a0b6e05107c2\",\"/knowledge-medium/pr-preview/pr-1859/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1859/chunks/app-nczJPYjc.js\":\"241dd1b8a073db4f\",\"/knowledge-medium/pr-preview/pr-1859/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1859/index.js\":\"c5003a9fda3cc5f6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1859/assets/AccessHandlePoolVFS-U7HNKv2V.js\":\"867463aa74213191\",\"/knowledge-medium/pr-preview/pr-1859/assets/IDBBatchAtomicVFS-Di6tdqmw.js\":\"167bbfd0bfc7b9ef\",\"/knowledge-medium/pr-preview/pr-1859/assets/MemoryVFS-DxGdy99J.js\":\"98220eb0fa19c0f0\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-D6-ARCJ9.js\":\"34103ca0a2db378f\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-async-CcP1ICa_.js\":\"1d14e802f75965be\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1859/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1859/chunks/AccessHandlePoolVFS-BusFVb1S.js\":\"f929ecc03e63c91f\",\"/knowledge-medium/pr-preview/pr-1859/chunks/FacadeVFS-B6hUxbg9.js\":\"14e24ca8dffc1c2c\",\"/knowledge-medium/pr-preview/pr-1859/chunks/IDBBatchAtomicVFS-nQhP-6sf.js\":\"de9efb76147ecb11\",\"/knowledge-medium/pr-preview/pr-1859/chunks/MemoryVFS-D1Vm8rvP.js\":\"5083ce629df26c17\",\"/knowledge-medium/pr-preview/pr-1859/chunks/OPFSCoopSyncVFS-Ce75QfgB.js\":\"a6d7595a665e43e1\",\"/knowledge-medium/pr-preview/pr-1859/chunks/OPFSWriteAheadVFS-Byw8JBsm.js\":\"d215c8dcf8fde443\",\"/knowledge-medium/pr-preview/pr-1859/chunks/Preview-Dp1aBiQY.js\":\"67a59d6325283c61\",\"/knowledge-medium/pr-preview/pr-1859/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1859/chunks/card-BZhaZHuB.js\":\"aaa901cba38a8446\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-BVtCvaez.js\":\"481cd06df3dbb493\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1859/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1859/chunks/mc-wa-sqlite-BKJjP9u7.js\":\"9700f18313a4e9b3\",\"/knowledge-medium/pr-preview/pr-1859/chunks/mc-wa-sqlite-async-CQUIW157.js\":\"c26fa817cb604624\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-B2uHSnk4.js\":\"9e765059448870a0\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-BFscjJWO.js\":\"e6ede1849986811b\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-BYtgz3Tx.js\":\"f64a55a99ccf29dc\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-C2zFItUk.js\":\"2055458e009357f2\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-C3xuG2yy.js\":\"f600ceb00cbc8db7\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-DWnWIpdO.js\":\"7b2199e3d3e1f590\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-DyMpQM-f.js\":\"fabcdd7d3046bcd4\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server-legacy.browser.production-BQtvAUtF.js\":\"7cdf33d4196e637e\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server.browser.production-DzVxVEUq.js\":\"39cebfa277209064\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server.edge.production-BPt-Trma.js\":\"935f458785690dde\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-gx-NWOP9.js\":\"0d9e16518d691d76\",\"/knowledge-medium/pr-preview/pr-1859/chunks/server.browser-B9zgKurp.js\":\"3fed971e87d0f9ff\",\"/knowledge-medium/pr-preview/pr-1859/chunks/textarea-BbR2n5Fh.js\":\"a3a6f7282ea4f5b0\",\"/knowledge-medium/pr-preview/pr-1859/chunks/ui-Qqdf5m6B.js\":\"bf41aa884574cd09\",\"/knowledge-medium/pr-preview/pr-1859/chunks/wa-sqlite-DnvorOw_.js\":\"41222972b3c2c95a\",\"/knowledge-medium/pr-preview/pr-1859/chunks/wa-sqlite-async-Df3v7wD1.js\":\"39bacb6ec45296eb\",\"/knowledge-medium/pr-preview/pr-1859/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1859/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1859/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1859/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1859/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1859/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1859/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1859/src/App.js\":\"a7405550635d9528\",\"/knowledge-medium/pr-preview/pr-1859/src/appUpdate.js\":\"635057bc97a94954\",\"/knowledge-medium/pr-preview/pr-1859/src/appVersion.js\":\"0221df12af7ea27a\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/initialLayout.js\":\"18e0c4fb09904766\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/openWorkspaceData.js\":\"8cc5e0333fd5b3da\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/resolveWorkspace.js\":\"46e34dd9e0cf526b\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/workspaceBootstrap.js\":\"e67f9b752fca4dfb\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockComponent.js\":\"0c73580384407cc5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockCrumbs.js\":\"6a70a5dc41a781a1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockEditor.js\":\"8850ce7a8fad5857\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockLoadingPlaceholder.js\":\"4656387aa854527a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockProperties.js\":\"044c46f3035b99de\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockSearchPicker.js\":\"0bc0b14d9707bec7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ConfirmBulkDeleteDialog.js\":\"1b46eab133369b3d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/DividerHandle.js\":\"f14160aec901183f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/DraftEditor.js\":\"18fea8a2c9502c1c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/GutterPill.js\":\"aa1d72296d1cf442\",\"/knowledge-medium/pr-preview/pr-1859/src/components/Header.js\":\"6ddfb161abb5aff3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/LazyBlockComponent.js\":\"de95c50ace9a333b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/Login.js\":\"e9f719b7777502ff\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ZoomableSurface.js\":\"1aa2623985bc4e84\",\"/knowledge-medium/pr-preview/pr-1859/src/components/editModeKeepalive.js\":\"25a393d48ad7fb26\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyDisplay/PropertyDisplayScope.js\":\"39c83162b1465d22\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0155ebc2591bd8ec\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/RefPropertyEditor.js\":\"825fe7870d3d4c84\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/RefTargetTypePicker.js\":\"9437275f7eac0377\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/SelectPropertyEditor.js\":\"9669d49451c8a796\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/TypesPropertyEditor.js\":\"d3eaa81f5c0b10d5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/defaults.js\":\"df4622f3ff60a1a5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/kernelValuePresets.js\":\"7e19894c821394f2\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/selectablePresets.js\":\"950e980351d3e709\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/typesPropertyUi.js\":\"808bebef0825ecf0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/AddPropertyForm.js\":\"54616cb4bbf87794\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/PropertyPicker.js\":\"93f2db5f9640479b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/PropertyRow.js\":\"8bab26ba409bc245\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/Rows.js\":\"cb0a4c1ff84cb37b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/actions.js\":\"1a1bcdda2e59255f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/declarationOnly.js\":\"3af5f5079ed611bb\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/layout.js\":\"1bdfa74bb9c28e7b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/model.js\":\"06793248efd63809\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/shapeUi.js\":\"60871948ef8d08e8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/shapes.js\":\"0c9f55fe62e8dcf7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/usePropertyEditingActivation.js\":\"cbedfbca7ab3c699\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/visibility.js\":\"ba46f6521a3a4d90\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanelSections.js\":\"174ab4295c47c288\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockEmbed.js\":\"62a20f76f3b10b3d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockLink.js\":\"18060c5731819af3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockRef.js\":\"9850ab97d89e4eb8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/ReferenceLink.js\":\"b28277387bc1d652\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/cycleGuard.js\":\"d405fa704fc3aaec\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/cycleGuardContext.js\":\"0a702d5e54faa4ba\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/linkInteraction.js\":\"a8071c65f6394942\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/referenceLayout.js\":\"65ac53a9b239342b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/useBlockRefAncestors.js\":\"89e4ca565ca35104\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockGutter.js\":\"1f11e8a29efa7366\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockInfoDialog.js\":\"dc7bfb17ce9a7655\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockTypeBlockRenderer.js\":\"45768e50960cc0f5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BulletHoverCard.js\":\"45e843e151a7aafd\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/CodeMirrorContentRenderer.js\":\"be6fd82f03fa11e4\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0648504df91b5433\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/ColumnResizeHandles.js\":\"001c5ac6ddd470e0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"fd5c8e7a255c8047\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/DefaultBlockRenderer.js\":\"a0a99e6e49b1e61c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/LayoutRenderer.js\":\"f379213dde67d326\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/MarkdownContentRenderer.js\":\"b92687064d49eab0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/MissingDataRenderer.js\":\"db08fec4f703445f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/PanelRenderer.js\":\"e111b1964c4d7699\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6fdd598be0b398da\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/TopLevelRenderer.js\":\"9e8ed0527f4e705e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/blockGutterMode.js\":\"24969646b7bda3e0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/blockTitleText.js\":\"1cd3349e3bbe210a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/fieldCreationKeydown.js\":\"b54a55cb19c35612\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/layoutRootContext.js\":\"c3b88cc5e60d4482\",\"/knowledge-medium/pr-preview/pr-1859/src/components/typeChip/TypeChip.js\":\"3e6b1b747654130c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/typeChip/chipStyle.js\":\"d3ea63e90cd17e42\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/anchored-floating.js\":\"78ef6cfa53c503c2\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/button.js\":\"e1d53afd17fd86e5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/card.js\":\"2507b17d8d2530c1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/checkbox.js\":\"43b106dcf4f8dfe6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/collapsible.js\":\"301192cf2407a109\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/command.js\":\"0c25795bcd91a893\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/context-menu.js\":\"d3381ca4167e650b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/dialog.js\":\"5855a70b88300611\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/dropdown-menu.js\":\"fba75367f13fdf8a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/floating-listbox.js\":\"495e1f945700e0bf\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/index.js\":\"7f15a8ea6fae7a09\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/input.js\":\"04e70ed5d92bed0c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/kbd.js\":\"94c8d3c478bb6c1c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/label.js\":\"3ee9cc59b5c02ff6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/textarea.js\":\"78da13ef4676077f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/useEditModeYieldKeepalive.js\":\"1ae2acffabb6e4ae\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/BootFallback.js\":\"3274bc613b0ebf1d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/FocusedRowLazyMount.js\":\"acb491b0e009fe6a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/LazyViewportMount.js\":\"bc0afad7bfd65f29\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/LocalDbCorruptionFallback.js\":\"5d989be03f80541b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/error.js\":\"80065c1b9eab0e76\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/lazyMountRegistry.js\":\"34685f281420535a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/suspense.js\":\"f400ad30f3c9744e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/CreateWorkspaceDialog.js\":\"6af457fab20ca6e7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/PendingInvitations.js\":\"1ddc13be18481980\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/SyncProgress.js\":\"d12990aecdfb68f8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/UnlockProgress.js\":\"d2ca526d72913582\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceKeyGate.js\":\"716aa4f1ad77c17a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSettingsDialog.js\":\"ad7ce519857b1185\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSwitcher.js\":\"279d2e7e28e67250\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSyncGate.js\":\"3a41871a947d603a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/ConversionFlow.js\":\"f65bb6edeb020501\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/ConversionFlowHost.js\":\"01b89176209f182a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/EncryptionSection.js\":\"b0b23b1a5c444e4d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/attachmentPrompts.js\":\"36deef46b5fef968\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7d731c66ae4070f9\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/conversionFlowDeps.js\":\"e6ba87d2d4287d4c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/conversionFlowStore.js\":\"a250b6084e247019\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/flowUi.js\":\"1a055f940267e7b5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/useConversionRun.js\":\"fa2584597b0b2a61\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/keyUi.js\":\"3fc2296ca6b428b6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/useCloseOnKeyLoss.js\":\"aec19c40dd10aca2\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/useCloseOnServerE2ee.js\":\"3536467934d13284\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/workspaceUnlocked.js\":\"ea07a6a4f075c3b9\",\"/knowledge-medium/pr-preview/pr-1859/src/context/backgroundSubtree.js\":\"d2137e19647e23a8\",\"/knowledge-medium/pr-preview/pr-1859/src/context/block.js\":\"a6abb1229cb36bb8\",\"/knowledge-medium/pr-preview/pr-1859/src/context/layoutWsContext.js\":\"fb50f4bfbc6cfc76\",\"/knowledge-medium/pr-preview/pr-1859/src/context/propertyDisplay.js\":\"4ab8b2ce0840e17c\",\"/knowledge-medium/pr-preview/pr-1859/src/context/repo.js\":\"9eb7c5fe704cc235\",\"/knowledge-medium/pr-preview/pr-1859/src/data/aliasClaim.js\":\"401cf0aaf5377831\",\"/knowledge-medium/pr-preview/pr-1859/src/data/aliasSeatNamespace.js\":\"d43c36e2d427f1a8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/blockData.js\":\"fb6ac0c425b6c959\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/blockType.js\":\"5f0d984ded9e70ef\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/changeScope.js\":\"6d6a288fdc40b668\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/codecs.js\":\"918a17da2e0e832e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/derivedData.js\":\"c839b426599fd2d8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/errors.js\":\"9ea897e88940a103\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/events.js\":\"d2b76637b77a8f20\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/handle.js\":\"3120c90574207269\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/index.js\":\"b397bf34aa8a8c7b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/mutator.js\":\"4c882bc673298c01\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/processor.js\":\"b7b37b5a917c01fc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/propertySchema.js\":\"d4a4da6ff3406af0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/query.js\":\"b61c37c59c32b568\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/sameTxProcessor.js\":\"73eb719064181ae2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/schema.js\":\"3120c90574207269\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/tx.js\":\"3120c90574207269\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/typedBlockQuery.js\":\"3f538cb311d79393\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/user.js\":\"31ead0ab0131a812\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/valuePresetCore.js\":\"31df14584ddd82b4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/valuePresets.js\":\"3488922052f5c479\",\"/knowledge-medium/pr-preview/pr-1859/src/data/attachmentCleanerIOVerb.js\":\"c9469285eb117278\",\"/knowledge-medium/pr-preview/pr-1859/src/data/block.js\":\"560776737cb7629f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockCache.js\":\"76e7e09ea4c1a7e9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockId.js\":\"c7e5baf88218db0b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockLiveness.js\":\"3dd9df7d1679a1d6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockMerge.js\":\"d484a5f24a918feb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockSchema.js\":\"919fc4db176029b8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockTypeLookup.js\":\"4a49a702dbb4b315\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockTypes.js\":\"f2f12178dc325cae\",\"/knowledge-medium/pr-preview/pr-1859/src/data/childrenView.js\":\"11d4909d2bf729c8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/clientContext.js\":\"33ee24168dae3dc7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/dbFileSiblings.js\":\"0943560ce81c375b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/definitionSeeds.js\":\"4eaad2319bb2336f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/derivedIds.js\":\"05fca0cf9a6d724b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/drawnSubtree.js\":\"73e42929143abecc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/facetBridge.js\":\"f1e68b289fcb54f3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/facets.js\":\"addcc99793436477\",\"/knowledge-medium/pr-preview/pr-1859/src/data/globalState.js\":\"84ce6a1f8d963d0e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/aliasClaimRederiveProcessor.js\":\"f4cbcb779de711aa\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/ancestorBatch.js\":\"0ff70f1dde9837a8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/blockTypeTypeifyProcessor.js\":\"4f70894df8ed59f5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/clientSchema.js\":\"0424e9b6af9a5411\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/commitPipeline.js\":\"f381986c7d4f2530\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/devAssertions.js\":\"3ae8f1bd2a36a006\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/firstSync.js\":\"1a1d39ecbf2549fc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/freshInitialLoad.js\":\"f43d9eead9f9b57a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/graphBackfillClaim.js\":\"ad541f934d4b2246\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/handleStore.js\":\"80c98f65d581d3a4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/idleMarkerJobs.js\":\"2f479071370dc9b8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/initialDownload.js\":\"1c7def0589a30f8d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/initializeClientDatabase.js\":\"9289abab746bc537\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/jsonCanonical.js\":\"a0598857a60c6a9f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelInvalidation.js\":\"ff84040a7f3f387d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelProcessors.js\":\"296172f9e908bf52\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelQueries.js\":\"f675baaa28477e12\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/mergeTypeMembershipProcessor.js\":\"9314092a627112d6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/normalizeReferencesProcessor.js\":\"513744e58acc1563\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/poolInstrumentation.js\":\"248bd1831de7ea19\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/processorRunner.js\":\"beb1d9e2b2857d8b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyCellBackfill.js\":\"52a47331c6a654ed\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyChildMint.js\":\"1bab7a607490957d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyChildrenProcessor.js\":\"93c266fd5059424d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyDefinitionChangeProcessor.js\":\"383fdf875036a3e7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyDefinitionSynthesis.js\":\"f0639c9417e7b807\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyKeyScan.js\":\"7fbd59606209f6c8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertySchemaResolution.js\":\"8424db006ddfd139\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyValueEdits.js\":\"08222fdb4ee8e860\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/raiseProtocol.js\":\"75120702e55ac586\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/readBatch.js\":\"05f11fb4a6a5fb9c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/refProjection.js\":\"e60439efe7b4e950\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/referenceTargetLookups.js\":\"94172817e9b1ecc8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/referenceTargetProcessor.js\":\"78766dde01223463\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/replayMerge.js\":\"a160c2a9fd6a564a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/sqlBinds.js\":\"5ed70eb0691a470b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cecc766235c4c11a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/arrivalProcessors.js\":\"4c43fedd2ec5bbdd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/invalidate.js\":\"aa481489e9fb70f3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/materialize.js\":\"f63d139f2c7555a5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/observer.js\":\"b2746e951e4d85e7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/reconcile.js\":\"80485822890fb263\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/timingMetrics.js\":\"d8d7afaf5dea8f97\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/treeQueries.js\":\"9ac79b8b0cf42500\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/txEngine.js\":\"08b4842f1f9674d6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/txSnapshots.js\":\"098752e5acb25bc8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/typedBlockQuery.js\":\"03cfdb63015bb56a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/undoManager.js\":\"0e971d1c191f9198\",\"/knowledge-medium/pr-preview/pr-1859/src/data/invalidation.js\":\"53716a83857be00c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelDataExtension.js\":\"f069088e0fc2dd10\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelPage.js\":\"b05c2e9ab17a0ecd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelValuePresetCores.js\":\"aa72db6769ec8d44\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbCorruptionSignal.js\":\"4d35b5497e81225c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbStorage.js\":\"7c54dda392d9ce34\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbVfs.js\":\"fdf9fc23f62da826\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localSchema.js\":\"307446ac18aba866\",\"/knowledge-medium/pr-preview/pr-1859/src/data/maintenance.js\":\"731b5d6c029a6fdd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/mergeProperties.js\":\"b416e9f0b5a38641\",\"/knowledge-medium/pr-preview/pr-1859/src/data/metricsConsoleHook.js\":\"708bbe93c9d1137b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/migrationsPage.js\":\"d9a53d59d53c0cab\",\"/knowledge-medium/pr-preview/pr-1859/src/data/mutators.js\":\"fc85bfc9559b8634\",\"/knowledge-medium/pr-preview/pr-1859/src/data/orderKey.js\":\"3a7f86942e57e23a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/orderKeyPlacement.js\":\"46ea8c9286a60ecd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/outlineSurface.js\":\"0bba353ae98e442f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pendingEditorContent.js\":\"d4eb257ab422e647\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pendingUploadsSql.js\":\"bae5dee46ea7406e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pluginStateExtensions.js\":\"2ab464cbe51346f5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/powerSyncLogger.js\":\"8736bdb2b0aaee60\",\"/knowledge-medium/pr-preview/pr-1859/src/data/projectorRuntime.js\":\"10880aeba977370c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/properties.js\":\"81b94d1c8a0c6a43\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertiesPage.js\":\"032fdc3eac5c7f17\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyChildren.js\":\"5e7045549efbe61c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionFanout.js\":\"a25f6aca30327cca\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionMetadata.js\":\"1c3450518516e229\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionRegistry.js\":\"e7ac6bd8f5d52b8b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDisplayMode.js\":\"3518a57444a765af\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyRowCreation.js\":\"0c1fc52a6c298427\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertySchemaCreation.js\":\"cae86c18bc8b23e6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertySeeds.js\":\"f88838c9d7998dcd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/recentsPage.js\":\"4f8f7ae45adf76a7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/referenceBlock.js\":\"6e95672655f3fe72\",\"/knowledge-medium/pr-preview/pr-1859/src/data/rejectedUploads.js\":\"3f8b112528aeaf9d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/releasePowerSyncConnection.js\":\"b51961ad3e049a80\",\"/knowledge-medium/pr-preview/pr-1859/src/data/repo.js\":\"51d902f0fe95c200\",\"/knowledge-medium/pr-preview/pr-1859/src/data/repoProvider.js\":\"c915a1c5128621af\",\"/knowledge-medium/pr-preview/pr-1859/src/data/rowProperty.js\":\"66df7a97e616f21e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/searchFilter.js\":\"5e259bb1e51c2bcf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/seedIdentityLedger.js\":\"9cf11ae7e40b7cb9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/stateBlocks.js\":\"5a7e68acc8f4d5c7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/structuralEditPolicy.js\":\"f287e29087bba94e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/subtreeDelete.js\":\"98c71a02ac2968f2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncStreamLock.js\":\"edaab0ad8254ce37\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncedTableSqlRecognizer.js\":\"57fa33d48512e7ec\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncedTableWriteGuard.js\":\"54fa178c7032f46a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/targets.js\":\"d863286721371346\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeColors.js\":\"4ced8d3fee6cdccf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeDefinitionMetadata.js\":\"547c0c1689148c9d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeDefinitionRegistry.js\":\"b368a3671f720c2b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeExtraction.js\":\"28c931d61d3bdd61\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeInitialValues.js\":\"4451215ed2b9e829\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typePropertyGroups.js\":\"ca4455d4b03068fc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeSeeds.js\":\"7f2b5362611d3eca\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeTagger.js\":\"2c7cfd4263815115\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typedRecords.js\":\"d69b4b0f9b51228f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typesPage.js\":\"9f7f86ad6270b5c5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userPrefs.js\":\"38867c69cd26ac6f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userSchemasService.js\":\"2780a8276eb4ff22\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userTypesService.js\":\"1fa332ff4b97fb93\",\"/knowledge-medium/pr-preview/pr-1859/src/data/valuePresetRegistry.js\":\"66193ae36388f442\",\"/knowledge-medium/pr-preview/pr-1859/src/data/visibleChildren.js\":\"de520c1b13a9bb19\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceConversion.js\":\"96cdc5a4a1559988\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceFirstSync.js\":\"38a5268c3060cecc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceIdNamespace.js\":\"4e7f19cd19301e0b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceSchema.js\":\"86f1d318720d6ce1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaces.js\":\"b53b11320ca80284\",\"/knowledge-medium/pr-preview/pr-1859/src/data/writeAheadLog.js\":\"f98989db26a86383\",\"/knowledge-medium/pr-preview/pr-1859/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/BlockPasteShellDecorator.js\":\"062e528a266f0dd1\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/atTrigger.js\":\"961b927291a4387a\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/autocomplete.js\":\"1136e61c7cbbe522\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/codeMirrorExtensions.js\":\"0db26930f5037631\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/contentFlush.js\":\"8bf5917474472a0f\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/defaultInteractions.js\":\"d8f111a06d5db7d0\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/editSettleSignal.js\":\"2fa30e207c0242cf\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/insertImage.js\":\"687dcdc38796972c\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/referenceCompletionRange.js\":\"8f1e28b1b7ec4ede\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/referenceTargetTypes.js\":\"18b63c703acfb4f4\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/syntaxContext.js\":\"203f713dfa03b10c\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/triggerMatch.js\":\"c74771eda88ca247\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/AppRuntimeProvider.js\":\"fc40df2551cfcca9\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/BlockFocusShellDecorator.js\":\"4cd82ef43ee047fb\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/ExtensionRenderBoundary.js\":\"c95b55330815a562\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/PanelContentRecovery.js\":\"9fbbc141b57a9207\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/apiCatalog.js\":\"c8824c4913b64bb2\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/approveExtensionHere.js\":\"32fab9a19f4dc51c\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/armedCutAppMount.js\":\"68632aa0f11fb44f\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/batchableKeyedStore.js\":\"6af423500289222c\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/blockInteraction.js\":\"23cfb0947a425693\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/blockSelectionAction.js\":\"9eaa40c6c7596e14\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/compileExtensionModule.js\":\"0119039cbd0023de\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/compiledModuleCache.js\":\"4a685295ca1875c4\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/continuousGestures.js\":\"7d396bd9e1f29160\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/core.js\":\"067d48ac90a352c2\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/defaultRenderers.js\":\"70550f398e096e7c\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/definitionFanoutAppMount.js\":\"99d9c96cc07887de\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dialogAppMount.js\":\"d7f9b19f15ff32c4\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dynamicExtensionSeeds.js\":\"6a4ce5793eab47b5\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dynamicExtensions.js\":\"4fc0244f1d3fcc66\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/exampleExtensions.js\":\"0e041d9594ef64d4\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionApprovalStatus.js\":\"02e12bf16fca4e23\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLoadErrorToast.js\":\"7824ad68f6c3f9b3\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLoadErrors.js\":\"23b0af7154a9dff2\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLookup.js\":\"61feb20cba970bad\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionToggles.js\":\"67bfc7f2de0d1201\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionUtilitiesCss.js\":\"26702bf6e7ea3ae9\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/kernelPageDeletionGuard.js\":\"8c35323c34f83ac8\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/liveRuntime.js\":\"22d8ae9af8dbcbc8\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/openExtensionsSettings.js\":\"f00a556de43ba2b9\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/overridesCache.js\":\"44362b9eda718707\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/pluginIds.js\":\"09289b9829b89c02\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/processorRejectionToast.js\":\"f99ee9fe14852866\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/runtimeActions.js\":\"8e82f40bd822d4c4\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/runtimeContext.js\":\"272c746d4c2f4af8\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/staticAppExtensions.js\":\"30fefb0f7db63d04\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/staticDataExtensions.js\":\"dfe12a9436ce9719\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/toastAppMount.js\":\"e835ac9879784385\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/useOverrides.js\":\"04c40fafb02a0033\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/useShortcutSurfaceActivations.js\":\"61e59160e432442b\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/discoverToggleTree.js\":\"4804874c2298b314\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/facet.js\":\"43d1ce52a4002522\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/resolveAppRuntime.js\":\"63437735e9cc2dc2\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/runtimeEvents.js\":\"7f7e6f06a3a5aa27\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/togglable.js\":\"797044c3fe8ca4b8\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/variantFacet.js\":\"e45365d167b20d6c\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/verbFacet.js\":\"c0684070248bb922\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/block.js\":\"d2d9187c4d11052d\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/focusedChild.js\":\"08be6b04605b05a9\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/propertySchemas.js\":\"536a624df0bd5d3d\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/typeRegistry.js\":\"e6da30ca5991aacf\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useAncestorCrumbs.js\":\"ef0a5a28e3c6ab3a\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useAutocompleteListbox.js\":\"16997ca666445615\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useDebouncedSearch.js\":\"1fec994daffcc6fa\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useDebouncedValue.js\":\"fb314806fca8ac9d\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useIsFocalRender.js\":\"04773fbc32937b32\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useIsReadOnly.js\":\"68e4622014ede60f\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useMaterializeBacklog.js\":\"4f7b11be3362f489\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useMinuteClock.js\":\"e57a1991430fa3e2\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/usePanelLayoutProjection.js\":\"e16bba6d12c0ba34\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/usePendingInvitations.js\":\"13626d03e92c785a\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useRendererRegistry.js\":\"5cfc1e83b2c088fc\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useRetainedFieldRows.js\":\"496d28ac047ae6ef\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useWorkspaces.js\":\"ded04f187a3f6b07\",\"/knowledge-medium/pr-preview/pr-1859/src/lib/utils.js\":\"35c18f2504d6ae16\",\"/knowledge-medium/pr-preview/pr-1859/src/main.js\":\"b75ac1f56d5926fa\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/MarkdownImage.js\":\"4ea861a4eb5178b2\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/blockSeparators.js\":\"5b7a3dc43d2b621f\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/context.js\":\"c65bb2352044d6fe\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/defaultMarkdownExtension.js\":\"a8373f21fc05f077\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/extensions.js\":\"cf66e4c412edfaa3\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/renderMarkdownHtml.js\":\"6981202a55919a4e\",\"/knowledge-medium/pr-preview/pr-1859/src/minimal-editor.js\":\"d5a7cb6399c3f556\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/armedCut.js\":\"04e37d90f23cd4db\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/captureMediaVerb.js\":\"b0a599e46de5de8a\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/clipboard.js\":\"e42fac17f0cd34fa\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/decision.js\":\"3340ed6d8bc1492f\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/operations.js\":\"9531b681953c9035\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/account-header/AccountHeaderItem.js\":\"382c2a3ed6f91cea\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/account-header/index.js\":\"098fe3340768c5e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8a2982a1a0389895\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/askAgent.js\":\"e33db6f306ebfb84\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/askedStore.js\":\"f117cad7612c0d69\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8cd6428a32f1a8f9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/chipState.js\":\"e005aeb5b5c4e8a4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7499a36ee5c45d3b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/index.js\":\"27eb07f1f1400d6b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"903f3186cfecbf44\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/schema.js\":\"92d47fb7cad5e070\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/AgentTokensDialog.js\":\"62803bcb4a66bf16\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4a9b13581f89aba1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/addMedia.js\":\"e85dfeda02b2cd4f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/backlinks.js\":\"096b7178e48f1b09\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/block.js\":\"d41980129df98477\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/context.js\":\"7d3d3632b0b66ffb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e98dbdec3b3573b0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/index.js\":\"d8d462af374387ac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/outline.js\":\"0538b516e581f77a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/properties.js\":\"e0bc9d682b2e935f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/refs.js\":\"74ad57e835771283\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6d1ccefcebce073f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/search.js\":\"6ef62441e2dd6270\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/shared.js\":\"1166cc45989c7392\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9206514d1218afc3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/text.js\":\"590d03ae58b9779b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentWrites.js\":\"2c1c5d5c657d8498\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/authoringCatalog.js\":\"6d43e9fbd47bf98c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/blockRefTargets.js\":\"2f487f142bf88dcf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/bridge.js\":\"5cf235e6e82918f8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/bridgeLoop.js\":\"160afe90f8376c73\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/changeHistory.js\":\"eb8a2782494a9edd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/commands.js\":\"bf3df89871e923fc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/commentsCommands.js\":\"d60ea53a1e6d2978\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/dataExtension.js\":\"080d836404c59095\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/dataModelGuide.js\":\"ac6d40e06d0c9e76\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/describeRuntime.js\":\"1121179e7b324953\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/extensionLint.js\":\"86f542528d47ef16\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/grainAudit.js\":\"d2408927f2ceffe3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/healthCommand.js\":\"c9f1c9c899500408\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/index.js\":\"d814a36d47f6f121\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/presetIdentity.js\":\"a8a7f66dcbd0c77d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"027d79f482d270e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/readMedia.js\":\"90052e8df7547792\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/schema.js\":\"1244ca8023278271\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/serialization.js\":\"133032a0a6a5b6a4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/targets.js\":\"f82f0c38a1c8a923\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/tokens.js\":\"d1a01639f6bf7c18\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/watchEvents.js\":\"98cc919301ff4952\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/workspaceGuard.js\":\"c869018f6603c079\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/writeCommands.js\":\"184bf5347827867c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/AliasCollisionToast.js\":\"d432fd4b5201211d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/DuplicateNameBanner.js\":\"a34fd39631dfab33\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/collisionMerge.js\":\"0ea01ce353ada046\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/dataExtension.js\":\"cec85a0ba9f5be07\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/index.js\":\"3de0947c22bdf902\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/mergeCollisionAction.js\":\"121d20de493d1ff7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/pageStyling.js\":\"dc0c9a9d7f3f0421\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/rejectionToast.js\":\"0247537527d1d1f1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/syncProcessor.js\":\"9b350a2d72d415e2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/actions.js\":\"2e6532d4bf2a7838\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/addComment.js\":\"32d3425b956dff70\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/anchor.js\":\"120976f72fb8566c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/anchorState.js\":\"2a16208fe56b10fb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/commentLinks.js\":\"07816ac17f9a0232\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/confirmThreadDeletion.js\":\"4cc872ec83c900b0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/container.js\":\"89763e69def5328a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/dataExtension.js\":\"a7f66fb1526dd09d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/deleteComment.js\":\"bec6f929c180c8ee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/highlights.js\":\"ea5e135491d7f799\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/index.js\":\"92bdc157afc0bd06\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/linkedCommentsPill.js\":\"e591e8deb519ddb3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/margin.js\":\"28c884280fc5b827\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/marginSchema.js\":\"913d57dccc69599b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/newComment.js\":\"ba58906b8a026f38\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/ownThreadPicker.js\":\"3959fe3778cc0b2f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/placement.js\":\"4f0622f0277ea1d0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/queries.js\":\"220fdb18760f1949\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotePosition.js\":\"40e786d0631f51d2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotedIn.js\":\"a8cb3befc0e04eb1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotedRange.js\":\"2538aee757f04320\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/rangeRefs.js\":\"2cafc3702edd8c76\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readHighlights.js\":\"f6ed028b7240bc8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readSelection.js\":\"44ac6c5c83382fca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readSelectionUi.js\":\"fa9ac7038f9e8638\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/reanchor.js\":\"81a8c9c67478f9f7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/schema.js\":\"fd2d76351ad6c60a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/scope.js\":\"04be051254f9b660\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/scopeThreads.js\":\"6be368cc841c4af1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/splitRetarget.js\":\"c252d93d67e6baff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/suggestionCard.js\":\"c232f7ef72db45ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/suggestions.js\":\"22fe0c26e7a1f96c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/summaries.js\":\"b6fe0ae035abb3ca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/summaryBatch.js\":\"39075b108dab04bd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/surface.js\":\"538682b4bb864051\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/threadNavigation.js\":\"64596bfbea95dd19\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/threads.js\":\"ef6c842738f2f113\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/ui.js\":\"237efd9b7c227d59\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/uiStore.js\":\"9ed86735e6e2088a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-intents/appIntents.js\":\"63944cd16af9cde8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-intents/index.js\":\"7687383cb5831d01\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-update-prompt/index.js\":\"2097d6dafcf4c39e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-update-prompt/status.js\":\"f27f518c2b95f426\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a48666a06877da88\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaBlockRenderer.js\":\"d235def3607c4cff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1ab21502c2cfa099\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaUploadReconciler.js\":\"0d6714b609feb232\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetDownLane.js\":\"d41e281406e6e6b5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetResolver.js\":\"1d974bc0ffc62ebb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetUpload.js\":\"c9eee95bdaeb6455\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/attachmentCleanerIO.js\":\"d8d533e811790a2f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/supabaseAuditIO.js\":\"15db505729a4b544\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/blobStore.js\":\"62fccb6d1aa55752\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/browserMedia.js\":\"ce46b06460e63db0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/byteStore.js\":\"fc1cbdda9c6b7174\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/cleanerIO.js\":\"83d3f4a9b57d5d4e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/cleanupAttachments.js\":\"aff85415cfaf30ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/dataExtension.js\":\"4eb7fffb177e51b8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/downLane.js\":\"4bead22bc6b273e0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/index.js\":\"9499d0d6ef2c36ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/insertImageContribution.js\":\"30fade6733fc9b01\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/laneArming.js\":\"49df253ed5172b76\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/laneLock.js\":\"ac438732a530a65d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaBlock.js\":\"38057ef7d62e3832\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaCapture.js\":\"8c2696601d1418db\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaLanes.js\":\"73d24d2557e0b025\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaViewers.js\":\"3c939fe0f9a0fe21\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaViewersFacet.js\":\"4fa124f5cc42bb0f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/pasteCapture.js\":\"e72135bd2ed48636\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/resolver.js\":\"20e9dd9017bf6147\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/retryUploadsAction.js\":\"5bcd0faeed179bfc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/storagePaths.js\":\"3de4ecb3f439ca87\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadDrain.js\":\"3c2d58c575cf83f5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadLaneStatus.js\":\"860216bd07109b63\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadReconcile.js\":\"58cfd870f3205eda\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadRecovery.js\":\"8968c9edc6095344\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadStore.js\":\"f1e6e17e27712d42\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/useAssetObjectUrl.js\":\"007523ab87de0163\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2cc3320b8aa6fabe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3b5d42cacfb9bfda\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/facet.js\":\"d427e8ad8e924a03\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/index.js\":\"92e3f5c153465b5f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/prop.js\":\"7ea0818552299098\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BacklinkFilters.js\":\"2ab97c3989e2e193\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a8680241aa914d07\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BlockEntry.js\":\"de6b1cfd92facc96\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/LinkedReferences.js\":\"cc2d4fd9438dbc24\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"67024d09f3f019f4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/dailyNoteDefaults.js\":\"0216abbbbbc5e60c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/dataExtension.js\":\"7730c0335c41fae0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/edgeExclusions.js\":\"9800f3bbff84d67e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/filterProperty.js\":\"022b0da9b7b4f072\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/index.js\":\"99d3e3deda22a176\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7b3a7317fd70c17e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/applies.js\":\"2b184e883ca9ea6e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/countQuery.js\":\"9a766f9dcfc85051\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/expansionStore.js\":\"caf89d457985582d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/index.js\":\"b03ce9c58de6a724\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a050cfd2f46a3c41\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/presentationInvalidation.js\":\"418254c6d60e3186\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/propertyEditorOverride.js\":\"13deb3c2b19138cd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/propertyFilter.js\":\"6beda88a6ec7b506\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/query.js\":\"53cec8de83a492a5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/resolveFilter.js\":\"199227a4cd035e37\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/sourceBatch.js\":\"3a9bbc5101982e25\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/sources.js\":\"a1493ef0090ad569\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/useBacklinks.js\":\"8b09d6c518584bff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"43a1066ee4ab707b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/BirthdayCelebration.js\":\"97b3db82e387d0b0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/BirthdayOverlay.js\":\"b4a9f394a29e511f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/gate.js\":\"0f31748c553f3119\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/index.js\":\"d7abb0af0b46c665\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/wolfTheme.js\":\"a17ef5a5fdbfb593\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/BlockDragLayer.js\":\"3e14c6d51ab96603\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/dragController.js\":\"4ef7fcbeb63f1340\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/dropTarget.js\":\"351738b58017cfaa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/index.js\":\"36c05cd668568ad6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/projection.js\":\"51042a233ec8299a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-info/BlockMetaCard.js\":\"f7390634795d5155\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-info/index.js\":\"c21a3682d0b55975\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/AddTagDialog.js\":\"82629919f7dcad72\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c91a476a83fe30a2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/TagNameIssueHint.js\":\"4b654ce592ecd52f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/addTagAction.js\":\"5ad4c2b8f5fdd60a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/appendTag.js\":\"1038a10d5067ba50\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/config.js\":\"4a0360d647953403\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/dataExtension.js\":\"032eff00e372bdd0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/index.js\":\"31edbd2a9f918508\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/propertyEditorOverride.js\":\"ec900cf0744c9ee9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2256a5e631e57428\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"be2f618a7017da3a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d87bda4cdebb6531\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"12ef5c7d7d5ff092\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"15f08e4981aaa5a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/index.js\":\"950f6e00b8bc3846\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"391385925db16a29\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/CharacterCountItem.js\":\"bc6443bb5becb0ef\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/ProfilePropertyEditor.js\":\"eee41f28fae2a16f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/actions.js\":\"fcc9641261eb6634\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/blockType.js\":\"8ecfcbc522c06f6e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/charCount.js\":\"691a59d471258211\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/dataExtension.js\":\"4a3e2a0ec30df378\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/index.js\":\"6722a837e2e2a7c6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/profiles.js\":\"3f49cdf0ce8953c2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/properties.js\":\"958e11653d040a0a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/textCounts.js\":\"6f45c799f96c7f7a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/colemak-keybindings/index.js\":\"8c7bae1066112282\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/CommandPalette.js\":\"9c83becfc6c3271f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/HeaderItem.js\":\"b9de1a9d128e46e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/context.js\":\"897d43bcd399bc6a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/index.js\":\"7dc5c02c3e2afc2d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/selection.js\":\"874eed74c3a275a6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/toggleStore.js\":\"f2cc387da321f32c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/useCommandPaletteActions.js\":\"f81caecfdfdf757f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/ContributorBadges.js\":\"3e1dcb45c594f8a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/author.js\":\"ddb2e5bb5d3b7aea\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/codeMirrorExtensions.js\":\"94e666fc76e64358\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/dataExtension.js\":\"ddefbb110c996e1e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/index.js\":\"002cd8c3dc447b4e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/mentionAutocomplete.js\":\"a81af231240d7702\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/processor.js\":\"62b7d4488cb1820e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/profiles.js\":\"f39f32dd1b5a9651\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/queries.js\":\"769e8603128bf09d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/schema.js\":\"38996cf763f78703\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e116583206d9cb64\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0b67a3b84b9d7a1d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/index.js\":\"982d705be61b86fb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b214c058951a8f42\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5ff8fe42807e3404\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/CalendarGrid.js\":\"a49f9e6799427315\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DailyNotePicker.js\":\"0559406d46ed23b8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"818baba7e1c6f726\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateNavDecorator.js\":\"3fca1bbfd45cb47e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateScrubOverlay.js\":\"fd449c793de7d13a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/HeaderItem.js\":\"6af910575b18e0ec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/ReschedulePicker.js\":\"90639e9b9a33e098\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ecef88b9da6bf3b1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/actions.js\":\"3afa1b600b76bf7e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/blockDateAdapter.js\":\"060006d72d54d10b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/calendar.js\":\"20ab5a4fcca18569\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dailyNotes.js\":\"f9b784ba486abdd8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dataExtension.js\":\"66c6a7678d4d2b12\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubActions.js\":\"ffe84a0aa928daf8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubGesture.js\":\"52e25e13bbcb5eb0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f01a180a22d25c4f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1392f3204a566c15\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/deletionGuard.js\":\"549a87fcacc38909\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dueQuery.js\":\"ba703709aa9f7791\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/index.js\":\"bfa9ed70ed0efc80\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/landing.js\":\"2b2f1aebf4da6fd9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/localSchema.js\":\"93e2ca3088fa95ae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/referenceDateAdapter.js\":\"626c90b35dc4aa69\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/rescheduleAction.js\":\"0747e2dcc094b560\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/schema.js\":\"b60599ed8c6dccf7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/spreadBlockDates.js\":\"4be23ea034cb9e16\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/spreadDatesAction.js\":\"7bded6fbe5a4a29a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/today.js\":\"7a924e55f0214ddf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"04a6a40c675eae04\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3a90ee069531b0c3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/audit.js\":\"43eb1c144f960095\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/auditAction.js\":\"1fde82fc6e359baa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/auditRanges.js\":\"6b6a4280792ed6fe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/diagnosticsSource.js\":\"26048f333fa7b64f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/divergenceScan.js\":\"7efec5c53a42622f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/index.js\":\"b942cb1c0b04d5b5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/propertyChildrenChecks.js\":\"779fc6ef10016a47\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/referencesMirror.js\":\"3df01ec808d8f794\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/rowJson.js\":\"d86eb86ad79e0bab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/schedule.js\":\"f8793d87f0933397\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/store.js\":\"1cbc890c89f89101\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/action.js\":\"0cf4b6df4d9c475d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/index.js\":\"50a1fdeb2347106b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/plugin.js\":\"d2a5d0bf1cb2b90b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"288fabf5ece315ff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/actions.js\":\"1371bdbcfeed5582\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/changeMarker.js\":\"84fe635a06a15d5a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/diagnostics.js\":\"aa3e50dd2a03413b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/fileSystemAccess.js\":\"ab10da378ed5dea7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/filenames.js\":\"b9c5e7a81d58471b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/index.js\":\"9388fa74a5ac4c4b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/mirror.js\":\"ca7d8e8679b2579b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/runLock.js\":\"9051e37028cc6c76\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/runtimeHealth.js\":\"e4a1c1aaca6ff6ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/schedule.js\":\"ba6d8fb48d50e36a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/store.js\":\"11363e72c2174ac0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/default-themes/index.js\":\"24913ccbe4a443e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/default-themes/themes.js\":\"b7471e72ae1c8afc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/diagnostics/facet.js\":\"d468a11bdca4cbd1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/diagnostics/useDiagnostics.js\":\"9e679d332ad92a86\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/dismissals.js\":\"87989c64f873db86\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/index.js\":\"5b6f08654e4c93d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/status.js\":\"e5d75b86a94f74ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/store.js\":\"fc163c71ee7fd7be\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"887a8094ca5c3af5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e4f61a45c7890f46\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/actions.js\":\"22fcc933a134bdcd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/config.js\":\"72b0f184d612d17d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/dataExtension.js\":\"9eae3e76a85d955d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/effect.js\":\"b3273a328a252aae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/index.js\":\"79cce650967fea65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/propertyEditorOverride.js\":\"80cc7a4d36301fec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/useToggleTree.js\":\"3d827986e594f5ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/ExtractTypeDialog.js\":\"10da2c124d9b6fdd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"60a0934e0c6d961e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/PropertyShapePicker.js\":\"53d6addca61c7c95\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/action.js\":\"1478edf24fd893c0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/index.js\":\"def26b02cde95527\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/FindReplaceDialog.js\":\"2a92b8710c6a89ef\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/HeaderItem.js\":\"a32237a2f859c87c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/dataExtension.js\":\"8971b94d094feb36\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/index.js\":\"79fbd59b242fdf90\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/search.js\":\"3b76aa1ee4aefb40\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/toggleStore.js\":\"1b210228cad83f59\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/LocationPropertyEditor.js\":\"959f369627c58b06\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/MapView.js\":\"1d7473db818c4c31\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/blockTypes.js\":\"0adac8661b90f0f3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/codeMirrorExtensions.js\":\"f9e0d57137ccd129\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/createOrFindPlace.js\":\"5319a7350843bebf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/currentLocation.js\":\"3fd97293ae050860\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/dataExtension.js\":\"e0a1d7c80885bb36\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/geoContentDecorator.js\":\"13ed8fb5989bbab5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/googlePlacesClient.js\":\"6f6227c0f0356a2a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/index.js\":\"36440774c3c742b9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/locationsPage.js\":\"20f3bd2dc6759120\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/mapViewport.js\":\"81d17db31dfda7b3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/pickCurrentLocation.js\":\"aa695209516eab68\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/placeAutocomplete.js\":\"ec63bfaa7502a092\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/placeNameCollision.js\":\"78e6e4278fd7ab29\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/properties.js\":\"2dc063ed4448e7e5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/propertyEditorOverrides.js\":\"8fd2ac08181236ae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/query.js\":\"354852dab59be5a2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/usePlaceSearch.js\":\"998a8ccb13b3ff94\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"da692378f5f36080\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7decec831c16169e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8ed058480e8e1be8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/config.js\":\"e5aae9eba2f964d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/dataExtension.js\":\"25fa646e66650ff2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/facet.js\":\"6454b580df5f0151\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/grouping.js\":\"3d9bedcf159eaf82\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/index.js\":\"5d26b34bcc23d547\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ddb687f6760fc819\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/query.js\":\"1fb2ecae74e65e38\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/resolveConfig.js\":\"2ea2fe8181bdec8e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"54917080ca5397f6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"877f2e84a976f07a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/HtmlDocumentContent.js\":\"efe6e4f02f9da65f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/HtmlFrame.js\":\"7fe3b3381f4dfc29\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/actions.js\":\"5975be3ab38a7ae8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/blockType.js\":\"4c7ddad6bd43f89e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/confirmRunScripts.js\":\"82669a6f0b8bca24\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/dataExtension.js\":\"bcd5b9f5d551e23a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameAnnotations.js\":\"088edb10f14eecfa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameDocument.js\":\"b7bf144f6fd1bb28\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameTheme.js\":\"1a728f012dba43bd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/index.js\":\"b2a6f70002887377\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/scriptConsent.js\":\"be7eac4a25e5c5b5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/sourceMap.js\":\"bc76219233bf8878\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/useDocumentScripts.js\":\"dfe39407b8c6074b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/index.js\":\"8bc2abdb20098bb2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/record.js\":\"54cd514243240f3f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/recordStore.js\":\"a5cd66c895373b40\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/responsiveness.js\":\"67a94b2e9203a70c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/schedule.js\":\"63b6f2d86a2f36a5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/sessionContext.js\":\"43ece53842f48f58\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"61450ee0861dc98c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"54ec7bde556b69d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/actions.js\":\"ae5fc52a6402ad90\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/config.js\":\"9a3b53ca953783c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/dataExtension.js\":\"838a4de5438fba14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/effect.js\":\"d27016f31f75dd62\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/index.js\":\"f985a8435a535a27\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/keyCapture.js\":\"e698de6cc5a56eee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/overrideStore.js\":\"7d913db48ef6cc84\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e0c101f026b8ffd3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/HeaderItem.js\":\"02f5ce4b1391a780\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/LeftSidebar.js\":\"374392c2ba081957\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/actions.js\":\"d3aefc05d0ebf2c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/facet.js\":\"791a00ec065a7259\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/index.js\":\"5d168ee2f1bee411\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/shortcuts.js\":\"f5c89e1f3c0c3b4a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/toggleStore.js\":\"1671128a39095458\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/MergePicker.js\":\"3ac7674a11a1c76f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/index.js\":\"a5465c8458a94b0b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/mergeAction.js\":\"c8c46063bbea9074\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/strategy.js\":\"b7939b22f278a4a6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/Button.js\":\"5759662eec33493c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f5c0ccdb5cbf5554\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/defaultItems.js\":\"377c53060d20d992\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/facet.js\":\"aaf87c5a01582c73\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/index.js\":\"4fe5b15f96ad24d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"706c7d03d77fd88f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/actions.js\":\"356fe63801a7b266\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9ff4511efba74bac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ca2ffc13e48b2d45\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/index.js\":\"9dddc18a27dce7cb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/MoveDestinationPicker.js\":\"19cd563498cf4d33\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ae1c8838fd3c15fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/contextMenuItem.js\":\"d62e350324c47a0d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/index.js\":\"ffe8e1003c617cf5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/moveAction.js\":\"0144bfe4abecc50e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/moveBlocks.js\":\"c340f9642ed2df24\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/selectionAfterMove.js\":\"6205298f4ea12b8c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/TutorialBanner.js\":\"1abb9c19cc9e5308\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/action.js\":\"72561cd929a70006\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/bannerDismissal.js\":\"3a84aa05aa8895c3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/documents/cheatSheet.js\":\"d3beb73bd161f415\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/index.js\":\"f3d936cdbad03ddc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/keys.js\":\"957c552c2374fb28\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/landing.js\":\"7b1ac9450eef39c2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/outline.js\":\"8814476a903c281f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/seed.js\":\"283639e63b7426d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8aa3ddf0be9a880f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/analyze.js\":\"4afa4d64ddb6749e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/diagnosticsSource.js\":\"72a374019abecca9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/index.js\":\"9e4764fad479e460\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/load.js\":\"8f27630c84664a5e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/monitorRun.js\":\"ef0f7b4b7463ab3d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/schedule.js\":\"c5c17b9ce8082615\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/series.js\":\"d381e49ae3d816f0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/store.js\":\"05cd7b56ea591a68\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/trendAction.js\":\"d7f3a87682e82f9e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/verdict.js\":\"ad2e409e69368fb5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/clickToEditAction.js\":\"a16d41aad4dd13c9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/index.js\":\"bbb0292ecd5398b0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/interactions.js\":\"be27c11fc1570508\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1b5d2004271647d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/MigrationGate.js\":\"3c82756a3fb70061\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/MigrationGateDialog.js\":\"fc9e5784ddd19469\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/action.js\":\"637fb31fedbe6de2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/index.js\":\"c78cb56d85d92f57\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/localRunMessage.js\":\"d56eb9c770868157\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/plugin.js\":\"64c4b0f1cc9962ab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/progressReport.js\":\"870124f1ee3c1321\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/sweepProgress.js\":\"0e08b655efd84294\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/FieldRowRenderer.js\":\"6b5d4200d7618383\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/ValueRowRenderer.js\":\"ba30cd8a5819f333\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/actions.js\":\"f2085203f9ee40a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/autocomplete.js\":\"0d45cc9a963571ac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/fieldRow.js\":\"dfea4db5cb23d39d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/index.js\":\"d599e768b995d030\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/referenceWarning.js\":\"9b61c2d6d23efa77\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/valueAutocomplete.js\":\"593a03f3481e2d2c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/valueSchema.js\":\"d211daad7a3738b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/HeaderItem.js\":\"e542579306c06c45\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/QuickFind.js\":\"f4392337e64fabf7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/index.js\":\"4d6c366ccc863439\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/recents.js\":\"7e0a1c5142da5ba8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/resultItems.js\":\"260f00c7750ec57d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/selection.js\":\"d4028a62ac184b0e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/toggleStore.js\":\"70d240be25420c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/HeaderItem.js\":\"c39e335c0400b88c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f0ab572c686bfb77\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/grouping.js\":\"49aef8deec093a7a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/index.js\":\"78392ba510432677\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/target.js\":\"6e4e073ac004bd23\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/codeMirrorExtensions.js\":\"34c5c7ec62bcde91\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/contentPrefill.js\":\"96b8924a4f42dc54\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/dataExtension.js\":\"14ea2d82a351622d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/index.js\":\"0ee25e703d9e45e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7ddc461bf6a4bc6a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/invalidation.js\":\"e15d02025eb41336\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/localSchema.js\":\"1643a888e6e2ebbd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/blockrefs/index.js\":\"f337ac258eb9059c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"804d267ec8337d1a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/index.js\":\"86abb40d2493132d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/referenceNode.js\":\"95561aeaa040b1c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1b439f0e36a3d8a2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7afbd964b49ccb2f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/index.js\":\"c21163333f085219\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cbcfa1d595354c88\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f7632b5446ad1dad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/mergeRetargetProcessor.js\":\"e534be44e16a8baf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/parseFence.js\":\"1a99df2a270f6abb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referenceParser.js\":\"13ebcd18d9d3bdf4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referenceProjection.js\":\"02e1d55d0c9a6553\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referencesProcessor.js\":\"aa81b392d8267e95\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/renameProcessor.js\":\"79a5c904b8712d13\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/spanReplacement.js\":\"324cd08325155ccf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/htmlToOutline.js\":\"0bb5e0ec7698f9bd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/index.js\":\"e0599bccbd84e5d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5ca9d4273a385611\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/pasteDecision.js\":\"6093292d6f7ad1aa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/action.js\":\"42011d4f91a46bdb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/blockIds.js\":\"bd10d596a801784c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/content.js\":\"673021c3c3f66bec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/effect.js\":\"2ff0c2e834aaccc2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/ids.js\":\"65e86f005506b053\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/import.js\":\"3547f5f732139ffb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/index.js\":\"e2606d7ee3d2dace\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/plan.js\":\"bbfe2dc679464fb6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/plugin.js\":\"fa69bc669c7638b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/promotion.js\":\"4ea1c090762ae346\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/properties.js\":\"a20a538454abc4ab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/references.js\":\"4d2bd3f2f9780512\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/report.js\":\"8f7e29600497736c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/roamMemo.js\":\"823335d0fccc087f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/runtime.js\":\"bf4098d1a4765141\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/schemaReconciliation.js\":\"daa373655bcde238\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/srsMarkers.js\":\"e91f5465f30e5e42\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/todo.js\":\"f9349e9fa45388ea\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/typeCandidates.js\":\"7b87ec9b77afa549\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/types.js\":\"3a8b8a81e0f489e7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/search-health/index.js\":\"6d1bf7ace08ee698\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/search-health/store.js\":\"f70217b7803f04f7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/HeaderItem.js\":\"e27d360f67c0c9fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5f3894d5e93b04d9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/index.js\":\"04011cf63d6f63e6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/model.js\":\"58f2fb89760cfe97\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/toggleStore.js\":\"c52dd10b02484297\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/useKeyInspector.js\":\"7591cb747deaaab5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0f3e535682577c5b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/ShellDecorator.js\":\"1b57b9b7ea43818b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/actions.js\":\"21c228df4f88993e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8d876fa3b8ea178b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/index.js\":\"c6668d5f373b7895\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/shell.js\":\"d86b32508bb53fa5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/surface.js\":\"665703cd1180b731\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/walker.js\":\"0b1226842e78047f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e698ac7a0b90a42d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/dataExtension.js\":\"8c38a4789ce754ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/index.js\":\"0b11d154fa63ad58\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/indicator.js\":\"2af41432cf4093e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/moveSrsState.js\":\"7c62873642ec2ce0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0a5b0dc505656f5c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/scheduler.js\":\"a728328c39319208\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/schema.js\":\"1211e605b88faf8a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"495167eccd21d7b8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/srsClipboard.js\":\"a08235ef2c56d0ff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c1582070ea4ec28c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d12ad1965ed755a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/DeckPicker.js\":\"ea8863aba53365a1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewControls.js\":\"9ff1390f5ee97103\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e830ab371f33cf79\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewSession.js\":\"ea140b5598028a93\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/actions.js\":\"fca111fccf41a680\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/archive.js\":\"93e67151b1aa9427\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/dataExtension.js\":\"2b5012cb30e17f58\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/deck.js\":\"25b4852289e364d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/dueQuery.js\":\"51f8e72e379acdae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/gradeDecision.js\":\"b2083b9e11774694\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/index.js\":\"45af2dc59c6c0261\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/keyHints.js\":\"947c0dbba5403bcd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/reviewCardLayout.js\":\"165ed4fa01a0e955\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/reviewProgress.js\":\"3d28c9d51f8bfd53\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/schema.js\":\"f16f988162830c55\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/useDueCards.js\":\"84ffefac6265f5d3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/startup-metrics/index.js\":\"49f3e404eee8b77f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/startup-metrics/record.js\":\"d6060d6be325127b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/index.js\":\"92d4b7dcb84132e9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/persistenceStatus.js\":\"9ad5927514c53fd2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/requestAction.js\":\"2f82c0dabf676a35\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/TypeChipsDecorator.js\":\"1f41464181ca221a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/codeMirrorExtensions.js\":\"6bfdb5d1aed0739d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/index.js\":\"52c5cf8c715576d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/typeAutocomplete.js\":\"ba4e9144d4c73242\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e67fbda7661478ec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/actions.js\":\"354242b9006508e9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/anchor.js\":\"5bc7b8a7a7404d79\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/events.js\":\"a424776bc5883fdd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/gestureActions.js\":\"a46761a51c311793\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/index.js\":\"47e385b5ec2a0139\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"ffdd9483903124e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/collect.js\":\"c99ca16974e59577\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/index.js\":\"8ee19c93712da61d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/record.js\":\"dab204f86abb9a87\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/RejectionDialog.js\":\"5a99e3d613ccae99\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/SystemStatusHeaderItem.js\":\"abaefba906d4413e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/index.js\":\"b2194c7bb54bd1ae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/model.js\":\"11803340f1cbd737\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/queueCounts.js\":\"ca96f709a7062337\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/rejectedHelpers.js\":\"edd5d8f11664569a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/rematerializeAction.js\":\"7e6cefecbe9c1187\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/useHysteresis.js\":\"9e930ca5e06454d6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/ColumnHeaders.js\":\"b39625f01fcd6565\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/QueryUi.js\":\"14284ecbe4cca15c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/TableLayout.js\":\"4be912994300d075\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/actions.js\":\"72236a78a0328487\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/cellEdits.js\":\"9212f83bd88d280c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/childrenViews.js\":\"d6fa27ca08fbd782\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/columns.js\":\"a042215877ab870b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/controller.js\":\"4925368dcfc83147\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/convert.js\":\"72fa79497c8a99b3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/dataExtension.js\":\"da9d65db4eb96aea\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/index.js\":\"7643eb318804d035\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/keys.js\":\"547259dce9f28306\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/model.js\":\"e499403611bec8c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/navigation.js\":\"ef0a412187dd8380\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/backfill.js\":\"dca5f0cab49b8906\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/completion.js\":\"ca2dbcaca1b15e24\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/format.js\":\"841b06dc7741dcbf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/parse.js\":\"941759c0847ab84b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/queryValue.js\":\"43bc12f6a3deffb3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/source.js\":\"fd9dc624dee9a1d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/registry.js\":\"a43730f4232b511c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/rowGutter.js\":\"7dcf1ca8cdf10ace\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/rowVerbs.js\":\"97a6b4c28475f282\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/schema.js\":\"a751274c3dfc179a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/sort.js\":\"2af3703b39495023\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/effect.js\":\"3456bbdc91c51c7e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/index.js\":\"259d526fd58b9e81\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/theme.js\":\"118a739c6f57b485\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/actions.js\":\"801c24f722194104\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/dataExtension.js\":\"1d434e6e4f929ecf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/index.js\":\"63b0110543d26a83\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/schema.js\":\"3cc88398b7030832\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8f554e170f7500a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/actions.js\":\"eaba5d2e9afe67a5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/defaultItems.js\":\"98c6871af7e5c52e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/facet.js\":\"8f4e5b2871dea564\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/holdRecognizer.js\":\"6b37662b586c20e9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/index.js\":\"137321d5e53076ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/UpdateIndicator.js\":\"c02692bc32b2dedb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/index.js\":\"c7474908bf24b532\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/loadTimes.js\":\"57720a3aa4e188c7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoNotesRenderer.js\":\"14e6fb181baa864d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoPlayerRenderer.js\":\"2e8014feaf179811\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoTimeStamp.js\":\"44eb6dec0a83ad15\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/actions.js\":\"7d23227f9e969e34\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/index.js\":\"4c8831c3c48e7fa7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/markdown.js\":\"3921199c6f61c1d3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/notes.js\":\"b7b5dba1e274af4d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/registry.js\":\"8ab736f43f3ffab3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/remark-timestamps.js\":\"a919dcc5f3c67a09\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/view.js\":\"2f52a04fffe8781a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/LinkHints.js\":\"5c0c5fcd2bba0f32\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/index.js\":\"be27d75ead448e71\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/model.js\":\"ceee19a8fc03c091\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/settings.js\":\"68332726b51847f9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/actions.js\":\"6b6cd5c43d000018\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/index.js\":\"df9cbc5b241cc30c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/interactions.js\":\"b7c6adfb4dea7fff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/workspace-header/index.js\":\"46dcbb9b9f2cf2aa\",\"/knowledge-medium/pr-preview/pr-1859/src/registerServiceWorker.js\":\"b88cb432ef6a7d24\",\"/knowledge-medium/pr-preview/pr-1859/src/requestPersistentStorage.js\":\"c9002ecfb7d2b4fa\",\"/knowledge-medium/pr-preview/pr-1859/src/services/authRequestDeadline.js\":\"ad87c666bb035ca8\",\"/knowledge-medium/pr-preview/pr-1859/src/services/authStorage.js\":\"aca029df96ea1a1b\",\"/knowledge-medium/pr-preview/pr-1859/src/services/powersync.js\":\"b4883b856614fc06\",\"/knowledge-medium/pr-preview/pr-1859/src/services/supabase.js\":\"89567380dbe4f6c5\",\"/knowledge-medium/pr-preview/pr-1859/src/services/uploadErrorClassifier.js\":\"b8468678d5532f0c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/ActiveContexts.js\":\"9327a7b493a5d6e1\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/HotkeyReconciler.js\":\"5162c606eeb8d23f\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/WipeLocalDataDialog.js\":\"7df4d4116fb4b3a9\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/actionDispatch.js\":\"657ef6b2732cadc8\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/actionRefItems.js\":\"c7065b89b6c622f1\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/applyKeybindingOverrides.js\":\"16bab5945bdb2838\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/blockActions.js\":\"39b64d9a6039372b\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/blockMergeGesture.js\":\"34a7a3ac91222f95\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/canonicalizeChord.js\":\"46d2d80a8de70434\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/defaultContexts.js\":\"71e5f58ed0f024c7\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/defaultShortcuts.js\":\"54f067f6019b57e3\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/effectiveActions.js\":\"b0dde7848b9fe423\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/gestureAction.js\":\"6549a080ec225f86\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/gestureBinding.js\":\"fcfa4e9003312039\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/holdRegistry.js\":\"337dedfc523ae611\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/keybindingConflicts.js\":\"908b924d83d75300\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/keybindingOverrides.js\":\"285f0be4fd91cb15\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/pointerAction.js\":\"fcaf132a141e6e63\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/resolve.js\":\"e2acc74da7a0e26b\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/runAction.js\":\"eba6f207d03c7c26\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/sequenceMatcher.js\":\"db098400e39403f5\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/types.js\":\"9bfd763bd4eb6c34\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/useActionContext.js\":\"ff016369db7fa49c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/useActionDiscovery.js\":\"91e926a38c1ae4b1\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/utils.js\":\"8fd2de338ed4a447\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/bootStore.js\":\"0b034f718d839679\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/previewDatabases.js\":\"2ea4a9aea06371b4\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/byteTransform.js\":\"36aacaf92da840b2\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/attachmentCleaner.js\":\"65ad663c429c3f57\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/attachmentParts.js\":\"70cd63e30e3058c8\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/bundleParts.js\":\"c75f381aed4344ef\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/bundleRecord.js\":\"80faefd9b81166a7\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/manifest.js\":\"b85e0aba77c0d469\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/takeBundle.js\":\"9c39a812a572ed31\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/verifyBundle.js\":\"c5082b9c66fa31e9\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/cleaningStage.js\":\"f46b89d21b04723c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionKey.js\":\"2de1731f43dc0b05\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionServer.js\":\"7222de58ddf56050\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/flip.js\":\"fc7a17ede366814d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/flipAttempts.js\":\"7bede90410b05c7a\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/pages.js\":\"393bef890b98ade0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/preflight.js\":\"5bd1260fdbe6b2b2\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/reseal.js\":\"9b07562e844ff240\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/runConversion.js\":\"ea295b8fe825e2d8\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/runLock.js\":\"0999dfbbffb80be5\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/sealing.js\":\"9eb47b088f85b1d0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/sealingStage.js\":\"b215d7beeecc20ae\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/stage.js\":\"b36cc5baea36ae20\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/verifyReseal.js\":\"b5442de0695ccd7b\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/aad.js\":\"6eb9f8efcba2dff2\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/aead.js\":\"4eac5fe0eea86053\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/base32.js\":\"355b6e05c0e9b646\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/base64url.js\":\"10052de174d7135d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/binaryEnvelope.js\":\"f850f68c58043db9\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/byteAead.js\":\"8484d9c7914d9159\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/canary.js\":\"7f8977fb7f369e02\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/contentHash.js\":\"1f8666a1fa91b71f\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/contentKey.js\":\"be7fde1d4915f74b\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/derivedIdNamespace.js\":\"ba93b841c8829909\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/envelope.js\":\"e2e3ad64e404d89d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/hex.js\":\"017f282754155a23\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/sha256Hex.js\":\"87f420a7a38b22ed\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/workspaceKey.js\":\"0f2124d02128c6f8\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/conversionState.js\":\"429bc6d7b262a5ec\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/createEncryptedWorkspace.js\":\"74c9887f286bb23e\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/pastedKey.js\":\"8be8d1fb1dd87705\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"62e37f10bd1fb94d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a517ef1894689010\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/keyStore.js\":\"f56f6489925b7665\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/mintWorkspaceKey.js\":\"c64f090ee0d88977\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/modePin.js\":\"cebf35f1ec76c92d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/openWorkspaceKeys.js\":\"d821922d37e9c4dc\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/resolveWorkspaceEntry.js\":\"72eb1c9020cee1e5\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/resolver.js\":\"b407f16928966e11\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/workspaceAccess.js\":\"902d6b52f24ce6a0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/transform.js\":\"a33f4be9e7edf686\",\"/knowledge-medium/pr-preview/pr-1859/src/themeBootDefaults.js\":\"a61f8db5baa22efe\",\"/knowledge-medium/pr-preview/pr-1859/src/types.js\":\"f8172c6a8d0bb2fa\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/ClientLocalSettings.js\":\"3d4d2bc65d57987c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/abortableSleep.js\":\"0f080accdbc3868c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/array.js\":\"bdeff8bdcc5ff1e5\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/backlinkAutocomplete.js\":\"4dd15e25ca2ec30a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/blockCrumbs.js\":\"a8491d664f83dfeb\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/blockrefAutocomplete.js\":\"0f26a4032692cca9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/cadencedIdleJob.js\":\"a0d4642e06a270d9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/callbackSet.js\":\"ce27cc32d02fcfc4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/clientId.js\":\"8b7ea1631150e6f1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/codemirror.js\":\"2c5b4f4b24716dc7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/codemirrorCompletion.js\":\"6df19b976b923c05\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/copy.js\":\"fd27816fe3bc2061\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dailyPage.js\":\"eb0848fb63fea623\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dbForensics.js\":\"e1ddefbf16d1b004\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dbForensicsHooks.js\":\"9e12f277289567f3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/deleteBlockThroughUi.js\":\"6d7128272043e151\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dialogs.js\":\"12704c8da52237de\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dom.js\":\"847343747855e0ec\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/downloadBlob.js\":\"ce2e40ba7da2b03d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/exportSqliteDb.js\":\"def1ceb084370dd3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fileSystemAccess.js\":\"89edf17e5b738050\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/flipSlide.js\":\"26565e213b62110e\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fnv1a.js\":\"2ada6ea62abfc47d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/formatBytes.js\":\"1da7a639f1fdea5b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fuzzyRank.js\":\"9b219c68de87f3ae\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/idbKeyedStore.js\":\"2414622e75fe8937\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/idleCallbackPolyfill.js\":\"7d8150f016a61d14\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/keyboardAwareScroll.js\":\"6cd2b38b4013c386\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/keyboardViewport.js\":\"e055536c0bfa8fe0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/lastWorkspace.js\":\"f32f8fb3a185cf76\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutColumns.js\":\"4fcc19fb534bd7e4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutSessionDom.js\":\"0f0e2a88ea25ca65\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutSessionId.js\":\"e982b907a11b2cb1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/linkClickGestures.js\":\"ed29fa069e25e81b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/linkTargetAutocomplete.js\":\"f9cf17a7bd4e2711\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/localDbCorruption.js\":\"a8adc9e9cbf85f0a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/localDbRecovery.js\":\"4dc6fd71b88afd1c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/markdownParser.js\":\"4b4ed18fe0d980c1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/memoize.js\":\"5f16db0e93b4e5a7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/nameFieldCommit.js\":\"2cefcb65475bc4bd\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/nameList.js\":\"b54e55a2548490ea\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/navigation.js\":\"f45209c22117d27c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/omnilinerNamespace.js\":\"be7119cf61b9f800\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/opfsPageScan.js\":\"55847ba3994c23f5\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelClearance.js\":\"c4a1b8ba766fcf61\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelHistory.js\":\"90ceea60309012c3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelLanes.js\":\"0553993c5b7b5a78\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelLayoutProjection.js\":\"c2b80f91943742df\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelScrollAnchor.js\":\"04c414953a3ce104\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelUrlFlags.js\":\"3c7f5a08d6b4e1eb\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/platform.js\":\"f0fbac03a0b1accc\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/pluralize.js\":\"75b73c798a7c1232\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyCreation.js\":\"b00539c5799715d4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyNavigation.js\":\"6c0925d594809d58\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyValueContext.js\":\"8eec0b49759024a7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/react.js\":\"45bac279b9560e6f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/relativeDate.js\":\"3b56b0b9ce498660\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/relativeTime.js\":\"60b430d0940ad4dd\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/renderScope.js\":\"fd078b2e6c4da614\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/resolvedThenable.js\":\"a8885feb81108f21\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/routing.js\":\"0f76743c9b97ad3d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/safeMode.js\":\"e4bc12824853206b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/scheduleIdle.js\":\"871b5ec07b9d2453\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/screenWakeLock.js\":\"d6d30bb47b054bb1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/selection.js\":\"57f4eaf760c89316\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/softKeyboardGrab.js\":\"5fc9e2bb758c45ff\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/startupTimeline.js\":\"3d8f1d4f022f2346\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/state.js\":\"ab79fc08b41a97b9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/string.js\":\"1fb4a49ca6d69c62\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/surfaceZoom.js\":\"6d1f8eaf44e82fd3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/time.js\":\"d5e77c997d73ff2c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/toast.js\":\"cfea2bbe8f4626b7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/toggleStore.js\":\"1b334b0c5e503c1f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/untilStopped.js\":\"1be584f2b461e6ab\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/userActivity.js\":\"378fd6cb0d90669f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/viewTransition.js\":\"f97bed01674eadea\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/viewport.js\":\"7220b2a0ecfd4908\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/webLock.js\":\"af673e0a7e0498b9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/workspaceRecovery.js\":\"a05820ac42e3430a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/workspaceSnapshotStore.js\":\"492e574eb9b6b803\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-compiler-runtime.js\":\"a9ee1d2d2b382c21\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-client.js\":\"441210456cf6d1e8\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-server-edge.js\":\"a955fea2fb95f680\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-server.js\":\"f7f6fcfb0437e329\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-static-edge.js\":\"1d8f176c8ed6ef2f\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-static.js\":\"af827d7ef6be528c\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-test-utils.js\":\"1f8602d7c03d6c3f\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom.js\":\"f8f0dfd89d415b91\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-jsx-runtime.js\":\"5442507f7c306127\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react.js\":\"38c1284d293418fe\",\"/knowledge-medium/pr-preview/pr-1859/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1859/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1859/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
