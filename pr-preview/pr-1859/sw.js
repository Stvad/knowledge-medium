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
		buildId: "38c4f527a3cc-d515c51c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/\":\"65e8c99915ed462a\",\"/knowledge-medium/pr-preview/pr-1859/index.html\":\"65e8c99915ed462a\",\"/knowledge-medium/pr-preview/pr-1859/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1859/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1859/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1859/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1859/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1859/assets/FacadeVFS-n1B3oGgz.js\":\"2e39e506909a8448\",\"/knowledge-medium/pr-preview/pr-1859/assets/OPFSCoopSyncVFS-DCcQkQJ1.js\":\"5b1b7c3d28f1940f\",\"/knowledge-medium/pr-preview/pr-1859/assets/OPFSWriteAheadVFS-BkD6pB7D.js\":\"692b958b7d9302a3\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-BJcEG88H.js\":\"7aa867852361794a\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-async-BMri4MLr.js\":\"3491023f3edf3e73\",\"/knowledge-medium/pr-preview/pr-1859/assets/worker-D145vx3w.js\":\"7451a0b6e05107c2\",\"/knowledge-medium/pr-preview/pr-1859/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1859/chunks/app-MQ8mmZ_s.js\":\"cb829601db01c611\",\"/knowledge-medium/pr-preview/pr-1859/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1859/index.js\":\"6ec57a0470ce0de7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1859/assets/AccessHandlePoolVFS-U7HNKv2V.js\":\"867463aa74213191\",\"/knowledge-medium/pr-preview/pr-1859/assets/IDBBatchAtomicVFS-Di6tdqmw.js\":\"167bbfd0bfc7b9ef\",\"/knowledge-medium/pr-preview/pr-1859/assets/MemoryVFS-DxGdy99J.js\":\"98220eb0fa19c0f0\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-D6-ARCJ9.js\":\"34103ca0a2db378f\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-async-CcP1ICa_.js\":\"1d14e802f75965be\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1859/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1859/chunks/AccessHandlePoolVFS-BS-UaHrg.js\":\"e2c7cda70abe922a\",\"/knowledge-medium/pr-preview/pr-1859/chunks/FacadeVFS-DyZ26kJK.js\":\"3637b0ef1e3275fb\",\"/knowledge-medium/pr-preview/pr-1859/chunks/IDBBatchAtomicVFS-cfYGRXon.js\":\"6afe08ba39a207ea\",\"/knowledge-medium/pr-preview/pr-1859/chunks/MemoryVFS-CCyxSILy.js\":\"079eb2c0e6f0bd48\",\"/knowledge-medium/pr-preview/pr-1859/chunks/OPFSCoopSyncVFS-DLqFEr0l.js\":\"cd77c370bf3b3c82\",\"/knowledge-medium/pr-preview/pr-1859/chunks/OPFSWriteAheadVFS-CP4iWoSw.js\":\"93fd3063cb69090b\",\"/knowledge-medium/pr-preview/pr-1859/chunks/Preview-tOTPYPMq.js\":\"071ca215b19b0f63\",\"/knowledge-medium/pr-preview/pr-1859/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1859/chunks/card-Dew0iRsG.js\":\"83835fa9c7e8072b\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-BQTgLITi.js\":\"ef890a2b9bcc7964\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1859/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1859/chunks/mc-wa-sqlite-BKJjP9u7.js\":\"9700f18313a4e9b3\",\"/knowledge-medium/pr-preview/pr-1859/chunks/mc-wa-sqlite-async-CQUIW157.js\":\"c26fa817cb604624\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-6JHLnO7I.js\":\"0cb59698df4f2b48\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-BG-7sBXF.js\":\"e5b27319ec2e7ca2\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-Bf7QdEEK.js\":\"e2bdc5a3741ac2ec\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-CRHzXEDE.js\":\"d74694ae89feee96\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-CjySTayo.js\":\"c95fd568592472a9\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-DDUxhbwG.js\":\"5b54fe1a5eeaa781\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-DdsLLIb1.js\":\"d72d7155cd693708\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-DoKs11tC.js\":\"557a2ed2d93d3c08\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server-legacy.browser.production-nAqS9ujN.js\":\"573806eae96615f0\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server.browser.production-DTWMpD9V.js\":\"138984c0be19543e\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server.edge.production-B2DwUQAj.js\":\"2952c7fd843c6841\",\"/knowledge-medium/pr-preview/pr-1859/chunks/server.browser-K3FkVXzF.js\":\"ca8d6c2d8918459d\",\"/knowledge-medium/pr-preview/pr-1859/chunks/textarea-D3fure-I.js\":\"70d040364d2d3d19\",\"/knowledge-medium/pr-preview/pr-1859/chunks/ui-DLGILRPS.js\":\"2ae839c3658ddc45\",\"/knowledge-medium/pr-preview/pr-1859/chunks/wa-sqlite-DnvorOw_.js\":\"41222972b3c2c95a\",\"/knowledge-medium/pr-preview/pr-1859/chunks/wa-sqlite-async-Df3v7wD1.js\":\"39bacb6ec45296eb\",\"/knowledge-medium/pr-preview/pr-1859/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1859/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1859/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1859/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1859/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1859/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1859/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1859/src/App.js\":\"2354d7415f36f38f\",\"/knowledge-medium/pr-preview/pr-1859/src/appUpdate.js\":\"4ad76fd4ce490b9f\",\"/knowledge-medium/pr-preview/pr-1859/src/appVersion.js\":\"3c1904f0f1168912\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/initialLayout.js\":\"d1d399e4cb4544dc\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/openWorkspaceData.js\":\"90113824dd1a016f\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/resolveWorkspace.js\":\"c3205e654d8fc4e5\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/workspaceBootstrap.js\":\"72ccf32910487d31\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockComponent.js\":\"ac5004e0d7b79c1c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockCrumbs.js\":\"72fe90aa8b52dfd6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockEditor.js\":\"23260b5429abafdc\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockLoadingPlaceholder.js\":\"e44d4277a684717a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockProperties.js\":\"f373aa2e3cdf7c34\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockSearchPicker.js\":\"7cfcd8cb07595bee\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ConfirmBulkDeleteDialog.js\":\"07aa6c9f7f092f91\",\"/knowledge-medium/pr-preview/pr-1859/src/components/DividerHandle.js\":\"ba8d860983ee1e06\",\"/knowledge-medium/pr-preview/pr-1859/src/components/DraftEditor.js\":\"68606381aec5583d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/GutterPill.js\":\"16d0e9a23bf95c0a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/Header.js\":\"6e25464bb76106f1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/LazyBlockComponent.js\":\"8874365bcd1bd4f6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/Login.js\":\"c5fa600468a11bc9\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ZoomableSurface.js\":\"584d9f275749010c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/editModeKeepalive.js\":\"59c48801e10f1871\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6d4528e7529a1072\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3f6d254cf961f4d1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/RefPropertyEditor.js\":\"6f633128a1ec4d06\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/RefTargetTypePicker.js\":\"ab6dde2b3c7e425f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/SelectPropertyEditor.js\":\"42362ce21717dfc7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/TypesPropertyEditor.js\":\"644aeaadf94d1ea9\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/defaults.js\":\"b36bcbac3dc85857\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/kernelValuePresets.js\":\"c3fad42109fdaf27\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/selectablePresets.js\":\"164237f398cc06fa\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/typesPropertyUi.js\":\"c8b87c7f0219c7e3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/AddPropertyForm.js\":\"74692d0227960485\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/PropertyPicker.js\":\"5b32dbae2cfa4f78\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/PropertyRow.js\":\"24f99afbc86c3a8d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/Rows.js\":\"34cf07094e96d18d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/actions.js\":\"3a1f9603d0d1e8f2\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/declarationOnly.js\":\"c419dde2303d8c05\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/layout.js\":\"e1a44bfc36429738\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/model.js\":\"43ea70957dbcd84e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/shapeUi.js\":\"ee2dd81ae7d78edb\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/shapes.js\":\"a499ab2b49beebfb\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d2dab44790927000\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/visibility.js\":\"a6708f16d15256a3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanelSections.js\":\"9e53f44738569ef0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockEmbed.js\":\"dbbe29f6e1a116d5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockLink.js\":\"c4dcb63fb32e8e65\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockRef.js\":\"9065101a5f178141\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/ReferenceLink.js\":\"1bec4cc00c5f7fb7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/cycleGuard.js\":\"9f41c27c4e185ed1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/cycleGuardContext.js\":\"abb5b3e3ce059934\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/linkInteraction.js\":\"9d646bee177f02c8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/referenceLayout.js\":\"7f3bf6b8de2cc02b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/useBlockRefAncestors.js\":\"5c622470f0b11f15\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockGutter.js\":\"eb1a58f73b31420f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockInfoDialog.js\":\"1ef6015a5bb18c74\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockTypeBlockRenderer.js\":\"45bc00660bfa520b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BulletHoverCard.js\":\"0f5ddedc1f22adea\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/CodeMirrorContentRenderer.js\":\"9e7d8bd3a578f3ee\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"360caf963b5741ff\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/ColumnResizeHandles.js\":\"be0fc58384bc572e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d9e5f1dc3b4e2366\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/DefaultBlockRenderer.js\":\"0cab6bc56a6c0888\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/LayoutRenderer.js\":\"b5cb500dfabe947d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/MarkdownContentRenderer.js\":\"7431bad2fd01e851\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/MissingDataRenderer.js\":\"6e470ca95ba30f4c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/PanelRenderer.js\":\"e480387f600c2d22\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0f60d858d512fe12\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/TopLevelRenderer.js\":\"80385a637012ba2e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/blockGutterMode.js\":\"9b38cf572ba967bb\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/blockTitleText.js\":\"577fc30d8ac784d3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/fieldCreationKeydown.js\":\"6ddf817c133dd432\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/layoutRootContext.js\":\"af36751044f2a93b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/typeChip/TypeChip.js\":\"6ca3c9eb6baeb15a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/typeChip/chipStyle.js\":\"2b3a0056b2b54a40\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/anchored-floating.js\":\"1d7d9e9d8e47f8e8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/button.js\":\"2eca8c93d8655a98\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/card.js\":\"33b22b0ac5da4d81\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/checkbox.js\":\"b52dff8832fed6e3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/collapsible.js\":\"aa48dc866484d2c6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/command.js\":\"9828bd5757dfb519\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/context-menu.js\":\"ef13119b2578e8f8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/dialog.js\":\"ee734666b0d7c685\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/dropdown-menu.js\":\"e85314d3931bfb43\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/floating-listbox.js\":\"0dcfbb223cba3106\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/index.js\":\"871cd9d20e979ba0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/input.js\":\"ceeb60da2b2e9c67\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/kbd.js\":\"f2e0970b9a41b8b8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/label.js\":\"26514c27318f3908\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/textarea.js\":\"d06bc1c66c35e4f0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/useEditModeYieldKeepalive.js\":\"cad05b86581f77b3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/BootFallback.js\":\"68ffbdaf7d68eb13\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/FocusedRowLazyMount.js\":\"32c37c2925dcf6d8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/LazyViewportMount.js\":\"8fbe6c3908a7dcc1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/LocalDbCorruptionFallback.js\":\"31bf4c5964763d42\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/error.js\":\"cbe8ffa0d1a7a715\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/lazyMountRegistry.js\":\"efe38c20b52df0b1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/suspense.js\":\"b0eeefde0db1dc67\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/CreateWorkspaceDialog.js\":\"4649fe37c8acfb80\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/PendingInvitations.js\":\"5a7420b7c2728ec1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/SyncProgress.js\":\"50668a8d7261fa0d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/UnlockProgress.js\":\"f4f197798291aad3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceKeyGate.js\":\"dfe73b0faafbee40\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSettingsDialog.js\":\"f5b966bce3ec3405\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSwitcher.js\":\"21f3aea5db386a50\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSyncGate.js\":\"79dc385f4d12ffdf\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/ConversionFlow.js\":\"1977f1f536da7194\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/ConversionFlowHost.js\":\"31975a398bb1e697\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/EncryptionSection.js\":\"e8cb89afc4168e22\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/attachmentPrompts.js\":\"9dec7bbdb6cbcbb3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/bundleFolderPrompts.js\":\"472505685448e22b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/conversionFlowDeps.js\":\"e8dafaa5f582febf\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/conversionFlowStore.js\":\"aba35807cdf8ad41\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/flowUi.js\":\"3bbb013d2de2ee42\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/useConversionRun.js\":\"f766fcc902ccae5a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/keyUi.js\":\"92c2ddf7a5e841b5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/useCloseOnKeyLoss.js\":\"55ef147137918e47\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/useCloseOnServerE2ee.js\":\"97a518dc3f663986\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/workspaceUnlocked.js\":\"97e89c89d7e98b13\",\"/knowledge-medium/pr-preview/pr-1859/src/context/backgroundSubtree.js\":\"0beb5dc51483f01e\",\"/knowledge-medium/pr-preview/pr-1859/src/context/block.js\":\"0a1dc825bd51d222\",\"/knowledge-medium/pr-preview/pr-1859/src/context/layoutWsContext.js\":\"dc37e1c26580bc8e\",\"/knowledge-medium/pr-preview/pr-1859/src/context/propertyDisplay.js\":\"79c79b986b36cfbe\",\"/knowledge-medium/pr-preview/pr-1859/src/context/repo.js\":\"697e66018b39b81f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/aliasClaim.js\":\"0b8887041e35b6f5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/aliasSeatNamespace.js\":\"3176cb2fe997d3d1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/blockData.js\":\"54bf5d023e147986\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/blockType.js\":\"7e3de22c57e199dc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/changeScope.js\":\"3983f7a39a28c482\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/codecs.js\":\"2697ab0b7e2dbcfd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/derivedData.js\":\"394da37e928852b9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/errors.js\":\"e84f1850dcef569c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/events.js\":\"e4dab6d283d7b647\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/handle.js\":\"27b801c3e9051760\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/index.js\":\"609454d8cbf291f2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/mutator.js\":\"d87f081be2326153\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/processor.js\":\"080c010a35c94c10\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/propertySchema.js\":\"281f176bcbaf8de2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/query.js\":\"d8e4c4412117f437\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/sameTxProcessor.js\":\"7e0d09c5610a0d06\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/schema.js\":\"27b801c3e9051760\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/tx.js\":\"27b801c3e9051760\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/typedBlockQuery.js\":\"0aae58594e31f5ea\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/user.js\":\"a09da8653071f7dd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/valuePresetCore.js\":\"5963908f0d44ac74\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/valuePresets.js\":\"de26e3c95eb428f6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/attachmentCleanerIOVerb.js\":\"a33dba656f900f88\",\"/knowledge-medium/pr-preview/pr-1859/src/data/block.js\":\"a25271a6d3580dd1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockCache.js\":\"64aad71bb0d1d29f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockId.js\":\"36b3d39afc94c247\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockLiveness.js\":\"7a9e305a42d23f91\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockMerge.js\":\"f3208b062311bee4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockSchema.js\":\"383c1958e32d6e66\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockTypeLookup.js\":\"0d002db1135c8e4d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockTypes.js\":\"dd75d01b8aad6703\",\"/knowledge-medium/pr-preview/pr-1859/src/data/childrenView.js\":\"6cd0aacffe1058d4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/clientContext.js\":\"9e64e91c0efa5f82\",\"/knowledge-medium/pr-preview/pr-1859/src/data/dbFileSiblings.js\":\"89fd7bfbdcd78ac2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/definitionSeeds.js\":\"d61474b1c877222c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/derivedIds.js\":\"6328b1d07247b0d7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/drawnSubtree.js\":\"155efda1ee85cdb1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/facetBridge.js\":\"ba3e0dcba82cfd18\",\"/knowledge-medium/pr-preview/pr-1859/src/data/facets.js\":\"a4a8502e3ab09edb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/globalState.js\":\"c71b9650edb00ebf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/aliasClaimRederiveProcessor.js\":\"6b4369e25d1e15ff\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/ancestorBatch.js\":\"406d10a616b62f77\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/blockTypeTypeifyProcessor.js\":\"ca109aaeedd0a40e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/clientSchema.js\":\"1cc75dc1674646f8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/commitPipeline.js\":\"e76375bd408761cc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/devAssertions.js\":\"bfdb3dfa78ebcff7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/firstSync.js\":\"c8e3b3fa74d833cd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/freshInitialLoad.js\":\"dd46ba8c7407a7f4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/graphBackfillClaim.js\":\"7598c99d11e09a8d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/handleStore.js\":\"031eb76ea81830fd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/idleMarkerJobs.js\":\"16debf3aaa658fab\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/initialDownload.js\":\"1154d0461855e741\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/initializeClientDatabase.js\":\"b484d650719fe6f9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/jsonCanonical.js\":\"e12f97973b650b7d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelInvalidation.js\":\"72a2e25ab68fd1fd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelProcessors.js\":\"4df33c6be3e7f318\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelQueries.js\":\"bdf2d44749fbff0f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/mergeTypeMembershipProcessor.js\":\"7891bdc0eb4601a4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/normalizeReferencesProcessor.js\":\"c6cdf24e06d6d628\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/poolInstrumentation.js\":\"f0b998820949d528\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/processorRunner.js\":\"b5dda8e6f9c867b2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyCellBackfill.js\":\"5caeaf097ef2ce4e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyChildMint.js\":\"052c920962f1fcf0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyChildrenProcessor.js\":\"5c5fd41c0e647c25\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyDefinitionChangeProcessor.js\":\"730ef1fd70599e6e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyDefinitionSynthesis.js\":\"f50d4a4e82b2d884\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyKeyScan.js\":\"41c05a97f4bc1f98\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertySchemaResolution.js\":\"2aeb432aaf871096\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyValueEdits.js\":\"418227dfa6a1a1d9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/raiseProtocol.js\":\"3af9632cbbb27d3f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/readBatch.js\":\"7a38dc57c0052e9d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/refProjection.js\":\"c223585e24618f27\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/referenceTargetLookups.js\":\"6b86f92a79a3a08a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/referenceTargetProcessor.js\":\"719b067e0b3ba1b1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/replayMerge.js\":\"979085318a777d11\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/sqlBinds.js\":\"512302b0d3ac0d35\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4fc91831604903ad\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/arrivalProcessors.js\":\"1f0eb89b16d9a615\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/invalidate.js\":\"7fe1a2bca9bab840\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/materialize.js\":\"797367f076a4bf83\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/observer.js\":\"bf37e55adc2ed557\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/reconcile.js\":\"5d2b4107e414f483\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/timingMetrics.js\":\"99f0face0111f530\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/treeQueries.js\":\"6fba69e2cf862f93\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/txEngine.js\":\"65d998f133e7cc52\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/txSnapshots.js\":\"d5bef1d144474006\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/typedBlockQuery.js\":\"5c3c19c95cc84be7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/undoManager.js\":\"9d11251783becb92\",\"/knowledge-medium/pr-preview/pr-1859/src/data/invalidation.js\":\"c0093939c669fc92\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelDataExtension.js\":\"b78a01bc8cecc366\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelPage.js\":\"35d679886a6a9f93\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelValuePresetCores.js\":\"dbcee9edf0335cec\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbCorruptionSignal.js\":\"fdab6179f90dbb3e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbStorage.js\":\"ae36c7e191cdce0c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbVfs.js\":\"4f0f43bb56755903\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localSchema.js\":\"c330ca03dfb126ef\",\"/knowledge-medium/pr-preview/pr-1859/src/data/maintenance.js\":\"68d1f23888eb33c1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/mergeProperties.js\":\"95e01c399d619b4c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/metricsConsoleHook.js\":\"7480988ab08aa6c5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/migrationsPage.js\":\"7b8d6906fc6f0ecf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/mutators.js\":\"4fcc1b5924ef584f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/orderKey.js\":\"51c7d567f7797748\",\"/knowledge-medium/pr-preview/pr-1859/src/data/orderKeyPlacement.js\":\"fac42b364360cd53\",\"/knowledge-medium/pr-preview/pr-1859/src/data/outlineSurface.js\":\"fbb76aae87b07b3f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pendingEditorContent.js\":\"15100ee02ed8deb4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pendingUploadsSql.js\":\"a8a31b169f768c48\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pluginStateExtensions.js\":\"2ea85285c8adb755\",\"/knowledge-medium/pr-preview/pr-1859/src/data/powerSyncLogger.js\":\"4f034fbc545fc034\",\"/knowledge-medium/pr-preview/pr-1859/src/data/projectorRuntime.js\":\"997fe7e41018da5c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/properties.js\":\"a876a8b75da4c119\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertiesPage.js\":\"d79d108155d41613\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyChildren.js\":\"80a38c51efd6c65f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionFanout.js\":\"65c5bdcf24643fb2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionMetadata.js\":\"e921a0ef750427b0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionRegistry.js\":\"27b87624a1a4d512\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDisplayMode.js\":\"fa15d4f2edd4ec0a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyRowCreation.js\":\"428e44911163d858\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertySchemaCreation.js\":\"26d26183af11b019\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertySeeds.js\":\"d0be68ffa51dae5c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/recentsPage.js\":\"9a4a1d95117554fe\",\"/knowledge-medium/pr-preview/pr-1859/src/data/referenceBlock.js\":\"80259e2933648fb0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/rejectedUploads.js\":\"f00267a187163e2b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/releasePowerSyncConnection.js\":\"21901b85339fdffe\",\"/knowledge-medium/pr-preview/pr-1859/src/data/repo.js\":\"f2f67aced83059ba\",\"/knowledge-medium/pr-preview/pr-1859/src/data/repoProvider.js\":\"86f68e8288272ecf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/rowProperty.js\":\"98288d40e63c4a90\",\"/knowledge-medium/pr-preview/pr-1859/src/data/searchFilter.js\":\"e1cf6101e1aa29b4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/seedIdentityLedger.js\":\"fc78d74a89f1dce3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/stateBlocks.js\":\"a0433fad2b0c6792\",\"/knowledge-medium/pr-preview/pr-1859/src/data/structuralEditPolicy.js\":\"938fb13aaeda5250\",\"/knowledge-medium/pr-preview/pr-1859/src/data/subtreeDelete.js\":\"6f85e7746caf9e24\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncStreamLock.js\":\"fc13c96722a30818\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncedTableSqlRecognizer.js\":\"142c837128db81ed\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncedTableWriteGuard.js\":\"58946197382aaac3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/targets.js\":\"984f906685b61392\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeColors.js\":\"7c413d575885733c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeDefinitionMetadata.js\":\"70e93b0f4e3b6fa0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeDefinitionRegistry.js\":\"3874013e3ba259fb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeExtraction.js\":\"9b371eee1d38e7eb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeInitialValues.js\":\"9c78656a1f775da6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typePropertyGroups.js\":\"90647dbb2b48595b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeSeeds.js\":\"7dacb306f96852d5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeTagger.js\":\"608680466d45c2c0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typedRecords.js\":\"fa79f8f99c05295c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typesPage.js\":\"8cafb61193f5e2f4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userPrefs.js\":\"53694ead8ba0ac46\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userSchemasService.js\":\"97f38ff7d93856df\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userTypesService.js\":\"1475e352da7c6e18\",\"/knowledge-medium/pr-preview/pr-1859/src/data/valuePresetRegistry.js\":\"f0c4dbc277fece2a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/visibleChildren.js\":\"2d034e9bc434858d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceConversion.js\":\"60e7c2f858693ba9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceFirstSync.js\":\"da1074af3a0a65bf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceIdNamespace.js\":\"68b54bb946810ef1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceSchema.js\":\"0be21c170e19a713\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaces.js\":\"032738524b1b8d1d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/writeAheadLog.js\":\"cdd376f2cdb71f56\",\"/knowledge-medium/pr-preview/pr-1859/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/BlockPasteShellDecorator.js\":\"31d2a3ca2fc080d5\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/atTrigger.js\":\"d93dc0b559b1ba39\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/autocomplete.js\":\"429c26f1f8900b02\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/codeMirrorExtensions.js\":\"fa8ccbc81f307954\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/contentFlush.js\":\"221e6f60837e5ce9\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/defaultInteractions.js\":\"98e854ecc5ea7d23\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/editSettleSignal.js\":\"95c04e0c9a5b4ff8\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/insertImage.js\":\"40d4230690d0b1af\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/referenceCompletionRange.js\":\"616ba0e71dce02bc\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/referenceTargetTypes.js\":\"b29c86a08e32eb6c\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/syntaxContext.js\":\"5080075ea07c8417\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/triggerMatch.js\":\"acd0dc1818f6d7d1\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/AppRuntimeProvider.js\":\"8812e22726aae1a0\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/BlockFocusShellDecorator.js\":\"99cc3bea2d26b3fa\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/ExtensionRenderBoundary.js\":\"ebd374556e19f8a1\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/PanelContentRecovery.js\":\"ed7f1d8ec7be4489\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/apiCatalog.js\":\"4b24b2d80c30a463\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/approveExtensionHere.js\":\"e6baf69c54e6233f\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/armedCutAppMount.js\":\"10a202efc164127e\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/batchableKeyedStore.js\":\"b42c0606d744af8b\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/blockInteraction.js\":\"c5e34e2bb451a2be\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/blockSelectionAction.js\":\"20cb5116a6aad576\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/compileExtensionModule.js\":\"94376cea49c87fae\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/compiledModuleCache.js\":\"a9009a1adb800466\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/continuousGestures.js\":\"df9c9a134c06a898\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/core.js\":\"bc36b5fb78f0226f\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/defaultRenderers.js\":\"4aaf0a48b4fc8d87\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/definitionFanoutAppMount.js\":\"47c7514d071111c4\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dialogAppMount.js\":\"8620f8cc8b45b382\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dynamicExtensionSeeds.js\":\"47339614aba79f83\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dynamicExtensions.js\":\"743c1c0c509b9b8b\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/exampleExtensions.js\":\"1cb83137111330b8\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionApprovalStatus.js\":\"d05a1bd8b3e79a01\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLoadErrorToast.js\":\"026717f8af13f3ef\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLoadErrors.js\":\"290da78e4fdb2fd3\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLookup.js\":\"150665b27dd09f48\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionToggles.js\":\"20a653a958e25c4e\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionUtilitiesCss.js\":\"3393ff41d9ef9fed\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/kernelPageDeletionGuard.js\":\"fe506d5387859f0a\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/liveRuntime.js\":\"591e6984674c528d\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/openExtensionsSettings.js\":\"b3a7651a5918d1c0\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/overridesCache.js\":\"e5c21d8c01396379\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/pluginIds.js\":\"89e0cd5b3a22a21a\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/processorRejectionToast.js\":\"d435d3b8648ee1c7\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/runtimeActions.js\":\"27160d61dc5d38ea\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/runtimeContext.js\":\"66db710b28cbb561\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/staticAppExtensions.js\":\"d1787b45c9fd1ae3\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/staticDataExtensions.js\":\"9e96d1c67a5b8887\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/toastAppMount.js\":\"2efddc8b7b216823\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/useOverrides.js\":\"911836456f0c5068\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/useShortcutSurfaceActivations.js\":\"fbac4c626e333647\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/discoverToggleTree.js\":\"a0df601f2572f46d\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/facet.js\":\"e535847e0f73f71d\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/resolveAppRuntime.js\":\"44f543cfaa466479\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/runtimeEvents.js\":\"21bc06663bc7ff4d\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/togglable.js\":\"13257371ee87077b\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/variantFacet.js\":\"abf1412e7c5f437e\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/verbFacet.js\":\"59c1468343c48293\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/block.js\":\"3578c83b8e6ca043\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/focusedChild.js\":\"806cc8d159b4f245\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/propertySchemas.js\":\"a313ec94b2ad071c\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/typeRegistry.js\":\"bab4c9c6be8e83ec\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useAncestorCrumbs.js\":\"67c766c3c619af73\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useAutocompleteListbox.js\":\"59b9affbf1f85ff4\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useDebouncedSearch.js\":\"e92efa51144cebdf\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useDebouncedValue.js\":\"576460dbc340a4f4\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useIsFocalRender.js\":\"46dd1de2bbd58f14\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useIsReadOnly.js\":\"9894b2a6bd28b545\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useMaterializeBacklog.js\":\"5707e1fb8020c511\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useMinuteClock.js\":\"439a353301a2cdbe\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/usePanelLayoutProjection.js\":\"3c657988f440eac7\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/usePendingInvitations.js\":\"f63e7844de5339ba\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useRendererRegistry.js\":\"c9aa8c91e5c91763\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useRetainedFieldRows.js\":\"8a3a6abe77317658\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useWorkspaces.js\":\"0ea8acf09236db0b\",\"/knowledge-medium/pr-preview/pr-1859/src/lib/utils.js\":\"24f521984d33a5df\",\"/knowledge-medium/pr-preview/pr-1859/src/main.js\":\"8b80e37dc90612af\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/MarkdownImage.js\":\"37485966023d368f\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/blockSeparators.js\":\"2f2303359ae47677\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/context.js\":\"700330d7e94ba67c\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/defaultMarkdownExtension.js\":\"5ff6a22024878fc1\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/extensions.js\":\"334ec6290070bfda\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/renderMarkdownHtml.js\":\"ac79b2ce20ecaf92\",\"/knowledge-medium/pr-preview/pr-1859/src/minimal-editor.js\":\"7318b94477f33a64\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/armedCut.js\":\"5f235abe932cfebf\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/captureMediaVerb.js\":\"bcce1661bcce73bf\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/clipboard.js\":\"7e5df68b11110c1c\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/decision.js\":\"def82b17689915ae\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/operations.js\":\"3eb5e0df969d86da\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/account-header/AccountHeaderItem.js\":\"5b06b4ae27983a9f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/account-header/index.js\":\"acebbcbeec22ac92\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"25f65401a7f351f0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/askAgent.js\":\"b1cbe9bafe0da74c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/askedStore.js\":\"d62393f309b85df4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9a62896837178e66\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/chipState.js\":\"22d2c13a3f095060\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/dataExtension.js\":\"513fb250f4b0603b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/index.js\":\"08110b57ccf6848f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1c7291779c2c5800\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/schema.js\":\"971bf28d807ec724\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/AgentTokensDialog.js\":\"03d33362b156c28d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bd0efad5c99c9daf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/addMedia.js\":\"19184a1715fc8dbb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9f92532c2c4a602f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/block.js\":\"858aa4849cf508cc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/context.js\":\"584cef28dbcf2d2a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fb0c73ee0a1da260\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/index.js\":\"cdbcdfa8b4a48a5f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/outline.js\":\"0143d662ec589d5c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/properties.js\":\"50ed26352a3da87f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/refs.js\":\"21670f920c4a225a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"90e9ec56cc5334b5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/search.js\":\"5587e9769fed6b1e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/shared.js\":\"faebd5f525e7dd5d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"efd737ea307e31e6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/text.js\":\"b06e9ea6a2556e3e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentWrites.js\":\"e2b579f31b714488\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/authoringCatalog.js\":\"55662035ab5c1c7d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/blockRefTargets.js\":\"6b73884d542486b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/bridge.js\":\"2d7183e4a215ec4c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/bridgeLoop.js\":\"4de459229ed66193\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/changeHistory.js\":\"d8db6b984397cf84\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/commands.js\":\"2bc98949c56505bc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/commentsCommands.js\":\"2980efadacec9360\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/dataExtension.js\":\"4f07becf460ad619\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/dataModelGuide.js\":\"d450eea5f0a74ca0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/describeRuntime.js\":\"491529b0e9e53d2d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/extensionLint.js\":\"c53fd4fb47e63ce6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/grainAudit.js\":\"d7121c4d95f2eb19\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/healthCommand.js\":\"20a00a46130e5388\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/index.js\":\"0eba456eb09452f3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/presetIdentity.js\":\"e4935f68362b44fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"233f16f1d66f82b9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/readMedia.js\":\"be09d1cd15c43b45\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/schema.js\":\"633632ca7a663b4c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/serialization.js\":\"31d5724baa998a5a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/targets.js\":\"7ff670d34484ccb8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/tokens.js\":\"a08407768f720dfe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/watchEvents.js\":\"5d54aad21b0762f4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/workspaceGuard.js\":\"2bfc7ea80bd6b251\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/writeCommands.js\":\"dd82b1926f531c12\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/AliasCollisionToast.js\":\"bd7efe380d928237\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/DuplicateNameBanner.js\":\"893e3000fec5f6ed\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/collisionMerge.js\":\"cc3e1595d41a6260\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/dataExtension.js\":\"dac3daf7321a7da8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/index.js\":\"6d54fddaadf2185f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/mergeCollisionAction.js\":\"8d6acef3f6d95868\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/pageStyling.js\":\"37b5518c748c6fcf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/rejectionToast.js\":\"8f1396e8f15271e0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/syncProcessor.js\":\"898e140ffb1ceb11\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/actions.js\":\"a44929d147ff14db\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/addComment.js\":\"d6ab76e38310a117\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/anchor.js\":\"98015e691947d2b5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/anchorState.js\":\"f5d3406f2536fcb5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/commentLinks.js\":\"4e086afcbce7972e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/confirmThreadDeletion.js\":\"c9b695cb591b09ec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/container.js\":\"856bd8c5417897fc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/dataExtension.js\":\"fb88bb1525d58c5f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/deleteComment.js\":\"0cc64c5612f9d2d3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/highlights.js\":\"4e687ba9f11a014e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/index.js\":\"84236dbbc5fbc227\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/linkedCommentsPill.js\":\"8195419e7b6f86db\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/margin.js\":\"393f92c4f7efce8a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/marginSchema.js\":\"ea6d00968d59d266\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/newComment.js\":\"16fc620910c352af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/ownThreadPicker.js\":\"f2ddb1b64173744b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/placement.js\":\"8f634fdd084ec635\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/queries.js\":\"ada1e2453fd8dbc6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotePosition.js\":\"1cbb0fa7585d17da\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotedIn.js\":\"62d0baa5da125c6d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotedRange.js\":\"c2fe43a4abb81012\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/rangeRefs.js\":\"efa939b4f9c750cb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readHighlights.js\":\"11b7dd763e4b9617\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readSelection.js\":\"cbaae7e31521712f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readSelectionUi.js\":\"dfb3dce4c09c3937\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/reanchor.js\":\"c9a528846998e407\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/schema.js\":\"89a6e012d323d5bd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/scope.js\":\"2f312fed36308c7a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/scopeThreads.js\":\"ca3bcb97a2340069\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/splitRetarget.js\":\"6378a85cabb26530\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/suggestionCard.js\":\"4e199d81bd95cf56\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/suggestions.js\":\"88b0d093f123772c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/summaries.js\":\"7e5c3c2dc622bc69\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/summaryBatch.js\":\"1ef736cc75daac3a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/surface.js\":\"b4de6d1cc121e9e7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/threadNavigation.js\":\"2eb149100df5e4c1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/threads.js\":\"66f03a77b3935cc8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/ui.js\":\"4a805fbfbee61c33\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/uiStore.js\":\"542042ea59af2c1a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-intents/appIntents.js\":\"5601d5d8690e731d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-intents/index.js\":\"7e4515a4da2fa234\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-update-prompt/index.js\":\"fe5f288fa4d6eb7d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-update-prompt/status.js\":\"1474a10537465227\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"77df650f9a7012d2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaBlockRenderer.js\":\"bd92ed419c014430\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a3fb2798db0edd78\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaUploadReconciler.js\":\"ce72641a128a5972\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetDownLane.js\":\"10c7cfa3305eca0f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetResolver.js\":\"78df00686acf63cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetUpload.js\":\"e81dc0c10e071a27\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/attachmentCleanerIO.js\":\"6cf049fa1bfc0fbf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4b23e8315cfe2ce7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/blobStore.js\":\"541ca476dbf4c534\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/browserMedia.js\":\"2c836bcbfa00d4ff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/byteStore.js\":\"fc1bbf42440cb2fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/cleanerIO.js\":\"663a605105d57cf0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/cleanupAttachments.js\":\"3d78d4931b334598\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/dataExtension.js\":\"16d1060c15784f94\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/downLane.js\":\"2062c80e70fe1ad6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/index.js\":\"5811f82cd758de3f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/insertImageContribution.js\":\"59ae14c925746651\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/laneArming.js\":\"b9f9a30dce70d983\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/laneLock.js\":\"37ffed57fb0d41ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaBlock.js\":\"f809c870193fd352\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaCapture.js\":\"a7fcab6966ff41a8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaLanes.js\":\"f5046b8180c63ceb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaViewers.js\":\"c270497133151809\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaViewersFacet.js\":\"8d798d8dc4847e34\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/pasteCapture.js\":\"c9df8268bb753c97\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/resolver.js\":\"776bd5901101fc73\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/retryUploadsAction.js\":\"00fc03cdbb1729e7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/storagePaths.js\":\"585db6c4b6dfb75f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadDrain.js\":\"219089641192ab55\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadLaneStatus.js\":\"1160c41eeac6cd26\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadReconcile.js\":\"6bb0a760cbf8d4fe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadRecovery.js\":\"0d503081b3478e8b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadStore.js\":\"851d2779fd550e27\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/useAssetObjectUrl.js\":\"7c33bf48af762837\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"97bda4c5b763959c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/BacklinksViewSection.js\":\"9f485cb2f2137984\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/facet.js\":\"2478d3b8c19c70bb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/index.js\":\"8bf8b6c8af2c96cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/prop.js\":\"b252f23b00dd755a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BacklinkFilters.js\":\"ea2c6818f51f9aaa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dcbc52881435bf79\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BlockEntry.js\":\"be039c7f86adcb3e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/LinkedReferences.js\":\"4c204244cb2564da\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9504f8a8aa752a4d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/dailyNoteDefaults.js\":\"cc0c32c7d1585f99\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/dataExtension.js\":\"fa810a0d6debf902\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/edgeExclusions.js\":\"f78bc7b3b09bec63\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/filterProperty.js\":\"37332d4ebe7e9cc2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/index.js\":\"9f992ccfc43b38af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d30220e5554d391e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/applies.js\":\"f86a1ba274d64484\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/countQuery.js\":\"bec5b6d9d0a4b145\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/expansionStore.js\":\"78b37b142d7a19fc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/index.js\":\"debea394884fe419\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5e4bacfc50038196\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/presentationInvalidation.js\":\"443b21cf8a58d623\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/propertyEditorOverride.js\":\"0967a1ceb16c9a53\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/propertyFilter.js\":\"60f122890f9cf777\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/query.js\":\"16db0468166d2e84\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/resolveFilter.js\":\"376e2e82824d3316\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/sourceBatch.js\":\"1fdd1f97000e45c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/sources.js\":\"1e8d3ce094c466a7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/useBacklinks.js\":\"437975a6f42a25a2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"41c44d0f60d115e9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/BirthdayCelebration.js\":\"0fca63595e0da543\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/BirthdayOverlay.js\":\"14d932b96a6f38c7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/gate.js\":\"310f68ce9b200e54\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/index.js\":\"69075aa0ee950270\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/wolfTheme.js\":\"b49276df06a71c26\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/BlockDragLayer.js\":\"ed95579bbb9bdedc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/dragController.js\":\"eddb36ab6d1bf54d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/dropTarget.js\":\"5f23907d2e48ffd1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/index.js\":\"b16d9668b1999aa3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/projection.js\":\"e44a389a3a14f28b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-info/BlockMetaCard.js\":\"91fb56e36a17b8c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-info/index.js\":\"60780eb9eaa18768\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/AddTagDialog.js\":\"c324e8e054a03b0b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f4ea8e75a3a83ea0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/TagNameIssueHint.js\":\"678d6427a10f33fe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/addTagAction.js\":\"35ece6bbcc7a2297\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/appendTag.js\":\"8bfec76143d036fb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/config.js\":\"d07b4a14f8742427\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/dataExtension.js\":\"ac9b7ca4b7bc6c5c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/index.js\":\"94aac24c12facb18\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/propertyEditorOverride.js\":\"3e2f417c961a4540\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/BreadcrumbList.js\":\"33bfe33f9d0d2ee6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9f9e1116024c8ca3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fea3ad810b3f2639\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"58b8a32705037d6c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"41e767d6a3c52a68\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/index.js\":\"b44cc99e466ef4b1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"66e63deeb3d4bc8b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/CharacterCountItem.js\":\"5ec382e926d9a00f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b5ec5d46f31559c6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/actions.js\":\"0e8caa7013f71904\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/blockType.js\":\"7822f40f68295e84\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/charCount.js\":\"aa3e496af327b17b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/dataExtension.js\":\"50eb879484dbb9fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/index.js\":\"2947b55053693de7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/profiles.js\":\"f95071bbb0db298f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/properties.js\":\"002062e0ec9e2ee5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/textCounts.js\":\"930295824f28f8b8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/colemak-keybindings/index.js\":\"5561febc09571e22\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/CommandPalette.js\":\"aae143e203b667d9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/HeaderItem.js\":\"0fab404eb20233c0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/context.js\":\"3a1ba88f44bc6133\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/index.js\":\"553b10cd415522fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/selection.js\":\"5de77b27235e4ce4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/toggleStore.js\":\"33870832e8d3c371\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/useCommandPaletteActions.js\":\"e513ea66090eaf8c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/ContributorBadges.js\":\"fad08ef7bf9d97b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/author.js\":\"6c8befefb36cacd3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/codeMirrorExtensions.js\":\"695dcdb22086b5ab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/dataExtension.js\":\"4785187eabe5177a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/index.js\":\"557141c194bdb831\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/mentionAutocomplete.js\":\"2ad31c9fa8e67d72\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/processor.js\":\"58ea5eee9ee43e13\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/profiles.js\":\"d1e40fba0550daa7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/queries.js\":\"cadd26dbdfab23d2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/schema.js\":\"a8625aeb7f6c887e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3e2a8be21132baa7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/followOrigin.js\":\"fa6496a9cc2bee0d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/index.js\":\"1cff45d028c6eecf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"18ea9d45d186d48d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d0d5f406d99e6521\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/CalendarGrid.js\":\"df94c101abfdd49f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DailyNotePicker.js\":\"16610b8366e1ebeb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"41723fd8b6ee389d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateNavDecorator.js\":\"e169b12823eeeab5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateScrubOverlay.js\":\"683bfce2e0795e62\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/HeaderItem.js\":\"19facc3398ef8846\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/ReschedulePicker.js\":\"089b967799e28df6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/SpreadDatesDialog.js\":\"516fe3911b995213\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/actions.js\":\"c43e38798760bd17\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/blockDateAdapter.js\":\"a33867b1ee970da7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/calendar.js\":\"237230c247d4dbb7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dailyNotes.js\":\"110951b7de918bca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dataExtension.js\":\"7bf6747efd5aa591\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubActions.js\":\"175d0bbb114101a9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubGesture.js\":\"70ae2857ea226d1b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3740657074657750\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d6818e7876e3e676\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/deletionGuard.js\":\"6951497564b35263\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dueQuery.js\":\"15f6e915cd998dd0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/index.js\":\"ca873fbe54490fd3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/landing.js\":\"79eb032314a4bf50\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/localSchema.js\":\"19c3bb5a31674fbf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/referenceDateAdapter.js\":\"4922dad84542ce1b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/rescheduleAction.js\":\"6f99fc3718f23ed4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/schema.js\":\"47c70943c2dd0c72\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/spreadBlockDates.js\":\"2321d9c69d93e8e2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/spreadDatesAction.js\":\"b3816792ff0cb081\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/today.js\":\"c0ad337d688945e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"808a97b4249c1b12\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e15a91663e2f5f44\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/audit.js\":\"573783cdbde1c6c0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/auditAction.js\":\"5e07b869584555b6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/auditRanges.js\":\"ea4e7ddf14d82339\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/diagnosticsSource.js\":\"4f4e26efd67b06c1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/divergenceScan.js\":\"58f737f3a2c03c24\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/index.js\":\"69add8363c765ae5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2eef56f81a73531c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/referencesMirror.js\":\"3b5d822b58983787\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/rowJson.js\":\"aeaa3cd5e85d361a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/schedule.js\":\"7e877a3bd2346ceb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/store.js\":\"97c41b90abfb628b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/action.js\":\"5bb1144475ae5a78\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/index.js\":\"877f0591b838422e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/plugin.js\":\"578225abc3144783\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c4003c349a0b2611\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/actions.js\":\"379de61e8567e00d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/changeMarker.js\":\"9d99bc6983b62abb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/diagnostics.js\":\"e86edb718b41e81e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/fileSystemAccess.js\":\"61326c0050307198\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/filenames.js\":\"39662c57eb7ffb9f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/index.js\":\"20995c68d62a0431\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/mirror.js\":\"80168a891e854a66\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/runLock.js\":\"94b8dea9e51656ae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/runtimeHealth.js\":\"972f5a1b88fc3122\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/schedule.js\":\"da9170a1597ad54a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/store.js\":\"12fd4ab1d1e1bcfd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/default-themes/index.js\":\"60cc44aaf1de51a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/default-themes/themes.js\":\"ccce762165f00347\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/diagnostics/facet.js\":\"a1385add13c140f6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/diagnostics/useDiagnostics.js\":\"e1dd9b75bfc4d7c4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/dismissals.js\":\"ad7adfa8398c8d61\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/index.js\":\"36552a515e37cc95\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/status.js\":\"8e779fc067d39a60\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/store.js\":\"c953ffaee8dc248a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0e2a565a713d654c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fea1536c1ed27ceb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/actions.js\":\"44e6df47389179eb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/config.js\":\"7b6a0ebeb11b06ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/dataExtension.js\":\"220eba6a10c84865\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/effect.js\":\"27973e5608ccc081\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/index.js\":\"e1b2e70734b3deca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f8fc443793e5dd75\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/useToggleTree.js\":\"9aa8a3359246cced\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/ExtractTypeDialog.js\":\"b225462ae54ef9b0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"27bf08acae0a2471\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/PropertyShapePicker.js\":\"a5a3d9678831d891\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/action.js\":\"f40d97a524f02cd4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/index.js\":\"02dca06041f52ace\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/FindReplaceDialog.js\":\"d6736580fa915fcb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/HeaderItem.js\":\"80e13fdaa7376d52\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/dataExtension.js\":\"2eac4423d87a16bf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/index.js\":\"0348b964128e8fdc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/search.js\":\"5edfebc4c6c4c1fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/toggleStore.js\":\"22abaf3fc891c72a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/LocationPropertyEditor.js\":\"37bf205bc707008f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/MapView.js\":\"8d901cde1ea677f5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/blockTypes.js\":\"4208c4c1e2ff56b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/codeMirrorExtensions.js\":\"bb9d76de86eb0264\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/createOrFindPlace.js\":\"a3f8571c435a8c65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/currentLocation.js\":\"2d01f94da7164731\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/dataExtension.js\":\"ebd94a02282b73b3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/geoContentDecorator.js\":\"6bcd940ff7e9f1e6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/googlePlacesClient.js\":\"e826c80be5d9bd6e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/index.js\":\"da4ab9c1477450ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/locationsPage.js\":\"be8fafeffcca0a75\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/mapViewport.js\":\"9a3868fb1e0e3559\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/pickCurrentLocation.js\":\"2c00c4e6d0f68f5c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/placeAutocomplete.js\":\"5441fc1665560436\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/placeNameCollision.js\":\"23166020d21a35d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/properties.js\":\"b016f8381f5cb31d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/propertyEditorOverrides.js\":\"cb7eed6bdb478f38\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/query.js\":\"6293b88a840e3f19\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/usePlaceSearch.js\":\"004384cbf2e86cc6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"072e940566b66acd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"54f6bd93354a78fc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0a76db236f7ebc7a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/config.js\":\"7bb0fe19cb36b5db\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/dataExtension.js\":\"c6dc14403cc24814\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/facet.js\":\"dcdbad073e5e9ba0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/grouping.js\":\"88fa487bd46b57e6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/index.js\":\"7828062a4507191d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"764452c79043f9ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/query.js\":\"4d7b6633b713e8e5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/resolveConfig.js\":\"8c60b2a91799a79b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3a34c44984e11849\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f6f676e3672f6a1a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/HtmlDocumentContent.js\":\"3670055f8bb21b78\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/HtmlFrame.js\":\"a7da437a52366288\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/actions.js\":\"707e9c94c4057b35\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/blockType.js\":\"dec75795c8472e8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/confirmRunScripts.js\":\"ac3924e707826ee3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/dataExtension.js\":\"5306e131f80334ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameAnnotations.js\":\"de52ce6fdbef8faa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameDocument.js\":\"41fd7d3c080a2024\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameTheme.js\":\"a45f14fa028cd3a7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/index.js\":\"92f4533cbbb24b4e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/scriptConsent.js\":\"b9bb20c143eef696\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/sourceMap.js\":\"a70d311553829972\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/useDocumentScripts.js\":\"8e67e9d15d8aa132\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/index.js\":\"9a22117872f571f8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/record.js\":\"391779c7cfda296e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/recordStore.js\":\"ce463ddb4bafbf3f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/responsiveness.js\":\"26baaf23581ede51\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/schedule.js\":\"a8db94c97e6f1f39\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/sessionContext.js\":\"8186cde1e7e88b99\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e7155dbb7e206fc7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"fde7b04d040c25bf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/actions.js\":\"5025e497d959a59e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/config.js\":\"ab06898b73fa91f7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/dataExtension.js\":\"87c66bb9b5b1131f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/effect.js\":\"f2e29a0412c2657a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/index.js\":\"ce89aafc9e953ff0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/keyCapture.js\":\"a2092a294c70516f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/overrideStore.js\":\"048a87e8dcd0b7f9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cfb99c2603205e05\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/HeaderItem.js\":\"9762112b1b498d5a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/LeftSidebar.js\":\"a8d32fc77b557180\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/actions.js\":\"4b251dd0a1fe3ad1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/facet.js\":\"b04b675ee6be8a41\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/index.js\":\"6247b39d3cc32bf9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/shortcuts.js\":\"9b283b6a261d4803\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/toggleStore.js\":\"eb1352033e29129c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/MergePicker.js\":\"1a28efe0cd525f84\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/index.js\":\"96672e9e20a75a35\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/mergeAction.js\":\"7bc96ee200b1c23c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/strategy.js\":\"b115b2cdab9bff89\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/Button.js\":\"3971d3b14975aa6e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"735ae5cc17bfa4bb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c31474bd7f8e2a48\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/facet.js\":\"d2172ced8b34dcd4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/index.js\":\"91e65222acdf9161\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d442bd5de05c99b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/actions.js\":\"335f5f84e192fa5c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5b7f4c583673167a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dc07c0efbf7b9c92\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/index.js\":\"e5b5b5cdaf1eeb97\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/MoveDestinationPicker.js\":\"515d500f3bf239fa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/blockSubtreeMembership.js\":\"478ecc96f7c33dad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/contextMenuItem.js\":\"c270755fbc41a7e4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/index.js\":\"f32eff9c62cd7290\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/moveAction.js\":\"d2124246861bfb6e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/moveBlocks.js\":\"742febe1587f72fc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/selectionAfterMove.js\":\"8427538fddbf838b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/TutorialBanner.js\":\"a9757fbd9c7ed108\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/action.js\":\"9cec65d60418d0a9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/bannerDismissal.js\":\"797bf1fc31a97e71\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/documents/cheatSheet.js\":\"03892df2e9fef37a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/index.js\":\"dd6411ad41313234\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/keys.js\":\"5e55a41bf0aca801\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/landing.js\":\"46f0e8a0defb1062\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/outline.js\":\"461d1c30a8eb166e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/seed.js\":\"72ff7698748cb0a4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5858e9368cb212d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/analyze.js\":\"1c8dc9a7fc2f0c3e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/diagnosticsSource.js\":\"dea43557ae471828\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/index.js\":\"16355e3877ec4ac5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/load.js\":\"1daec46f6ac29e51\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/monitorRun.js\":\"c52115d7a51fecc3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/schedule.js\":\"7ae0ebe44bf7c1a4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/series.js\":\"480f5474c9306213\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/store.js\":\"61e494d64d773995\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/trendAction.js\":\"86b416e97b37850b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/verdict.js\":\"d07174522eb61269\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/clickToEditAction.js\":\"cb9d999c64815e16\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/index.js\":\"5147a4e0ddfb81bf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/interactions.js\":\"bcda293654d90c27\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a6fb13abc4690739\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/MigrationGate.js\":\"ee0a409105c93cce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/MigrationGateDialog.js\":\"598e4208353068f1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/action.js\":\"f661aa5ff83d4ce3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/index.js\":\"60facb23761e40a0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/localRunMessage.js\":\"6c6db193e51e1819\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/plugin.js\":\"a1020826edb47ad4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/progressReport.js\":\"3d594b599f38eb18\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/sweepProgress.js\":\"14e60e00733b81bc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/FieldRowRenderer.js\":\"281081cc95ef8abb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/ValueRowRenderer.js\":\"c67eb3ee415cb6b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/actions.js\":\"4864f0a2b5d569fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/autocomplete.js\":\"c4804d3154750ff9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/fieldRow.js\":\"a2b305ac213a2ab6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/index.js\":\"7e5c8f8ccc0ac46b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/referenceWarning.js\":\"5b1c5695b436f1b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/valueAutocomplete.js\":\"bd908f1a0d8bd122\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/valueSchema.js\":\"9f03fe32eeb94f72\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/HeaderItem.js\":\"7bdb2a6467188ad1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/QuickFind.js\":\"ee9065d9f4c7ddfe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/index.js\":\"7ee39ee0236eb102\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/recents.js\":\"84a1538805ab9e57\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/resultItems.js\":\"434554011bb34751\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/selection.js\":\"a0576270c999dca8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/toggleStore.js\":\"b3766f6e1c25178a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/HeaderItem.js\":\"46867fcb1e59eac4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7905029ef77be1ee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/grouping.js\":\"1839760a4bab7d49\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/index.js\":\"02f6bf4757bffcb4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/target.js\":\"eb11f8917fb09ee6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/codeMirrorExtensions.js\":\"90013771e06da211\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/contentPrefill.js\":\"681c5db6a418298a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/dataExtension.js\":\"ceeaf20ff51d740e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/index.js\":\"bdd621faed8cfd47\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0649936c70c7c189\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/invalidation.js\":\"b6dcc8fdecd5da46\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/localSchema.js\":\"7777db3706333dc0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/blockrefs/index.js\":\"2bf19f4c66f0e034\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5e0b59d41c12558b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/index.js\":\"ff28e470a10406a5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/referenceNode.js\":\"71debb5c6dd32871\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8cef7072b4b8bf96\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d91c784675fc81c1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/index.js\":\"499aa46f5217c796\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"492085505fb8f20c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8d4f4d0432536604\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/mergeRetargetProcessor.js\":\"b0d412e0174a6209\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/parseFence.js\":\"299c00ec2955af93\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referenceParser.js\":\"8dd6b971cb3e1a2d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referenceProjection.js\":\"52e6938c6b9d346c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referencesProcessor.js\":\"0a2688ba7a544ffd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/renameProcessor.js\":\"5a7f89c89c1d61d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/spanReplacement.js\":\"fe0e9167574c0f90\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/htmlToOutline.js\":\"dae1b8bc36aea7eb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/index.js\":\"d178a8a9ff4c7f1b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/normalizeClipboardDom.js\":\"95bf0754a63ac341\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/pasteDecision.js\":\"afd380568e5be19c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/action.js\":\"ee7130d9b83a67d2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/blockIds.js\":\"c58566140e30e101\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/content.js\":\"6ac9854154f4b293\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/effect.js\":\"bfe4d7178f0c0994\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/ids.js\":\"c9431ce6315d0060\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/import.js\":\"94293832b1ba6bde\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/index.js\":\"7b38d59009d0b539\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/plan.js\":\"05938e8caa5de046\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/plugin.js\":\"7b510f5031bb947a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/promotion.js\":\"68f36b49ee29bc4f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/properties.js\":\"d57db61d50d1ce4b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/references.js\":\"c9f33bc7b2b4acb1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/report.js\":\"fe844274939e9fee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/roamMemo.js\":\"85d9961e4a477b7f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/runtime.js\":\"99351427445f12e2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/schemaReconciliation.js\":\"d334c508ce42506e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/srsMarkers.js\":\"b54622ce28ae68b0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/todo.js\":\"eb46480a20ca193b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/typeCandidates.js\":\"b7b2ce2cdf2b3d02\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/types.js\":\"33432ca9ea4fff0d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/search-health/index.js\":\"8456c2fc853153af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/search-health/store.js\":\"c054de5cd53cc9e5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/HeaderItem.js\":\"e14b45f665271947\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8f40bbf12c6a8aed\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/index.js\":\"7a70ee4a88a25eac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/model.js\":\"e1acc04257ae50f6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/toggleStore.js\":\"37f71ec6af0b5d74\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/useKeyInspector.js\":\"516bbb00d1fb997b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c451d405b615a0ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/ShellDecorator.js\":\"cc0a426177eecc21\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/actions.js\":\"d767898cf3b6a1a6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/exclusionsFacet.js\":\"485a5eeef92f87ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/index.js\":\"3c06a0dfb827f319\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/shell.js\":\"0de26bdcb152a9dc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/surface.js\":\"d3dbc542736381cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/walker.js\":\"4446d25ba7ae2a2d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/RescheduleToast.js\":\"111245c8fb3b8547\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/dataExtension.js\":\"56b889b6b416444f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/index.js\":\"be35b62861697f50\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/indicator.js\":\"d09a57296ee49cee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/moveSrsState.js\":\"f13715a714a0a0da\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0e85f9183dee12f5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/scheduler.js\":\"04d1b102cdcd9081\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/schema.js\":\"ec3b1c892ea6e51c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"956281be470fb99d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/srsClipboard.js\":\"84cdeedb5d761bf0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"257c4ad324b199e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/DailyNoteReviewHint.js\":\"63be5c45fe3ed34f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/DeckPicker.js\":\"37b6d88279839d4f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewControls.js\":\"96f9300f12cc58d4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7485e3d123d16fc9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewSession.js\":\"38ff717a4013d981\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/actions.js\":\"9976b645e13a7e7d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/archive.js\":\"4740448fe049e83d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/dataExtension.js\":\"43a5b7329eaf8ee3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/deck.js\":\"22d901a743a03937\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/dueQuery.js\":\"9c8e011953fb5e94\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/gradeDecision.js\":\"7c0b1036ebad6aac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/index.js\":\"7bc4fb80f405fc75\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/keyHints.js\":\"dfb0cf51a609590f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/reviewCardLayout.js\":\"9e911aaa747802e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/reviewProgress.js\":\"0d61259c50cda020\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/schema.js\":\"99c4679ebaa8b309\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/useDueCards.js\":\"85a4dc8edfac8973\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/startup-metrics/index.js\":\"f42c7ce295f6a0b2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/startup-metrics/record.js\":\"2f5a9eed838a38ef\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/index.js\":\"5b03321252f5f213\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/persistenceStatus.js\":\"420f6d1966b254b1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/requestAction.js\":\"d3e718422a0f819d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/TypeChipsDecorator.js\":\"a3856602f380ac61\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/codeMirrorExtensions.js\":\"46f44059f79eb40c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/index.js\":\"6d1c1fc228b3e81b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/typeAutocomplete.js\":\"15bae7ffc36b7dd0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d11ba1afa97a2c94\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/actions.js\":\"39c8394852eaeecf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/anchor.js\":\"85d63c04ec0cd4d2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/events.js\":\"b21a1cf89d337dfa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/gestureActions.js\":\"c0909110b1aa5714\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/index.js\":\"2cc068477ebf0f30\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e81dd208cf4e5bd4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/collect.js\":\"c1aef822b156f81f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/index.js\":\"a5c67066868ca3ca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/record.js\":\"8e6d555b2ee3e95e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/RejectionDialog.js\":\"665c62b4ea35df1e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/SystemStatusHeaderItem.js\":\"794a8caae4efe03f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/index.js\":\"921f51c516353f65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/model.js\":\"7e75608c2103ccaa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/queueCounts.js\":\"6c241c077acf286d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/rejectedHelpers.js\":\"ae95c3e66355e72c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/rematerializeAction.js\":\"cda09e30a8c359ed\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/useHysteresis.js\":\"3a1a3b4ac8b4feab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/ColumnHeaders.js\":\"79978735c021e9c0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/QueryUi.js\":\"869f932d5c178751\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/TableLayout.js\":\"be6333eca6cf61f4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/actions.js\":\"80f158f1b6060cf3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/cellEdits.js\":\"378a5ce408056e7e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/childrenViews.js\":\"d095146b0a5c30bb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/columns.js\":\"5b5d0d670885d542\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/controller.js\":\"ca783317253d2e54\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/convert.js\":\"f1e29b93b80860ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/dataExtension.js\":\"d0a7b87fe5b868b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/index.js\":\"ce927654a0661384\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/keys.js\":\"0e748d034b496588\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/model.js\":\"da5d6648b9a27b94\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/navigation.js\":\"c08eac3d48734b35\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/backfill.js\":\"568c62689675dba2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/completion.js\":\"be341da0c7a59dc4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/format.js\":\"546aafc94a8658f4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/parse.js\":\"ea13333243f7abdd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/queryValue.js\":\"cd8b67b4564bf04d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/source.js\":\"641bfe52191ee2d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/registry.js\":\"ff4b80ee90b4805f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/rowGutter.js\":\"9286ebfb099569cc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/rowVerbs.js\":\"0921fb8a16809d2a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/schema.js\":\"b4bba4b58636d87c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/sort.js\":\"5b8837a3fd96aa19\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/effect.js\":\"227ea37bd2854b93\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/index.js\":\"46ea748a529fb396\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/theme.js\":\"6f99384cb8addd9b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/actions.js\":\"4fbbd24ce4e157ed\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/dataExtension.js\":\"e48577cc8b512a4a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/index.js\":\"2a6b14dc219dbf7d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/schema.js\":\"618f4298b375cef3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/TouchSelectionLayer.js\":\"793394ddc887d117\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/actions.js\":\"46350548d6717464\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/defaultItems.js\":\"2681a443e88d93fd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/facet.js\":\"1c1904ec7c70b5dd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/holdRecognizer.js\":\"857e5a2e781cb47f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/index.js\":\"d351af9ba09cde81\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/UpdateIndicator.js\":\"8de89f46fe5d50cc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/index.js\":\"91d4310ca1af1402\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/loadTimes.js\":\"ed06efdb90ada4bf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoNotesRenderer.js\":\"f7ce12262444d79c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoPlayerRenderer.js\":\"a4ca68cc7f595f8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoTimeStamp.js\":\"afa34fdd2b1139ac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/actions.js\":\"35ba84daf83e6c04\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/index.js\":\"87c844ee369f7e7c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/markdown.js\":\"11f5e6d8e9863a3c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/notes.js\":\"308805621f79ce64\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/registry.js\":\"67d73766481e14f2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/remark-timestamps.js\":\"52610c53acc1d858\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/view.js\":\"17708a176698bc22\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/LinkHints.js\":\"ef9bbc48a1b2a282\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/index.js\":\"1f368efeede65cbb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/model.js\":\"38f695c9826ca95e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/settings.js\":\"338d11d6345170e9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/actions.js\":\"e49d5a15d2652019\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/index.js\":\"4402c243339f954d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/interactions.js\":\"7a11aaecd71df964\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/workspace-header/index.js\":\"a1440411bde11c34\",\"/knowledge-medium/pr-preview/pr-1859/src/registerServiceWorker.js\":\"6d747a3abfab0bcc\",\"/knowledge-medium/pr-preview/pr-1859/src/requestPersistentStorage.js\":\"ec8479ef5c6debd0\",\"/knowledge-medium/pr-preview/pr-1859/src/services/authRequestDeadline.js\":\"9d2a89ac2bf03df9\",\"/knowledge-medium/pr-preview/pr-1859/src/services/authStorage.js\":\"18ea68a9ab6f6765\",\"/knowledge-medium/pr-preview/pr-1859/src/services/powersync.js\":\"843bed4cd19f9308\",\"/knowledge-medium/pr-preview/pr-1859/src/services/supabase.js\":\"5539fe9704078415\",\"/knowledge-medium/pr-preview/pr-1859/src/services/uploadErrorClassifier.js\":\"723bb40255601da4\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/ActiveContexts.js\":\"fc66bdceb24de606\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/HotkeyReconciler.js\":\"da4c633357aced4d\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/WipeLocalDataDialog.js\":\"656221e69b28a8d9\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/actionDispatch.js\":\"44c269805d37b1c7\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/actionRefItems.js\":\"f455c10f3e9e8d9b\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/applyKeybindingOverrides.js\":\"4784e970d160019b\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/blockActions.js\":\"2f5db514e5599ab7\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/blockMergeGesture.js\":\"bf17a69afba91a1c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/canonicalizeChord.js\":\"5acff872f29ca6b5\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/defaultContexts.js\":\"79c51efaa483ba3e\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/defaultShortcuts.js\":\"0ec811a81d1b5124\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/effectiveActions.js\":\"97aeb340908abc3b\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/gestureAction.js\":\"c10eff653e065485\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/gestureBinding.js\":\"135ec8e925cd198c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/holdRegistry.js\":\"fc840ac6780f15e9\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/keybindingConflicts.js\":\"9843ab4647144f8f\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/keybindingOverrides.js\":\"38b16d61372b789e\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/pointerAction.js\":\"cd475bc21ae8c170\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/resolve.js\":\"66e2208c885918d6\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/runAction.js\":\"3696276bc15f43df\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/sequenceMatcher.js\":\"9e32332025272c10\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/types.js\":\"46f2ca748dee2b36\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/useActionContext.js\":\"7d26b931351ccee8\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/useActionDiscovery.js\":\"b13bdc5a78ac75e5\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/utils.js\":\"5cc7e517d2e8c31a\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/bootStore.js\":\"ac70fb9489359dce\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/previewDatabases.js\":\"546be20275ae05a8\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/byteTransform.js\":\"b0209ae0918bf297\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/attachmentCleaner.js\":\"3c5bfea80175be2c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/attachmentParts.js\":\"e5a973d68eedb4b1\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/bundleParts.js\":\"fa38154e4057de91\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/bundleRecord.js\":\"ae17be90443dbcb1\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/manifest.js\":\"180a344f28b3587c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/takeBundle.js\":\"b81bef9f8bf36da0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/verifyBundle.js\":\"4f631aae0d758d49\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/cleaningStage.js\":\"6ca56923f5669f8f\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionKey.js\":\"0c5b03d4e4f17004\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionServer.js\":\"5cfccfcef82bb4ba\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/flip.js\":\"322db27080957560\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/flipAttempts.js\":\"557b79bafb173ca5\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/pages.js\":\"4fdae713d39cb0c7\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/preflight.js\":\"3aed60fee361ab2c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/reseal.js\":\"760a4f65db0ad28c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/runConversion.js\":\"b29818af9483fead\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/runLock.js\":\"94b5ab08a5c4258b\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/sealing.js\":\"94c0105185bd72be\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/sealingStage.js\":\"778ec1d540c3faca\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/stage.js\":\"efe6f992f51c630a\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/verifyReseal.js\":\"6bb5fbc0dd310e51\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/aad.js\":\"5f4ea021fbd9e744\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/aead.js\":\"bf1484986f1d1101\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/base32.js\":\"9e8925d28ec48e89\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/base64url.js\":\"e2a62ba14540c90c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/binaryEnvelope.js\":\"43f71496a785eb54\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/byteAead.js\":\"46edc48cb060b315\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/canary.js\":\"0021c72fd6389137\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/contentHash.js\":\"d2d2082f196db06c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/contentKey.js\":\"c857cb484ef2b321\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/derivedIdNamespace.js\":\"815159c36c762108\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/envelope.js\":\"a8d39546ad0d9fff\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/hex.js\":\"3fd22808ffb079a9\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/sha256Hex.js\":\"edb81e6f429aee42\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/workspaceKey.js\":\"9e65668dbbe0089f\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/conversionState.js\":\"52e170faa35a3b61\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3b4a218db2671b56\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/pastedKey.js\":\"6b1f460b3cc88059\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c3b3605e97227cb6\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/upgradeWorkspacePin.js\":\"991cb3814a7c72af\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/keyStore.js\":\"8d673eceaa27b7b2\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/mintWorkspaceKey.js\":\"c0186eeb4f25a0bf\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/modePin.js\":\"0a2c5e1f20756873\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/openWorkspaceKeys.js\":\"bb2149c854d2f4de\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/resolveWorkspaceEntry.js\":\"d50e88eed9a1678f\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/resolver.js\":\"a4b98c74952bb2d9\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/workspaceAccess.js\":\"a5cfadf160c8c7b0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/transform.js\":\"78841e0b1be6d0d5\",\"/knowledge-medium/pr-preview/pr-1859/src/themeBootDefaults.js\":\"1b1e14a73ddcb56b\",\"/knowledge-medium/pr-preview/pr-1859/src/types.js\":\"990f132632bb6bd2\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/ClientLocalSettings.js\":\"e04103424c84d369\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/abortableSleep.js\":\"be4a3c1e433b71a4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/array.js\":\"b224f8ed53f236b0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/backlinkAutocomplete.js\":\"7ff88e96d04cc003\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/blockCrumbs.js\":\"fda0e3034cccad94\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/blockrefAutocomplete.js\":\"f0759a01f2d8afc0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/cadencedIdleJob.js\":\"111da11cc2e45271\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/callbackSet.js\":\"43080bc52de05bf0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/clientId.js\":\"aecb754d9612ea57\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/codemirror.js\":\"70713447d63fbfea\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/codemirrorCompletion.js\":\"461e0adf921e10f4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/copy.js\":\"f0134780486ec72b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dailyPage.js\":\"9cb009097ed62b6b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dbForensics.js\":\"367a4a9aed66070d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dbForensicsHooks.js\":\"466c091a321f4b44\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/deleteBlockThroughUi.js\":\"5ce2fbbd5c7d6222\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dialogs.js\":\"fe031b7bfa6fe3d9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dom.js\":\"463687b079842523\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/downloadBlob.js\":\"ac7e581a8ee729c9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/exportSqliteDb.js\":\"332502af200531e1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fileSystemAccess.js\":\"af89dc93701723de\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/flipSlide.js\":\"eff9e48d8431b111\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fnv1a.js\":\"ae7117eb30c982ae\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/formatBytes.js\":\"dbdf75ce72b99c2b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fuzzyRank.js\":\"eb64ad2dd766d130\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/idbKeyedStore.js\":\"630b87c2ea7ecf86\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/idleCallbackPolyfill.js\":\"44cbc2fd3a937ad9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/keyboardAwareScroll.js\":\"232d7948486cd347\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/keyboardViewport.js\":\"9b0c7ee1372fc437\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/lastWorkspace.js\":\"1d100ed8a320cd85\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutColumns.js\":\"84e17b937b48eec9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutSessionDom.js\":\"362cc4bf45434ff0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutSessionId.js\":\"57736fe4289b76fc\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/linkClickGestures.js\":\"7f40856df429674c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/linkTargetAutocomplete.js\":\"973e99c8c36a6af5\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/localDbCorruption.js\":\"68ccf520f67643bc\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/localDbRecovery.js\":\"974c972503989b0a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/markdownParser.js\":\"06b3a94905c76312\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/memoize.js\":\"e060254f738be56c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/nameFieldCommit.js\":\"bdb8beb3e98af42f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/nameList.js\":\"ab47b648cf84a99e\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/navigation.js\":\"86a8dce4beb4fc85\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/omnilinerNamespace.js\":\"3ffba484e888faab\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/opfsPageScan.js\":\"e4c66f68424fb0d9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelClearance.js\":\"84cbf550bb46e48a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelHistory.js\":\"ab59fac960476de1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelLanes.js\":\"f4303a4dd4fdefd7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelLayoutProjection.js\":\"925442995501e2bf\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelScrollAnchor.js\":\"5d56ae0237aea832\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelUrlFlags.js\":\"1b9471f6d0a817b9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/platform.js\":\"4a9cb653b13eed56\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/pluralize.js\":\"c458740d9d149f6a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyCreation.js\":\"7e87b4b5085dfb79\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyNavigation.js\":\"4f98f3e4fb2450f1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyValueContext.js\":\"8ef051495d4c99c4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/react.js\":\"16c06780a73f9c62\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/relativeDate.js\":\"c2e3a0c451d6115f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/relativeTime.js\":\"1a32d8b8ec439385\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/renderScope.js\":\"2b293c44e44db1ed\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/resolvedThenable.js\":\"15712fd798330725\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/routing.js\":\"29c606dcb0cf4770\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/safeMode.js\":\"ad729bc3611d6294\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/scheduleIdle.js\":\"123f89f36c3a7538\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/screenWakeLock.js\":\"e7c18255139da6cb\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/selection.js\":\"f4fbbf2d0a00b004\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/softKeyboardGrab.js\":\"7aa1119d28b7d27f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/startupTimeline.js\":\"feb58348990b5bb7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/state.js\":\"24ca98c6e69bb1aa\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/string.js\":\"06ee75f203349947\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/surfaceZoom.js\":\"7c993191a2bd792c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/time.js\":\"7c4ad59826e3eee3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/toast.js\":\"ef830f383d880806\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/toggleStore.js\":\"88f24d9119cda9dd\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/untilStopped.js\":\"5ba938f39232c896\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/userActivity.js\":\"c6f6f8f5eb875a64\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/viewTransition.js\":\"e06220fabf1c5b35\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/viewport.js\":\"84a01943b29c86bf\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/webLock.js\":\"898b4f0ac4ecbc2d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/workspaceRecovery.js\":\"9dfe10cc179faed3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/workspaceSnapshotStore.js\":\"a948c15c4f997b50\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-compiler-runtime.js\":\"2b8fad7774fb011f\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-client.js\":\"8824fc66789b27a0\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-server-edge.js\":\"945e58194030a14b\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-server.js\":\"cf0e5f593bbadfdf\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-static-edge.js\":\"bf22f8476068f2e5\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-static.js\":\"5ed0da2626dd5998\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-test-utils.js\":\"0d688b27e2109408\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom.js\":\"fa513253ddf499f0\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-jsx-runtime.js\":\"a348c9c3c32a4672\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react.js\":\"b2378fcac19c8ec1\",\"/knowledge-medium/pr-preview/pr-1859/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1859/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1859/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
