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
		buildId: "82976a759f6b-9a2663bb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/\":\"2878e91fadc00d01\",\"/knowledge-medium/pr-preview/pr-1859/index.html\":\"2878e91fadc00d01\",\"/knowledge-medium/pr-preview/pr-1859/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1859/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1859/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1859/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1859/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1859/assets/FacadeVFS-n1B3oGgz.js\":\"2e39e506909a8448\",\"/knowledge-medium/pr-preview/pr-1859/assets/OPFSCoopSyncVFS-DCcQkQJ1.js\":\"5b1b7c3d28f1940f\",\"/knowledge-medium/pr-preview/pr-1859/assets/OPFSWriteAheadVFS-BkD6pB7D.js\":\"692b958b7d9302a3\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-BJcEG88H.js\":\"7aa867852361794a\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1859/assets/wa-sqlite-async-BMri4MLr.js\":\"3491023f3edf3e73\",\"/knowledge-medium/pr-preview/pr-1859/assets/worker-D145vx3w.js\":\"7451a0b6e05107c2\",\"/knowledge-medium/pr-preview/pr-1859/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1859/chunks/app-fvGsszat.js\":\"969269155dd7e41d\",\"/knowledge-medium/pr-preview/pr-1859/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1859/index.js\":\"571bfbe044bef19e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1859/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1859/assets/AccessHandlePoolVFS-U7HNKv2V.js\":\"867463aa74213191\",\"/knowledge-medium/pr-preview/pr-1859/assets/IDBBatchAtomicVFS-Di6tdqmw.js\":\"167bbfd0bfc7b9ef\",\"/knowledge-medium/pr-preview/pr-1859/assets/MemoryVFS-DxGdy99J.js\":\"98220eb0fa19c0f0\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-D6-ARCJ9.js\":\"34103ca0a2db378f\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-async-CcP1ICa_.js\":\"1d14e802f75965be\",\"/knowledge-medium/pr-preview/pr-1859/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1859/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1859/chunks/AccessHandlePoolVFS-Bebbfn6H.js\":\"282c1572d9b9d265\",\"/knowledge-medium/pr-preview/pr-1859/chunks/FacadeVFS-CPyNW0cj.js\":\"cbe62c60cd47fea7\",\"/knowledge-medium/pr-preview/pr-1859/chunks/IDBBatchAtomicVFS-CGO3iPd_.js\":\"4124f1f34f564e46\",\"/knowledge-medium/pr-preview/pr-1859/chunks/MemoryVFS-Crlcenu_.js\":\"e4042210c68b5b44\",\"/knowledge-medium/pr-preview/pr-1859/chunks/OPFSCoopSyncVFS-nNq3QFiv.js\":\"30c12f3ffe18fbff\",\"/knowledge-medium/pr-preview/pr-1859/chunks/OPFSWriteAheadVFS-DnX-HtWv.js\":\"db60e5fc55aed8b4\",\"/knowledge-medium/pr-preview/pr-1859/chunks/Preview-CsttvXFm.js\":\"e97939da96a1b273\",\"/knowledge-medium/pr-preview/pr-1859/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1859/chunks/card-Dc2tfvZH.js\":\"b9441b20969b4992\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1859/chunks/dist-h4tT_fLB.js\":\"c7ec78f4c77dd112\",\"/knowledge-medium/pr-preview/pr-1859/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1859/chunks/mc-wa-sqlite-BKJjP9u7.js\":\"9700f18313a4e9b3\",\"/knowledge-medium/pr-preview/pr-1859/chunks/mc-wa-sqlite-async-CQUIW157.js\":\"c26fa817cb604624\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-BDWwtW9Y.js\":\"671fd92f4106a3cb\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-BlUBrppj.js\":\"9ec8728bdb0540c5\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-BnJ_w8KI.js\":\"4922d11403bf9fe3\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-CShs6qiq.js\":\"de6deaa00352b0b2\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-Cl0rPx92.js\":\"edf73210c8d309e0\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-Dka4xbs2.js\":\"ea7a71b251d20f90\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-DqSjxXUt.js\":\"c1aec70bd66ebe86\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server-legacy.browser.production-Da93rtvd.js\":\"f6e15675680cc9ac\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server.browser.production-CsXWJjiI.js\":\"17503af5de4e7a45\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-dom-server.edge.production-EudsS6Xk.js\":\"0d8291bbc6e04979\",\"/knowledge-medium/pr-preview/pr-1859/chunks/react-fs4DwDQC.js\":\"d071f719185bc549\",\"/knowledge-medium/pr-preview/pr-1859/chunks/server.browser-BZ-eUmj1.js\":\"981700a4d1432b71\",\"/knowledge-medium/pr-preview/pr-1859/chunks/textarea-06ZWSeNz.js\":\"99cd7ddbde214526\",\"/knowledge-medium/pr-preview/pr-1859/chunks/ui-BCyPQJFt.js\":\"09d7ede9a4879fc4\",\"/knowledge-medium/pr-preview/pr-1859/chunks/wa-sqlite-DnvorOw_.js\":\"41222972b3c2c95a\",\"/knowledge-medium/pr-preview/pr-1859/chunks/wa-sqlite-async-Df3v7wD1.js\":\"39bacb6ec45296eb\",\"/knowledge-medium/pr-preview/pr-1859/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1859/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1859/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1859/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1859/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1859/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1859/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1859/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1859/src/App.js\":\"f5e12c9903376c25\",\"/knowledge-medium/pr-preview/pr-1859/src/appUpdate.js\":\"ccc0b202fd8a8740\",\"/knowledge-medium/pr-preview/pr-1859/src/appVersion.js\":\"f8d76bad34ceedce\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/initialLayout.js\":\"64f3fea0f8289344\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/openWorkspaceData.js\":\"f63ca73c98eb18c9\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/resolveWorkspace.js\":\"67d616a180d006b0\",\"/knowledge-medium/pr-preview/pr-1859/src/bootstrap/workspaceBootstrap.js\":\"2d1f1516b456b7c0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockComponent.js\":\"c8cdf9d5b7eb0092\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockCrumbs.js\":\"18c40720017cb904\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockEditor.js\":\"0268615820b96f30\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockLoadingPlaceholder.js\":\"04937d739d4be5a2\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockProperties.js\":\"14764e3d11120f6b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/BlockSearchPicker.js\":\"b3ad90e7518db760\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ConfirmBulkDeleteDialog.js\":\"a7da3a03d91b8201\",\"/knowledge-medium/pr-preview/pr-1859/src/components/DividerHandle.js\":\"4e42e9b13aa5a14f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/DraftEditor.js\":\"c4cbae991a6a5b2d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/GutterPill.js\":\"56fbc881c6c9a231\",\"/knowledge-medium/pr-preview/pr-1859/src/components/Header.js\":\"37c038790eb736ed\",\"/knowledge-medium/pr-preview/pr-1859/src/components/LazyBlockComponent.js\":\"5d52cf66798e7c0b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/Login.js\":\"49d81ddde0bf0f66\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ZoomableSurface.js\":\"8fc0fbe1406a5302\",\"/knowledge-medium/pr-preview/pr-1859/src/components/editModeKeepalive.js\":\"7d4c5e10aa92917f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyDisplay/PropertyDisplayScope.js\":\"bbc861a9e7f00e27\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5a06c23fb5526ffa\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/RefPropertyEditor.js\":\"1fb1f714584979fa\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/RefTargetTypePicker.js\":\"32ba263a09f2bcd4\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/SelectPropertyEditor.js\":\"de4fa2799e5dfde0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/TypesPropertyEditor.js\":\"9c12e160f9452aae\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/defaults.js\":\"aae93d63c19b7b47\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/kernelValuePresets.js\":\"bec61bd46da2131d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/selectablePresets.js\":\"a1c95d631abfb69c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyEditors/typesPropertyUi.js\":\"2160b738bcfde14e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/AddPropertyForm.js\":\"7e350d9a18a80612\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/PropertyPicker.js\":\"82ca9d4910bef692\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/PropertyRow.js\":\"b891f4273aeda063\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/Rows.js\":\"dd60f7c1b177d1d5\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/actions.js\":\"37e9e25894e297d1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/declarationOnly.js\":\"585c30c42d111a5f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/layout.js\":\"30604a85cba664f1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/model.js\":\"9da4f9b94057571f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/shapeUi.js\":\"61e5e77bd69c4d7f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/shapes.js\":\"a7244b71ffa6d240\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0f755ef2299bddcd\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanel/visibility.js\":\"03175563363977ec\",\"/knowledge-medium/pr-preview/pr-1859/src/components/propertyPanelSections.js\":\"86ecc3969c81f6a7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockEmbed.js\":\"c6d5cac4611d44df\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockLink.js\":\"f928f096423f2fe3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/BlockRef.js\":\"551353d1c7e37cdc\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/ReferenceLink.js\":\"fd19fa0578a16d39\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/cycleGuard.js\":\"36f658e90271ab5b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/cycleGuardContext.js\":\"cbd2d845826e54c3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/linkInteraction.js\":\"2d52077bcf757894\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/referenceLayout.js\":\"6234dea834296a9c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/references/useBlockRefAncestors.js\":\"bc59f951bc2fb6c3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockGutter.js\":\"00e7965f134a0ec3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockInfoDialog.js\":\"1448e81492d074dc\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BlockTypeBlockRenderer.js\":\"93735a2adb42974d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/BulletHoverCard.js\":\"98b4c66e33150188\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/CodeMirrorContentRenderer.js\":\"2d64a034315eedbd\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7391ab9f696379e9\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/ColumnResizeHandles.js\":\"29a990a76ae8a439\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"94ab872dd0e8adc7\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/DefaultBlockRenderer.js\":\"23e7521022bfce32\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/LayoutRenderer.js\":\"f433dd816bb3a129\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/MarkdownContentRenderer.js\":\"ff3033cb00cedd0d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/MissingDataRenderer.js\":\"a9a4eb3ca7a63031\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/PanelRenderer.js\":\"d8d1537753862e94\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/PropertySchemaBlockRenderer.js\":\"720a85a6986f6de3\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/TopLevelRenderer.js\":\"2fce24a62dd49820\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/blockGutterMode.js\":\"bde12898cdeec1cd\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/blockTitleText.js\":\"e64cef3dcbb46ae8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/fieldCreationKeydown.js\":\"1762c792b0e29d45\",\"/knowledge-medium/pr-preview/pr-1859/src/components/renderer/layoutRootContext.js\":\"9ed42f7aaac5a25b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/typeChip/TypeChip.js\":\"f0a97d4db7f54bbd\",\"/knowledge-medium/pr-preview/pr-1859/src/components/typeChip/chipStyle.js\":\"e530dfa53a53047d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/anchored-floating.js\":\"88172648703ae3b4\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/button.js\":\"12ab7070e5c77bb1\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/card.js\":\"dcc0e41c2dce6ab2\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/checkbox.js\":\"3c5eb2767cd472e6\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/collapsible.js\":\"04f8e069b9fcfc06\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/command.js\":\"cd5044a15f6592b4\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/context-menu.js\":\"e1dedd383f5fa452\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/dialog.js\":\"b66da0e933bb5c18\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/dropdown-menu.js\":\"9fee60aa107c24dd\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/floating-listbox.js\":\"73cc2856d85c4e66\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/index.js\":\"7d2e1cdca467b2f0\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/input.js\":\"039fb86b9303cd0b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/kbd.js\":\"546793d368e87adc\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/label.js\":\"94fdd7c2122e149a\",\"/knowledge-medium/pr-preview/pr-1859/src/components/ui/textarea.js\":\"c719815b1448bdfe\",\"/knowledge-medium/pr-preview/pr-1859/src/components/useEditModeYieldKeepalive.js\":\"19fa1becc0c9ee15\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/BootFallback.js\":\"5374a2a974e7a12f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/FocusedRowLazyMount.js\":\"620df548be24dfca\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/LazyViewportMount.js\":\"a1faf75df074e69b\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/LocalDbCorruptionFallback.js\":\"464d37b4b6d25d1d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/error.js\":\"c076e7162993a29c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/lazyMountRegistry.js\":\"9e7fe2bba0986a9e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/util/suspense.js\":\"7998b41bcd037c33\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/CreateWorkspaceDialog.js\":\"6b04dee9f0198480\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/PendingInvitations.js\":\"c8b839442d587b66\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/SyncProgress.js\":\"c96df17a949d52da\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/UnlockProgress.js\":\"99fa2ed599846c7c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceKeyGate.js\":\"cf008c86f2c0a99c\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSettingsDialog.js\":\"9d7bd53eadc21f6f\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSwitcher.js\":\"42a764545ade5278\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/WorkspaceSyncGate.js\":\"1b3c51d86d306bfe\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/ConversionFlow.js\":\"edb2ee94c0532f76\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/ConversionFlowHost.js\":\"049b1767029cd39d\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/EncryptionSection.js\":\"b6f444065c7a2dc4\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/attachmentPrompts.js\":\"6693f5d7c4fb49f8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/bundleFolderPrompts.js\":\"89665b4fff286cae\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/conversionFlowDeps.js\":\"620a0d599927d2f9\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/conversionFlowStore.js\":\"375a8949a4243d56\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/flowUi.js\":\"4085f842187cb13e\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/conversion/useConversionRun.js\":\"53fde24992ea2693\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/keyUi.js\":\"71c2c50308228abc\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/useCloseOnKeyLoss.js\":\"6ca6f3e6e9155af8\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/useCloseOnServerE2ee.js\":\"12b34944b2413669\",\"/knowledge-medium/pr-preview/pr-1859/src/components/workspace/workspaceUnlocked.js\":\"098d7da9057b57c9\",\"/knowledge-medium/pr-preview/pr-1859/src/context/backgroundSubtree.js\":\"d882b4f382826030\",\"/knowledge-medium/pr-preview/pr-1859/src/context/block.js\":\"d7a1104ffcf741f0\",\"/knowledge-medium/pr-preview/pr-1859/src/context/layoutWsContext.js\":\"83c8559d17f5a708\",\"/knowledge-medium/pr-preview/pr-1859/src/context/propertyDisplay.js\":\"1161b314875d9aab\",\"/knowledge-medium/pr-preview/pr-1859/src/context/repo.js\":\"ecd50b454fcb09ac\",\"/knowledge-medium/pr-preview/pr-1859/src/data/aliasClaim.js\":\"9190b926990f7c27\",\"/knowledge-medium/pr-preview/pr-1859/src/data/aliasSeatNamespace.js\":\"4cfb8c13e99af6ea\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/blockData.js\":\"940399e22122f745\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/blockType.js\":\"d3ff991abc6c37a0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/changeScope.js\":\"6d65c63d2f8c94c8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/codecs.js\":\"5dc3ea130aeffded\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/derivedData.js\":\"71804116e3b25cc0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/errors.js\":\"72531ab8d192e742\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/events.js\":\"4ccb082bb058dfc7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/handle.js\":\"5b46b5e64e375bb8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/index.js\":\"fa94bfc7cc5a0259\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/mutator.js\":\"7a712c46c70918d2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/processor.js\":\"3a19fb209e5c9dea\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/propertySchema.js\":\"fed6b7e01ebd6991\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/query.js\":\"faef4d1e8946a8ea\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/sameTxProcessor.js\":\"7394533c2509423b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/schema.js\":\"5b46b5e64e375bb8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/tx.js\":\"5b46b5e64e375bb8\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/typedBlockQuery.js\":\"180d79987a51c4b0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/user.js\":\"b4f4b6444f2234ad\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/valuePresetCore.js\":\"193cb3bf33c22c00\",\"/knowledge-medium/pr-preview/pr-1859/src/data/api/valuePresets.js\":\"56078b2ad81ee846\",\"/knowledge-medium/pr-preview/pr-1859/src/data/attachmentCleanerIOVerb.js\":\"acd09023a1b6e810\",\"/knowledge-medium/pr-preview/pr-1859/src/data/block.js\":\"5f199eba7a4fe439\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockCache.js\":\"764eefc6fe7a290b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockId.js\":\"ea96b922560ffb03\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockLiveness.js\":\"b4dd2dc6ad716ea3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockMerge.js\":\"e0e6b8af1a3cc089\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockSchema.js\":\"3895366930fbba0f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockTypeLookup.js\":\"202fb52618941e90\",\"/knowledge-medium/pr-preview/pr-1859/src/data/blockTypes.js\":\"473768d8df0d5f4c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/childrenView.js\":\"c77db46abfcba5fa\",\"/knowledge-medium/pr-preview/pr-1859/src/data/clientContext.js\":\"4ab3f5a516b24f76\",\"/knowledge-medium/pr-preview/pr-1859/src/data/dbFileSiblings.js\":\"3d2bf92be1e422cf\",\"/knowledge-medium/pr-preview/pr-1859/src/data/definitionSeeds.js\":\"bb7f77798765333f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/derivedIds.js\":\"d90a21447b00da05\",\"/knowledge-medium/pr-preview/pr-1859/src/data/drawnSubtree.js\":\"0facc79f2f87a4ed\",\"/knowledge-medium/pr-preview/pr-1859/src/data/facetBridge.js\":\"148c880203552a51\",\"/knowledge-medium/pr-preview/pr-1859/src/data/facets.js\":\"ada203bd0d9d6017\",\"/knowledge-medium/pr-preview/pr-1859/src/data/globalState.js\":\"8848af7b23bfcd68\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/aliasClaimRederiveProcessor.js\":\"fc37d414418afbdc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/ancestorBatch.js\":\"e69f06d7a6a80bf3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/blockTypeTypeifyProcessor.js\":\"ddb8a0b06e452b6c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/clientSchema.js\":\"8df2047a0f5b386b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/commitPipeline.js\":\"0205b7e35db0cc52\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/devAssertions.js\":\"8a520eb5422b3658\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/firstSync.js\":\"a6ec8012c7e3f059\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/freshInitialLoad.js\":\"de5430d68264589f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/graphBackfillClaim.js\":\"904e543148c006c6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/handleStore.js\":\"e89b4ee62faf46c6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/idleMarkerJobs.js\":\"54aa285016964039\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/initialDownload.js\":\"b41322876375cf35\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/initializeClientDatabase.js\":\"59d0b5e8f9710dbe\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/jsonCanonical.js\":\"fcfce972443a98c6\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelInvalidation.js\":\"a5c2180f86091786\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelProcessors.js\":\"660c3d64fbba2da0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/kernelQueries.js\":\"80dd0029998cef64\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/mergeTypeMembershipProcessor.js\":\"db74e2c5a08f04ab\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/normalizeReferencesProcessor.js\":\"87b50320227dda4f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/poolInstrumentation.js\":\"2862891b6ee275eb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/processorRunner.js\":\"495ceb076bc65d94\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyCellBackfill.js\":\"934b96fc1c8e1b60\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyChildMint.js\":\"c1fb58fab1cea7f9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyChildrenProcessor.js\":\"704e7e7f9de6b3b7\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyDefinitionChangeProcessor.js\":\"70f8eb1e032c79b3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyDefinitionSynthesis.js\":\"9db559da748af075\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyKeyScan.js\":\"0f8254b92f940021\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertySchemaResolution.js\":\"667ada094bc778e9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/propertyValueEdits.js\":\"0e28b7eefda9fcf0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/raiseProtocol.js\":\"b5577a7a8ff12ade\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/readBatch.js\":\"25cca291ab1dd367\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/refProjection.js\":\"cf0f3c6acb5f1161\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/referenceTargetLookups.js\":\"023cefc0ad632301\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/referenceTargetProcessor.js\":\"f1d17e46eb3ced55\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/replayMerge.js\":\"6a5822cd24a4ca0a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/sqlBinds.js\":\"f3ae4bc1f381f4ba\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"09fe64a88501d38e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/arrivalProcessors.js\":\"9be19cf3843dcc49\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/invalidate.js\":\"0a4aeb3fa796d717\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/materialize.js\":\"68cac821bfbcd019\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/observer.js\":\"59fc97726aeb1fa3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/syncObserver/reconcile.js\":\"5685917ea05ba60c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/timingMetrics.js\":\"390f83852a405215\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/treeQueries.js\":\"4a6e0ca357ff5f93\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/txEngine.js\":\"cf81c6fe9686d5ea\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/txSnapshots.js\":\"73cadb2d29d970cb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/typedBlockQuery.js\":\"09b7987c912f8a14\",\"/knowledge-medium/pr-preview/pr-1859/src/data/internals/undoManager.js\":\"a129a443e5c3cf7f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/invalidation.js\":\"73ddf7af341cbc93\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelDataExtension.js\":\"9ba9878e745510e1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelPage.js\":\"92244ef9584b7cba\",\"/knowledge-medium/pr-preview/pr-1859/src/data/kernelValuePresetCores.js\":\"dae2be91a15cd65b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbCorruptionSignal.js\":\"be6111ce3e061b32\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbStorage.js\":\"93f210082c8ec1e3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localDbVfs.js\":\"1183e1e6e6aafaac\",\"/knowledge-medium/pr-preview/pr-1859/src/data/localSchema.js\":\"a73ccd5843ea8773\",\"/knowledge-medium/pr-preview/pr-1859/src/data/maintenance.js\":\"9e4fee4836e5aa29\",\"/knowledge-medium/pr-preview/pr-1859/src/data/mergeProperties.js\":\"dd7d3fde84d5248f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/metricsConsoleHook.js\":\"e649bdb438c3c099\",\"/knowledge-medium/pr-preview/pr-1859/src/data/migrationsPage.js\":\"bc26f23d5553b0bc\",\"/knowledge-medium/pr-preview/pr-1859/src/data/mutators.js\":\"52c76aeb74dfdd9d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/orderKey.js\":\"1b0bd274b6aea509\",\"/knowledge-medium/pr-preview/pr-1859/src/data/orderKeyPlacement.js\":\"9485e560adb23561\",\"/knowledge-medium/pr-preview/pr-1859/src/data/outlineSurface.js\":\"4c0ff77c733f6e37\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pendingEditorContent.js\":\"a7f42a3e7d01ce2d\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pendingUploadsSql.js\":\"4a8367150efaef0f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/pluginStateExtensions.js\":\"e7a8fe7f7fba4343\",\"/knowledge-medium/pr-preview/pr-1859/src/data/powerSyncLogger.js\":\"4fadcd45f3639ed1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/projectorRuntime.js\":\"d2016d2456c726f0\",\"/knowledge-medium/pr-preview/pr-1859/src/data/properties.js\":\"8541cac15f1a6eea\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertiesPage.js\":\"adb52934760ed51f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyChildren.js\":\"42910e87c646f270\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionFanout.js\":\"62838f34caba88e2\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionMetadata.js\":\"a267b07901885e6f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDefinitionRegistry.js\":\"5a48b7112de2c327\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyDisplayMode.js\":\"172cfef6839b5325\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertyRowCreation.js\":\"936bf9ed2a6325e9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertySchemaCreation.js\":\"9079bf28111b9e6c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/propertySeeds.js\":\"4072d5d4950db3f4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/recentsPage.js\":\"ab1b7d28cc413b29\",\"/knowledge-medium/pr-preview/pr-1859/src/data/referenceBlock.js\":\"6d8a7122ef5ff1e9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/rejectedUploads.js\":\"08672897ef295ac5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/releasePowerSyncConnection.js\":\"56355b7b212bfb03\",\"/knowledge-medium/pr-preview/pr-1859/src/data/repo.js\":\"3f38098e5e8cccb4\",\"/knowledge-medium/pr-preview/pr-1859/src/data/repoProvider.js\":\"b2d157f4a5659fb9\",\"/knowledge-medium/pr-preview/pr-1859/src/data/rowProperty.js\":\"bad3508e94cb383a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/searchFilter.js\":\"9f0308ba26f65b16\",\"/knowledge-medium/pr-preview/pr-1859/src/data/seedIdentityLedger.js\":\"83ead7448bb52d89\",\"/knowledge-medium/pr-preview/pr-1859/src/data/stateBlocks.js\":\"692bcd3eaf4eddae\",\"/knowledge-medium/pr-preview/pr-1859/src/data/structuralEditPolicy.js\":\"0ea3ebb34acc6eb1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/subtreeDelete.js\":\"0a8e0fe0de168acd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncStreamLock.js\":\"81eda32a1e5ef60b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncedTableSqlRecognizer.js\":\"cd02db16b08c18c3\",\"/knowledge-medium/pr-preview/pr-1859/src/data/syncedTableWriteGuard.js\":\"359d37704ad60b67\",\"/knowledge-medium/pr-preview/pr-1859/src/data/targets.js\":\"5cf913be164a976e\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeColors.js\":\"0a9887a2bf37a789\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeDefinitionMetadata.js\":\"efd52288883fc066\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeDefinitionRegistry.js\":\"5a454e9a0d06b0bd\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeExtraction.js\":\"9853d912ba19db8f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeInitialValues.js\":\"b33b897b9b0509ff\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typePropertyGroups.js\":\"aa434793d4a49445\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeSeeds.js\":\"960a08f579f19bda\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typeTagger.js\":\"dc7c817f5e5b5c7a\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typedRecords.js\":\"df43fc3c59a6354b\",\"/knowledge-medium/pr-preview/pr-1859/src/data/typesPage.js\":\"0fe3a8e93e74dbde\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userPrefs.js\":\"0dcf88d8a6d02d67\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userSchemasService.js\":\"15828c569207d80c\",\"/knowledge-medium/pr-preview/pr-1859/src/data/userTypesService.js\":\"74c2068165b4cd5f\",\"/knowledge-medium/pr-preview/pr-1859/src/data/valuePresetRegistry.js\":\"7f4483f7372f2f23\",\"/knowledge-medium/pr-preview/pr-1859/src/data/visibleChildren.js\":\"099e17b955971fbb\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceConversion.js\":\"b02444dc883339db\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceFirstSync.js\":\"be5e202caccf6565\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceIdNamespace.js\":\"aa9d236c531efbe1\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaceSchema.js\":\"d245834cf96c8ca5\",\"/knowledge-medium/pr-preview/pr-1859/src/data/workspaces.js\":\"886c914cd7784168\",\"/knowledge-medium/pr-preview/pr-1859/src/data/writeAheadLog.js\":\"fa15a3aa8212db93\",\"/knowledge-medium/pr-preview/pr-1859/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/BlockPasteShellDecorator.js\":\"967f572c380a315e\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/atTrigger.js\":\"c107ab9e3db1ea62\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/autocomplete.js\":\"8ba6b5a4c8b01368\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/codeMirrorExtensions.js\":\"24799042e8c2791e\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/contentFlush.js\":\"ffcb7846644dacd6\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/defaultInteractions.js\":\"ceb639dc41e91309\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/editSettleSignal.js\":\"d6b766a1dd3bf20a\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/insertImage.js\":\"9dd353f4fa64e1b7\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/referenceCompletionRange.js\":\"55e4151b0934a2fe\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/referenceTargetTypes.js\":\"22717b3098cf9e5f\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/syntaxContext.js\":\"479c4328fe83ae7d\",\"/knowledge-medium/pr-preview/pr-1859/src/editor/triggerMatch.js\":\"0c19426cc3ba606f\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/AppRuntimeProvider.js\":\"df9971d1aa1930bc\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/BlockFocusShellDecorator.js\":\"8904dbb27fbff279\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/ExtensionRenderBoundary.js\":\"c42eab6b2b5c314c\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/PanelContentRecovery.js\":\"2ab3dbc86028645d\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/apiCatalog.js\":\"a0a10f2d67c23a4d\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/approveExtensionHere.js\":\"8afa44dbed3a12a5\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/armedCutAppMount.js\":\"ff3c18d7df9a4bce\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/batchableKeyedStore.js\":\"08841f610e9dd5db\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/blockInteraction.js\":\"44a060e18e69551c\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/blockSelectionAction.js\":\"0c212cd6d0cb9734\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/compileExtensionModule.js\":\"26e1afff4113f29e\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/compiledModuleCache.js\":\"0cd5e3ea1f63a806\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/continuousGestures.js\":\"8fd63da933d1c9b7\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/core.js\":\"ce7690871896b228\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/defaultRenderers.js\":\"9cde8c3016738478\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/definitionFanoutAppMount.js\":\"56960c665cd9feb9\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dialogAppMount.js\":\"700638068716f663\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dynamicExtensionSeeds.js\":\"c222068538533bb1\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/dynamicExtensions.js\":\"5926822b585df321\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/exampleExtensions.js\":\"da753f3212e22452\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionApprovalStatus.js\":\"031aa442308ff0b9\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLoadErrorToast.js\":\"5b78a6e451b5df5f\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLoadErrors.js\":\"99b46e69fdc5769a\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionLookup.js\":\"4ebf4177b0711552\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionToggles.js\":\"50836552325f3994\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/extensionUtilitiesCss.js\":\"34ba44931e60dae1\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/kernelPageDeletionGuard.js\":\"06f67a16c4f086b0\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/liveRuntime.js\":\"afbca60e537293ea\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/openExtensionsSettings.js\":\"f3d56f4379c4037d\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/overridesCache.js\":\"4e303e77b1ffe7bc\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/pluginIds.js\":\"e197f51cf93db89e\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/processorRejectionToast.js\":\"9eefec19c0569250\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/runtimeActions.js\":\"1e8b2010e0862885\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/runtimeContext.js\":\"866698975411bd77\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/staticAppExtensions.js\":\"eafbc426b65759b8\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/staticDataExtensions.js\":\"3c6eab8189287a53\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/toastAppMount.js\":\"2bc78d516c719d84\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/useOverrides.js\":\"d3fee9943e1671fb\",\"/knowledge-medium/pr-preview/pr-1859/src/extensions/useShortcutSurfaceActivations.js\":\"0dd983aff70da264\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/discoverToggleTree.js\":\"7bd1c39a14306564\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/facet.js\":\"4c50157c74966d5b\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/resolveAppRuntime.js\":\"130f34ecb63045bd\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/runtimeEvents.js\":\"6d5ab0c7bc69c33e\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/togglable.js\":\"9ff4f410b17f95af\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/variantFacet.js\":\"2ad88b53702abf5a\",\"/knowledge-medium/pr-preview/pr-1859/src/facets/verbFacet.js\":\"0ab10e233a29b158\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/block.js\":\"1802858103e85869\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/focusedChild.js\":\"c2a3866f37aaffd0\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/propertySchemas.js\":\"c9357eace7f49db9\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/typeRegistry.js\":\"a88d7ec538902dd6\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useAncestorCrumbs.js\":\"2188372ddfc02f62\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useAutocompleteListbox.js\":\"70c6f4abb7311d41\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useDebouncedSearch.js\":\"f92108180e6fbff9\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useDebouncedValue.js\":\"58d4a059556d6693\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useIsFocalRender.js\":\"4c69f863022be37f\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useIsReadOnly.js\":\"6518695842ea8c4d\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useMaterializeBacklog.js\":\"69b3c5ec69d1f9a3\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useMinuteClock.js\":\"ba36a4db126f4339\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/usePanelLayoutProjection.js\":\"4dbc4da93948a8dc\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/usePendingInvitations.js\":\"90566202b340ed0d\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useRendererRegistry.js\":\"172d9d1509059167\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useRetainedFieldRows.js\":\"a675ae72b9382592\",\"/knowledge-medium/pr-preview/pr-1859/src/hooks/useWorkspaces.js\":\"49ebb0dfc402f2bc\",\"/knowledge-medium/pr-preview/pr-1859/src/lib/utils.js\":\"91f8814006b2e7df\",\"/knowledge-medium/pr-preview/pr-1859/src/main.js\":\"2d9bbb338a493100\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/MarkdownImage.js\":\"2bf2ea135bc9ef3f\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/blockSeparators.js\":\"57f64e8297f0ef7c\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/context.js\":\"ff32771894abe765\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/defaultMarkdownExtension.js\":\"5ff776046e88bebf\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/extensions.js\":\"66fff7cc934e6995\",\"/knowledge-medium/pr-preview/pr-1859/src/markdown/renderMarkdownHtml.js\":\"2a16aad57b5ef254\",\"/knowledge-medium/pr-preview/pr-1859/src/minimal-editor.js\":\"d9e0bd1eb427ec55\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/armedCut.js\":\"77e012a75e0979c6\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/captureMediaVerb.js\":\"ea53b5e50c990a6f\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/clipboard.js\":\"7bf01cf335296bd9\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/decision.js\":\"d404ddd8ab1fc774\",\"/knowledge-medium/pr-preview/pr-1859/src/paste/operations.js\":\"7aa8fcb096af7ef9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/account-header/AccountHeaderItem.js\":\"781acb0f758801e6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/account-header/index.js\":\"c038f82b303553d5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"74043dfaedb0a31c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/askAgent.js\":\"11c22390e2d87953\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/askedStore.js\":\"b5902c0986c2ce8c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"420f9385a0547752\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/chipState.js\":\"b98c1363721462cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2a0f8c79c8b4f0e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/index.js\":\"c379473a90dfa465\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"162d6c5404df745f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-dispatch-companion/schema.js\":\"b3625d983342f635\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4576042e20165dff\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/BridgePairingDialog.js\":\"dd99a7de7edd68b9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/addMedia.js\":\"09ff56871e3ede9e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/backlinks.js\":\"554a515d7aaa94a9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/block.js\":\"f13dd7322b310fc5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/context.js\":\"324efac46c7ebe30\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0385868cbb45f0e3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/index.js\":\"62f1cb6825f07c3c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/outline.js\":\"30b8d57af046a1ab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/properties.js\":\"328a94db4acad005\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/refs.js\":\"4e258cdd1d85f4a1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ee24213e2213a47e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/search.js\":\"6ab5f5d67c767937\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/shared.js\":\"8a57325702fc08ea\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1f7043e7b0526946\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentViews/text.js\":\"9cde42478866d11d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/agentWrites.js\":\"2825ce55767c875e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/authoringCatalog.js\":\"85b1c21bf447e5ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/blockRefTargets.js\":\"9946f88cbd2aa995\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/bridge.js\":\"d6539177815f20af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/bridgeLoop.js\":\"986ddf44fb04550e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/changeHistory.js\":\"d234af7d3b0de486\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/commands.js\":\"76f95f3cd45bfddd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/commentsCommands.js\":\"0c55bc532d0fe37b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/dataExtension.js\":\"f243410a315af179\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/dataModelGuide.js\":\"3b2fa2dcc091686d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/describeRuntime.js\":\"ddc6fb45c99b96c1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/extensionLint.js\":\"2db10a2e133c646e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/grainAudit.js\":\"e9bb08dcfdf299fa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/healthCommand.js\":\"2963b8fbe0481757\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/index.js\":\"b86777e020869d36\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/presetIdentity.js\":\"774b7c42b855b518\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1128426e44e76e68\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/readMedia.js\":\"94e20697659a79af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/schema.js\":\"c2d542f6eb4712d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/serialization.js\":\"0baa274c6698276e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/targets.js\":\"6a000c1db8cf1281\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/tokens.js\":\"15f3ac88109c0e49\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/watchEvents.js\":\"2dc8b5e822143e8d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/workspaceGuard.js\":\"83a6a16a7f106236\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/agent-runtime/writeCommands.js\":\"0eabf393affe540c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/AliasCollisionToast.js\":\"3f407d96b9d4d880\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/DuplicateNameBanner.js\":\"3068ffca61820f0f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/collisionMerge.js\":\"d99fb8eada4be7d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/dataExtension.js\":\"1123129bcdd584df\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/index.js\":\"5c82201f28852e78\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/mergeCollisionAction.js\":\"6071891b5b076649\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/pageStyling.js\":\"39cb2dc9d4675b9a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/rejectionToast.js\":\"e2ea5a08861392cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/alias/syncProcessor.js\":\"957d28105492dc60\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/actions.js\":\"e61bdae7e54b486a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/addComment.js\":\"d72e7eb95b89111a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/anchor.js\":\"d5fdda0d944dbfb0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/anchorState.js\":\"9083990800c7c6d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/commentLinks.js\":\"adf9616ba26f6a9c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/confirmThreadDeletion.js\":\"68856c19285af1ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/container.js\":\"7e72fd763c70668b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/dataExtension.js\":\"df5ee3a2fa0bce4b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/deleteComment.js\":\"d8146c9604ce9428\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/highlights.js\":\"ca5e9432a26b2a52\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/index.js\":\"baa6203c74213499\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/linkedCommentsPill.js\":\"d66b36b51d061c52\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/margin.js\":\"15c537783d8c7011\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/marginSchema.js\":\"621d179d36de4dde\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/newComment.js\":\"f7c1b8bb3c9a2c29\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/ownThreadPicker.js\":\"f317140ca61b8ff5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/placement.js\":\"04872678db24f717\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/queries.js\":\"d6e4ba1adf08e88c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotePosition.js\":\"3358ec16ce24a01b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotedIn.js\":\"0c5948bb1aece57e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/quotedRange.js\":\"5a0234a48661f56f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/rangeRefs.js\":\"ee93aa3994225970\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readHighlights.js\":\"240984b3eba8c3d0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readSelection.js\":\"8a7d16f4eb9a050f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/readSelectionUi.js\":\"995df01e19607654\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/reanchor.js\":\"4b4924bf6fd000be\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/schema.js\":\"5d94233e9906c03c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/scope.js\":\"6ba53c0996a0cd0b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/scopeThreads.js\":\"6447a25da510ba3e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/splitRetarget.js\":\"7ff3a7b4eed66d0e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/suggestionCard.js\":\"cb7017b78fcb9d04\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/suggestions.js\":\"fcf21a243d674974\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/summaries.js\":\"8821bcab9ca0237e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/summaryBatch.js\":\"afae5956e69d8df7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/surface.js\":\"7084b78d27bba3bd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/threadNavigation.js\":\"7094c0bfbc06836e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/threads.js\":\"dbdbc64a315f74ee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/ui.js\":\"1f8fd4341b7c74ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/annotations/uiStore.js\":\"67422be63d210aba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-intents/appIntents.js\":\"34940a213e82713e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-intents/index.js\":\"38f32a5663dedd87\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-update-prompt/index.js\":\"95295ab9c8d5a905\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/app-update-prompt/status.js\":\"98a38d145c1bc420\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"308388b6640226f8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaBlockRenderer.js\":\"0ae3cadee1cc3fb2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0139f7567627e64f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/MediaUploadReconciler.js\":\"1238ccf59c0356a9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetDownLane.js\":\"4a87fcbd6b9f95f4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetResolver.js\":\"a266893870c8d6d5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/assetUpload.js\":\"bf2a1ce9ef25737e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/attachmentCleanerIO.js\":\"bd64220d805436c6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f23a5810906f702f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/blobStore.js\":\"e7d4c8ac2028333b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/byteStore.js\":\"738ab690637714cd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/cleanerIO.js\":\"fa7cf0912d905942\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/cleanupAttachments.js\":\"b4b3c7fb80e318dd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/dataExtension.js\":\"5069300aa53cc38c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/downLane.js\":\"da28153ebdb7be13\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/index.js\":\"1d0bb2e4492b0ae0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/insertImageContribution.js\":\"ca59773cafc2a128\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/laneArming.js\":\"e23f6d88366a6824\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/laneLock.js\":\"e63c6a1f6dca3dbc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaBlock.js\":\"2326a7de77f45090\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaCapture.js\":\"2bd20a68d6c95799\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaViewers.js\":\"d94a07afc06c648e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/mediaViewersFacet.js\":\"6558ebc978f64745\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/pasteCapture.js\":\"38915a00cecf98ef\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/resolver.js\":\"693cba65ca585f1f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/retryUploadsAction.js\":\"b1e4acc35e691ed6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/storagePaths.js\":\"b9fefddeb1a508b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadDrain.js\":\"dd4f702a997b44b8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadLaneStatus.js\":\"be391e014f4d791b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadReconcile.js\":\"8e2cb671e34cdef2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadRecovery.js\":\"4a323ef572665944\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/uploadStore.js\":\"b3e63af0a66a7910\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/attachments/useAssetObjectUrl.js\":\"2eb15b2d390dd0a6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"390c6bcd117666c0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/BacklinksViewSection.js\":\"9d5fb623f648489b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/facet.js\":\"2ccd5e662bb9f360\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/index.js\":\"f362c1ace18dd675\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks-view/prop.js\":\"a92b840875d4319c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BacklinkFilters.js\":\"4c1067041c6cc5b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"629cdca27d813f2c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/BlockEntry.js\":\"cca8b704e817e57a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/LinkedReferences.js\":\"d3503360979da19c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9c803c27fb4de72b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/dailyNoteDefaults.js\":\"fba05d6efa2a964c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/dataExtension.js\":\"9d6165ff15dd2dec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/edgeExclusions.js\":\"9eb4176aff0a6546\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/filterProperty.js\":\"7c9adc05937ba07d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/index.js\":\"24b87685dc39779b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"eedee8768a7e745f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/applies.js\":\"4f9ae1cbfe643eec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/countQuery.js\":\"1fef96cfc45f04b5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9d486d6a8f6e9245\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/index.js\":\"536614f02701d6b2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"de181c69d28b07ee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/presentationInvalidation.js\":\"6d234db0220b4733\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/propertyEditorOverride.js\":\"c59f9bf0299094e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/propertyFilter.js\":\"26831838e6d2d52a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/query.js\":\"4bab96d53b7f9101\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/resolveFilter.js\":\"edb2520947f31da9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/sourceBatch.js\":\"c7ac4fe32085530c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/sources.js\":\"25644d51b7c97d44\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/useBacklinks.js\":\"5db9ae7a2a328140\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"07deac2c70056dfb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/BirthdayCelebration.js\":\"478162f8465b433b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/BirthdayOverlay.js\":\"e83940a73e4b42c8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/gate.js\":\"3a711b77bf0182d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/index.js\":\"a2da85084a87b592\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/birthday/wolfTheme.js\":\"f0a1f8212c8d60b9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/BlockDragLayer.js\":\"0b06f71d2aa12fad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/dragController.js\":\"17c097a78278ff78\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/dropTarget.js\":\"e6e065b07c9f19c5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/index.js\":\"222f08a16c2c678c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-drag/projection.js\":\"74c6ed57463c4b71\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-info/BlockMetaCard.js\":\"f6e4f0d5799dd30d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-info/index.js\":\"7d2912c91fed2207\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/AddTagDialog.js\":\"4ee33add7d738e18\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"60cd350f71b50217\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/TagNameIssueHint.js\":\"5d229b972d163f38\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/addTagAction.js\":\"c95b2fc7554a56b3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/appendTag.js\":\"f2e92eea66cf5015\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/config.js\":\"0edcf00b9a68e7bb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/dataExtension.js\":\"47ebd51c5fe43ca1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/index.js\":\"c46e63708452a912\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/block-tagging/propertyEditorOverride.js\":\"036b2b2ca722e11a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1ffd210bb5ca6b79\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"83ad0ed2ae9dbd65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/Breadcrumbs.js\":\"2666de9bdf10abc7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e5dd23fcbf439b81\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1a768e8165944002\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/index.js\":\"d98047478d93d1cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f51a27599a0d8617\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/CharacterCountItem.js\":\"d0800448f02f2f03\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b59c045f1eeec072\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/actions.js\":\"50d0980469b41665\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/blockType.js\":\"0950719676f5f9b1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/charCount.js\":\"da7ddaa67bceebfd\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/dataExtension.js\":\"44b6db0a2187b588\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/index.js\":\"e221a679313a8eca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/profiles.js\":\"e75afb5f9c7389c9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/properties.js\":\"6bb525410b046917\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/character-counter/textCounts.js\":\"3071d749d7fb95d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/colemak-keybindings/index.js\":\"d474314036ef1ce0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/CommandPalette.js\":\"9b6190bc031280dc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/HeaderItem.js\":\"0cd4f66c9e52ede1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/context.js\":\"1eea3c3980b8507e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/index.js\":\"fe6ed66199f2aadf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/selection.js\":\"3ee50d4c92543792\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/toggleStore.js\":\"e53362c92254fcde\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/command-palette/useCommandPaletteActions.js\":\"48a780137fc39adb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/ContributorBadges.js\":\"c94def1da41c185d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/author.js\":\"7d109b42c75eccea\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/codeMirrorExtensions.js\":\"404dd72d704589ae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/dataExtension.js\":\"01a36df521af8202\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/index.js\":\"9f83595ec1d89dae\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/mentionAutocomplete.js\":\"b54809c9f5ce7e94\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/processor.js\":\"76dad71f756932f2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/profiles.js\":\"3a53fbadaa945c63\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/queries.js\":\"2a4945c635d2a7d0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/contributors/schema.js\":\"25d2f0beb0fc5223\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9ab3268d7788d310\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7ab0f1e8aaa50c4b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/index.js\":\"8af4cda49e615213\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0ac93ccc8f0451e7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"15443b14ee402783\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/CalendarGrid.js\":\"3222be795ec67615\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DailyNotePicker.js\":\"92dfd342eb922815\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"860664669ba0dddb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateNavDecorator.js\":\"0d82ee7c7866dd58\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/DateScrubOverlay.js\":\"5dc67647bb965a8b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/HeaderItem.js\":\"7be31e8c7a8bd5d3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/ReschedulePicker.js\":\"f9fe919c2f3b95ca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9c8aa678585bb27d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/actions.js\":\"0fae0cd98b50cfef\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/blockDateAdapter.js\":\"47d054116fb90376\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/calendar.js\":\"1286329c58547b73\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dailyNotes.js\":\"782fcf23cdee0f8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dataExtension.js\":\"4bd613f9eefee2cf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubActions.js\":\"5ab00701f18e82e4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubGesture.js\":\"dcdaab3da406d5f1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a86d5cc724106954\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4f3be09288eab2e9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/deletionGuard.js\":\"a032d6dc259e1c47\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/dueQuery.js\":\"394045499be9d645\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/index.js\":\"8055a61d08b581a1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/landing.js\":\"1946299f55cf5873\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/localSchema.js\":\"c7e6e4f3b3233cee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/referenceDateAdapter.js\":\"f3d67b3067ccfc9d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/rescheduleAction.js\":\"c3630974d350d927\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/schema.js\":\"9f3d1edcd59c57d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/spreadBlockDates.js\":\"e9c4535f84c70e42\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/spreadDatesAction.js\":\"010beca9b557d92f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/today.js\":\"b9aa7d7113b6bef4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f13e61de81c89d5f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"495adc3aa7dc9b00\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/audit.js\":\"7c11e4594a2272e0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/auditAction.js\":\"f906609f9c9d655d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/auditRanges.js\":\"a0e950a4f160f91f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/diagnosticsSource.js\":\"dfe5ebcef7e5ac3b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/divergenceScan.js\":\"3bad42b840e2ea19\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/index.js\":\"94739d542842ebc5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6bd313427749e1c9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/referencesMirror.js\":\"851dbbae82f8a084\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/rowJson.js\":\"2886a6204aa835ac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/schedule.js\":\"819aacfc85e32946\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/data-integrity/store.js\":\"d5018f2622644468\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/action.js\":\"9f4de260adec6ab6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/index.js\":\"8887250936ce8ecc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-maintenance/plugin.js\":\"f4c5ffda7de73eee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e55b3c59dccf9c5b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/actions.js\":\"8f5f935e518801a0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/changeMarker.js\":\"50f363745dc1119e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/diagnostics.js\":\"30696c0ad4a9b054\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/fileSystemAccess.js\":\"d1478cbc3ba7439f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/filenames.js\":\"6e9cf09299d1225b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/index.js\":\"6cda0fde3d9c368f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/mirror.js\":\"0081d3b5694ec076\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/runLock.js\":\"224f90781197301e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/runtimeHealth.js\":\"e5e5b02af12cf54b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/schedule.js\":\"1547003effb52f2c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/db-mirror/store.js\":\"09c9a5946cf1df22\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/default-themes/index.js\":\"8a7e4ac65f0fce60\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/default-themes/themes.js\":\"a020fc8de431f388\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/diagnostics/facet.js\":\"67297e5488fbc287\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/diagnostics/useDiagnostics.js\":\"6472da0778f0b168\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/dismissals.js\":\"a2f567107be279da\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/index.js\":\"9dd1e33a3264a517\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/status.js\":\"a29b7186fcebfd8b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extension-prompts/store.js\":\"80aca41c7be01897\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0a0d16e857c75c66\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/ExtensionsSettings.js\":\"01ef94911635c20c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/actions.js\":\"f3cd803b6840e17f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/config.js\":\"66da85b97d39fd92\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/dataExtension.js\":\"cc02a3c68cf7126a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/effect.js\":\"8fa4232a495e15f3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/index.js\":\"cd81d7dbf9714220\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/propertyEditorOverride.js\":\"376e842b3028baab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extensions-settings/useToggleTree.js\":\"189658affb9b5a63\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/ExtractTypeDialog.js\":\"f3475e57a7757b9a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4a3d121149ecdfcf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/PropertyShapePicker.js\":\"61a7b95bcfa79962\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/action.js\":\"588f18fe4934cfa4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/extract-type/index.js\":\"f57ac3d2f99a9f73\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/FindReplaceDialog.js\":\"447a1c8bfe8f9573\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/HeaderItem.js\":\"c805ee12b7e0e7eb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/dataExtension.js\":\"ac0080f11d78ad43\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/index.js\":\"b3b64e48919e1aa1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/search.js\":\"54055ccb4cff059f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/toggleStore.js\":\"763ac250c293944c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/LocationPropertyEditor.js\":\"1f8573d428a28c06\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/MapView.js\":\"fd6b4dd2906a1c2c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/blockTypes.js\":\"17f86a163794f3d0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/codeMirrorExtensions.js\":\"0f5aac97ae7b9fd3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/createOrFindPlace.js\":\"baf0531cd0b04b17\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/currentLocation.js\":\"d1a9d4ce295480cc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/dataExtension.js\":\"b7170c16dad397e2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/geoContentDecorator.js\":\"2a300992d4cbff33\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/googlePlacesClient.js\":\"b4ef6d900559cfbe\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/index.js\":\"7f5880657840841e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/locationsPage.js\":\"165673b06a20df0d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/mapViewport.js\":\"cb5ce30ebb2b7330\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/pickCurrentLocation.js\":\"f7e61d66663d7df8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/placeAutocomplete.js\":\"c11fd8b347e7d936\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/placeNameCollision.js\":\"eecdbe08f47e62e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/properties.js\":\"9264179aeb76098d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/propertyEditorOverrides.js\":\"2875b1e0c3395ce9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/query.js\":\"aad823223484cf46\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/geo/usePlaceSearch.js\":\"b285fdd5f1b42e1c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8c26add4b522dc54\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4921d0d6dc35b5f1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"70fd7e39cfb4ca1b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/config.js\":\"1284bfbe7aad1c0d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/dataExtension.js\":\"d513c5661c82cb4c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/facet.js\":\"d6ae6ba5494d1968\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/grouping.js\":\"21a46d73c52186c4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/index.js\":\"e19c02ac054fc21a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7181209970208c59\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/query.js\":\"f8624f7517853b4f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/resolveConfig.js\":\"6995f6566b437696\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9255154ba0f460d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ddeee1a1d0d15216\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/HtmlDocumentContent.js\":\"7c04207b09bca7a7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/HtmlFrame.js\":\"1924c6fc421811ef\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/actions.js\":\"73f1d042ba1c38ed\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/blockType.js\":\"544ce3ae35892e65\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/confirmRunScripts.js\":\"8b52c8b56d33b9a4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/dataExtension.js\":\"882767f6bdf37ad3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameAnnotations.js\":\"c43f3abcd2677604\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameDocument.js\":\"ff4164d0954914d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/frameTheme.js\":\"d530a626ea6e1034\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/index.js\":\"782ffb02469cc251\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/scriptConsent.js\":\"33140e3df5f2eb85\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/sourceMap.js\":\"416eb29d7c67c486\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/html-document/useDocumentScripts.js\":\"5a4c728b8eda5b70\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/index.js\":\"7835857b9d034e47\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/record.js\":\"90e17d3bff30903c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/recordStore.js\":\"e801d364c9e0521c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/responsiveness.js\":\"7100188d772df054\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/schedule.js\":\"17f1405db2c3dfd0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/interaction-metrics/sessionContext.js\":\"63de7cb19f03fac5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fbbea7af0053c1cc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"92ded77e9bff5800\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/actions.js\":\"76f6f9dae8ebbb0c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/config.js\":\"09afd9d1ee55136d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/dataExtension.js\":\"cb4e4ae39bdd45a4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/effect.js\":\"ab5c561f55c8a8d6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/index.js\":\"a4f379d2698e0deb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/keyCapture.js\":\"92ac3633ea4be67d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/overrideStore.js\":\"4411eb578d7fe578\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dd56a20ab950a3aa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/HeaderItem.js\":\"ac481a73fc662abc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/LeftSidebar.js\":\"2029f9867e1bed54\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/actions.js\":\"aee5eaa9dd19f4b3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/facet.js\":\"a8172e51474cc564\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/index.js\":\"1dffb6c2abd32d11\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/shortcuts.js\":\"ba40c07e12c63cd7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/left-sidebar/toggleStore.js\":\"6ff9d620292502b1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/MergePicker.js\":\"6c3632a04fdded15\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/index.js\":\"21a5c98598d17f96\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/mergeAction.js\":\"8295b84f49c8bee3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/merge-blocks/strategy.js\":\"19a7b09a253eeec4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/Button.js\":\"b90b45e68a8e9ba1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"dadc3acef49ad60b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e072add115d893d1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/facet.js\":\"1344f9fe9b94123f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-bottom-nav/index.js\":\"879040071e328e36\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fcc5924ff6f882d9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2e4ebd860cd64c83\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9087470793162be1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d182cf5799db230c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/mobile-keyboard-toolbar/index.js\":\"4eebac55668e9245\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f5cf40bdd4040ac4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9f11e7ec315eb746\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/contextMenuItem.js\":\"afc8686bd337f0e8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/index.js\":\"5fc666b07c6a63f1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/moveAction.js\":\"993b2d6b2524cc3f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/moveBlocks.js\":\"f5d375fa5bc1fb40\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/move-blocks/selectionAfterMove.js\":\"d3b5ab9517d0fac1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/TutorialBanner.js\":\"2c25b745ddf663b7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/action.js\":\"d837604272fb79d8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/bannerDismissal.js\":\"39c419120d23085b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/documents/cheatSheet.js\":\"ad41d719652c9989\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/index.js\":\"e2132f29b5a04cc4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/keys.js\":\"be4bcee1825132e2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/landing.js\":\"0da37b03c73ac26a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/outline.js\":\"d209f9287c4962b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/onboarding/seed.js\":\"5396ff738313b502\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/PerfTrendDialog.js\":\"441d1f4d0706ff83\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/analyze.js\":\"729df03ed0078db3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/diagnosticsSource.js\":\"8aa74b88a19c55dc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/index.js\":\"c0a8473a60730aed\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/load.js\":\"dcc2a628f480b549\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/monitorRun.js\":\"d8ac9c8a53a26f57\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/schedule.js\":\"ff2a8fc1e6e1b573\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/series.js\":\"7455a16ce13ccc50\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/store.js\":\"51750b5c6742bb12\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/trendAction.js\":\"cd01f92d999e1822\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/perf-monitor/verdict.js\":\"b4e5692dd02c15a0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/clickToEditAction.js\":\"c3d11c34e8c60cb2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/index.js\":\"d41b5d4362aa856d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/plain-outliner/interactions.js\":\"75069d710af05e27\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8df5c189e689e6e0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/MigrationGate.js\":\"ec0e0479288d74f6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/MigrationGateDialog.js\":\"ecd9343ec7b3637e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/action.js\":\"826bd44e918978bb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/index.js\":\"448219bb175d3d69\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/localRunMessage.js\":\"78e23a94b25f16b4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/plugin.js\":\"aadad1b277c390d9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/progressReport.js\":\"cddd1e473e621dc1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/properties-migration/sweepProgress.js\":\"fb470b3ee8db16d7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/FieldRowRenderer.js\":\"761fbf83e0a8845a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/ValueRowRenderer.js\":\"38c340298e8a7922\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/actions.js\":\"e6bc0d3323f7fb25\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/autocomplete.js\":\"38b679787c51c940\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/fieldRow.js\":\"cadfa3b37bd893eb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/index.js\":\"9fd4829d3222d355\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/referenceWarning.js\":\"a17c88a618a1518c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/valueAutocomplete.js\":\"337c68cd910ea405\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/property-rows/valueSchema.js\":\"e783df4b0c7ca830\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/HeaderItem.js\":\"357a28b4e7720b46\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/QuickFind.js\":\"be34a209b837985f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/index.js\":\"e64d4f2ff4adbdfa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/recents.js\":\"f44a5e884c2efd42\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/resultItems.js\":\"eb7286f58c647a1b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/selection.js\":\"b15655be764239a0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/quick-find/toggleStore.js\":\"8357bc01f915aa81\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/HeaderItem.js\":\"c3cfdf821d3681c4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d1269da1efb538c6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/grouping.js\":\"7e47393b2fbc6aa7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/index.js\":\"6379664cc71eab5b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/recents/target.js\":\"24e3228b9d70fa8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/codeMirrorExtensions.js\":\"626754bf6c041d63\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/contentPrefill.js\":\"bd7a1dcf388d3b7a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/dataExtension.js\":\"03ae55ee4fae8868\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/index.js\":\"78f94e994aede7e5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b8a7a940c4dddab2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/invalidation.js\":\"93154e27f9a4e7b9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/localSchema.js\":\"dfae2ba8a07dfa22\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/blockrefs/index.js\":\"080ad414e90b46da\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"987b3ffa53a270a0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/index.js\":\"dd6673ffd8bc51a0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/referenceNode.js\":\"c69124ea5f54452e\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c0055ff23be9bb76\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"70b4cbc5928d08a8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/index.js\":\"9a8f74e43ff2cb2a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"784b8283e2de7ee3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6f0495c21378ea2a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/mergeRetargetProcessor.js\":\"f68c04a65bfe3fda\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/parseFence.js\":\"51ffd4b18d00d5cc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referenceParser.js\":\"384334797ea28728\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referenceProjection.js\":\"cd41126e8f9b8f55\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/referencesProcessor.js\":\"e58c80ad80e0a5fa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/renameProcessor.js\":\"86f50ac34bdd14f2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/references/spanReplacement.js\":\"730f8cb0d7e5bd74\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/htmlToOutline.js\":\"0d4826c03de48e38\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/index.js\":\"671b0090ae2b093a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b93346151c548725\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/rich-paste/pasteDecision.js\":\"23b647f30fcf7e41\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/action.js\":\"64407b17d18eccaa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/blockIds.js\":\"b8b0ca7f9ed4242a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/content.js\":\"3a998467053f1b22\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/effect.js\":\"4d1ce68bccc0cbd5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/ids.js\":\"abdf1929df492c46\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/import.js\":\"70e9421c02a8bc55\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/index.js\":\"7f3a4943b8ac763c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/plan.js\":\"42e6d52983a189aa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/plugin.js\":\"9fe4a5da86ca731f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/promotion.js\":\"3a46a2c909c86133\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/properties.js\":\"c671bda325f6f603\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/references.js\":\"b160820bf02291be\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/report.js\":\"ba6faa267f274ee7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/roamMemo.js\":\"469db192c0464957\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/runtime.js\":\"3a85b7a11a568149\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/schemaReconciliation.js\":\"38f67ce527ffc257\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/srsMarkers.js\":\"28cd02805c80f809\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/todo.js\":\"0a93bd61ab4a1cf8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/typeCandidates.js\":\"24c74fbf676f0375\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/roam-import/types.js\":\"b4493f5c122c4158\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/search-health/index.js\":\"0dc8a04688b40d01\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/search-health/store.js\":\"c4400cf80b35c161\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/HeaderItem.js\":\"522b0f36bbc5a12b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"10c017b7d54302af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/index.js\":\"8a1abf777eebda44\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/model.js\":\"b98c716e4d50d9d3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/toggleStore.js\":\"cd3b9012e4e5fc08\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/shortcut-help/useKeyInspector.js\":\"76b53b65d1b118b8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d7892cea2e7a6975\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/ShellDecorator.js\":\"200294992b9b2df8\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/actions.js\":\"080d14a70fe03e79\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1e5924a6b1270de2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/index.js\":\"c160d29a63c3d161\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/shell.js\":\"674149e77fadd071\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/surface.js\":\"c40bd4dc6f7686fb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/spatial-navigation/walker.js\":\"e4b5c8b4429c03f1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/RescheduleToast.js\":\"551aeede0682c397\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/dataExtension.js\":\"8a5d144cce12d40b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/index.js\":\"6103027ff1d07959\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/indicator.js\":\"9d75d82275a0a577\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/moveSrsState.js\":\"bd5240a7dd84fe97\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"42fe72d6cd275635\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/scheduler.js\":\"ad484fce0bf55389\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/schema.js\":\"6d36cd8c5322c28f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b1b5cfd375fb6860\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/srsClipboard.js\":\"0e0c199df566011b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ae591b7c616d6d36\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0c85d1a776478f11\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/DeckPicker.js\":\"766e0e6118a2fb8b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewControls.js\":\"9f4ceacdf5124dde\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewDeckRenderer.js\":\"dc7b4773c7e21d70\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/ReviewSession.js\":\"943b1c35eb9ed538\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/actions.js\":\"19b0297fa9cb64c0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/archive.js\":\"e5123682035232b2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/dataExtension.js\":\"6e7c2fa174ad94f7\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/deck.js\":\"7e2c2a97195c000f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/dueQuery.js\":\"600fb435acc37117\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/gradeDecision.js\":\"5bb88b352aa9ea8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/index.js\":\"a34a49bce4936193\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/keyHints.js\":\"30aa549d2474cdad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/reviewCardLayout.js\":\"cdc80d876d70ce2a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/reviewProgress.js\":\"ecb2a96d68a6be60\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/schema.js\":\"8fd1f7eca7cad9c3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/srs-review/useDueCards.js\":\"ed64e51af4fbc855\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/startup-metrics/index.js\":\"056b302c0edbb8d6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/startup-metrics/record.js\":\"352b0f22e0deeb21\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/index.js\":\"71afe3d8e9760706\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/persistenceStatus.js\":\"b27761b724ce25ac\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/storage-persistence/requestAction.js\":\"383c3c69c895d619\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/TypeChipsDecorator.js\":\"5d21ea44a896169d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/codeMirrorExtensions.js\":\"7446020010d802d4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/index.js\":\"42d8b8446a13c7ab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/supertags/typeAutocomplete.js\":\"52d0f80635b0d38a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"497b69745784aa00\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/actions.js\":\"6e3956d61678e39a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/anchor.js\":\"27ecd8c5d76d2232\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/events.js\":\"7a7c00926f198aca\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/gestureActions.js\":\"ca128583b22bab21\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/index.js\":\"4116b6ae55253351\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f6d837753b3e6b8f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/collect.js\":\"29329b4ddeaab1a3\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/index.js\":\"6ca158705e22cf5f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/sync-metrics/record.js\":\"510f1ecf52effcb6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/RejectionDialog.js\":\"cbea59ffad9ab590\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/SystemStatusHeaderItem.js\":\"608fac4ce6ab6464\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/index.js\":\"f99315a3d364fb48\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/model.js\":\"f9ae33974e1f5703\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/queueCounts.js\":\"3e4a297b963ddb00\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/rejectedHelpers.js\":\"f4dd5b7f1513f63d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/rematerializeAction.js\":\"62ac0f865c020b70\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/system-status/useHysteresis.js\":\"b969a1e5a426e5e0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/ColumnHeaders.js\":\"5dc647332f5f2b8c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/QueryUi.js\":\"85b2b1924f55bf37\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/TableLayout.js\":\"f52f7a5274b60db1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/actions.js\":\"a310c97e9d2ad98b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/cellEdits.js\":\"7b0bbacadcdca5e5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/childrenViews.js\":\"ce24d14866a21b37\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/columns.js\":\"9a9adf50a321aaeb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/controller.js\":\"620e58b20be1d5bb\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/convert.js\":\"22bbad38fe4abbd6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/dataExtension.js\":\"17824177923aa4f2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/index.js\":\"7887cfdfd4028024\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/keys.js\":\"3085bd735a08f5af\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/model.js\":\"40a5cbf199e900c9\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/navigation.js\":\"cdf4854a1d02830f\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/backfill.js\":\"883fef7516c21a0c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/completion.js\":\"1e794f4495f9bdf6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/format.js\":\"b219e0e9101fcb41\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/parse.js\":\"633f582fbefad939\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/queryValue.js\":\"748195020ed54596\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/query/source.js\":\"89af2471e595cf68\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/registry.js\":\"0352280ad1a2220a\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/rowGutter.js\":\"aad453291a950267\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/rowVerbs.js\":\"eac688f0e0be7ce0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/schema.js\":\"0b719b40beafa2ab\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/tables/sort.js\":\"9098bab4925f0ba0\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/effect.js\":\"4096697b0d536791\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/index.js\":\"260c8400d567864b\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/theme-toggle/theme.js\":\"7160f1cbaf717a55\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/actions.js\":\"eb8b03ced086abfa\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/dataExtension.js\":\"977bb4ae689cb800\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/index.js\":\"ac455c1a66b852ce\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/todo/schema.js\":\"1c14b270816e47bf\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/TouchSelectionLayer.js\":\"328f5955d3b4ff87\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/actions.js\":\"9e6b831d519f7964\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/defaultItems.js\":\"a96da4bcfa1f7be4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/facet.js\":\"20df5cb116321370\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/holdRecognizer.js\":\"028033c23c251c76\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/touch-selection/index.js\":\"a885c66053d745c1\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/UpdateIndicator.js\":\"20e6c154160fd66c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/index.js\":\"999e5a4e807cefd4\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/update-indicator/loadTimes.js\":\"6e26eb72f1a185d6\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoNotesRenderer.js\":\"16c999155a927985\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoPlayerRenderer.js\":\"a46d237c40e50f9d\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/VideoTimeStamp.js\":\"335d6451eb857c93\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/actions.js\":\"913dc778fcd191a2\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/index.js\":\"32cb2dd2c007bf08\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/markdown.js\":\"f57f881723e179ba\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/notes.js\":\"c0ba60debb9e74ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/registry.js\":\"b234cad4f862ad27\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/remark-timestamps.js\":\"acdba4a35bf5ac77\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/video-player/view.js\":\"1b5fb539a156be47\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/LinkHints.js\":\"9dbc135f7cbc49ad\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/index.js\":\"716a6e4591e4a3ee\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/model.js\":\"3a4a3bf2c63f7c6c\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-link-hints/settings.js\":\"28d473b46d468cb5\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/actions.js\":\"6a18881b47c7d653\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/index.js\":\"f52c1d481bd3c4bc\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/vim-normal-mode/interactions.js\":\"24ebb6a3311b27ec\",\"/knowledge-medium/pr-preview/pr-1859/src/plugins/workspace-header/index.js\":\"5329885a212fb491\",\"/knowledge-medium/pr-preview/pr-1859/src/registerServiceWorker.js\":\"df81f6cd11fc821c\",\"/knowledge-medium/pr-preview/pr-1859/src/requestPersistentStorage.js\":\"57fe04c77d683046\",\"/knowledge-medium/pr-preview/pr-1859/src/services/authRequestDeadline.js\":\"d98427c639b316e6\",\"/knowledge-medium/pr-preview/pr-1859/src/services/authStorage.js\":\"d8e9877b6d90dc53\",\"/knowledge-medium/pr-preview/pr-1859/src/services/powersync.js\":\"dfd1dc4ad6ab576b\",\"/knowledge-medium/pr-preview/pr-1859/src/services/supabase.js\":\"b63cb7ee5c37ba92\",\"/knowledge-medium/pr-preview/pr-1859/src/services/uploadErrorClassifier.js\":\"96b94b1ded9ec6db\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/ActiveContexts.js\":\"20305980764be3e1\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/HotkeyReconciler.js\":\"5b6728ab6b868261\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/WipeLocalDataDialog.js\":\"a1b256f3d1c07c7c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/actionDispatch.js\":\"5e6de359a52b28d4\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/actionRefItems.js\":\"5ea05384b9562880\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/applyKeybindingOverrides.js\":\"a39e89615271d987\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/blockActions.js\":\"ab920628b782f8cd\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/blockMergeGesture.js\":\"eae2fe39f9442f04\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/canonicalizeChord.js\":\"e3970c15b70e62b7\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/defaultContexts.js\":\"3e1b5295dbf56e87\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/defaultShortcuts.js\":\"880bdc5eae2ff8d2\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/effectiveActions.js\":\"b008621ef2ac2292\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/gestureAction.js\":\"fab4d451ae466d3d\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/gestureBinding.js\":\"3da235aa20e2b5e6\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/holdRegistry.js\":\"b079ab08d57fc1a8\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/keybindingConflicts.js\":\"48c42499dd25bcbb\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/keybindingOverrides.js\":\"c2ab0a2dbdd6869c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/pointerAction.js\":\"f50239df7f6b01ec\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/resolve.js\":\"dd8a4c766d547a92\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/runAction.js\":\"b5eef7f1e7850869\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/sequenceMatcher.js\":\"a2269d33700509f7\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/types.js\":\"7f1316f5414105ea\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/useActionContext.js\":\"0463c1acb363fc9c\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/useActionDiscovery.js\":\"c5c92bab98f49ee8\",\"/knowledge-medium/pr-preview/pr-1859/src/shortcuts/utils.js\":\"51ed94f806b3bfc7\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/bootStore.js\":\"420a74eba88de611\",\"/knowledge-medium/pr-preview/pr-1859/src/sw/previewDatabases.js\":\"1eac603d0795fba6\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/byteTransform.js\":\"b645a6c0e4afe836\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/attachmentCleaner.js\":\"7af265ccde127e4d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/attachmentParts.js\":\"acbaee49215303f8\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/bundleParts.js\":\"3cbc00d788e5d4f8\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/bundleRecord.js\":\"164fafa12cb999a6\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/manifest.js\":\"46ea0d485f486267\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/takeBundle.js\":\"41fef864b1e6fec0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/bundle/verifyBundle.js\":\"5df7fffa5a9a738c\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/cleaningStage.js\":\"8eb4357e7472bf48\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionKey.js\":\"dd2209b62d0f2668\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/conversionServer.js\":\"547dab5eea47be3d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/flip.js\":\"ac2b42d1fba2268d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/flipAttempts.js\":\"ef9e0cd8b634e76f\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/pages.js\":\"cab200efbd579398\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/preflight.js\":\"56dc1d6251f34ed7\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/reseal.js\":\"27700cd43a4098a9\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/runConversion.js\":\"de19d19e32ccfea9\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/runLock.js\":\"fcabb3921a35feda\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/sealing.js\":\"c888ea94d3c2e095\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/sealingStage.js\":\"6a3d66b5ae3192a4\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/stage.js\":\"327deb0735a4a23d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/conversion/verifyReseal.js\":\"760ac69b19f84dcc\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/aad.js\":\"84b0fc7ce7928f31\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/aead.js\":\"d5a6f82da05509f3\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/base32.js\":\"6775bbeddd1918c6\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/base64url.js\":\"9bbec12c7c469856\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/binaryEnvelope.js\":\"71c67bc1a919876e\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/byteAead.js\":\"193f5f340a765353\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/canary.js\":\"b83409b5ccdda2bf\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/contentHash.js\":\"506a4f9d40247d5a\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/contentKey.js\":\"3b5c74a933b382f1\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/derivedIdNamespace.js\":\"aafb44d292314df4\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/envelope.js\":\"7e63adb0cbf90611\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/hex.js\":\"f11405a62b251dc0\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/sha256Hex.js\":\"1a15723f114571eb\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/crypto/workspaceKey.js\":\"536e1594d7324805\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/conversionState.js\":\"a1412522bf1184eb\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2c35a1744b114a31\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/pastedKey.js\":\"d88cdc95155b5fdb\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fe3aeee3e490d512\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ad9af3af968f27e3\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/keyStore.js\":\"edcc7edefff87205\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/mintWorkspaceKey.js\":\"99e203559afb37d3\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/modePin.js\":\"6df51aeada4a089d\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/openWorkspaceKeys.js\":\"d020d548eb084af2\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/resolveWorkspaceEntry.js\":\"a4c086cdcc45e1e2\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/resolver.js\":\"d3cbf55a82e9e9ec\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/keys/workspaceAccess.js\":\"678890aa476171a6\",\"/knowledge-medium/pr-preview/pr-1859/src/sync/transform.js\":\"32538e3fcbe21b22\",\"/knowledge-medium/pr-preview/pr-1859/src/themeBootDefaults.js\":\"8c39fbc9d6972524\",\"/knowledge-medium/pr-preview/pr-1859/src/types.js\":\"e0f9fb3a6edfece1\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/ClientLocalSettings.js\":\"c135bdcdc3290e8b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/abortableSleep.js\":\"fda9364d5b288358\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/array.js\":\"a86278e3ac2b69c9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/backlinkAutocomplete.js\":\"a5e0217ddffa2fde\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/blockCrumbs.js\":\"80127d24ca60562a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/blockrefAutocomplete.js\":\"70c244bdea8caefb\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/cadencedIdleJob.js\":\"9c862695ba62703e\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/callbackSet.js\":\"e5a4e3881dfedb2c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/clientId.js\":\"d54d711ec3ada8e7\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/codemirror.js\":\"58fa1f9ba3549361\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/codemirrorCompletion.js\":\"00913640783e39c3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/copy.js\":\"57b6d1690137cc3c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dailyPage.js\":\"3b6f48529f397432\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dbForensics.js\":\"86a6cfbfd605ad0a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dbForensicsHooks.js\":\"bb36c3b031825874\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/deleteBlockThroughUi.js\":\"163826eef6aba165\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dialogs.js\":\"ad72b2e612a50c1b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/dom.js\":\"30158dbc043c21d0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/downloadBlob.js\":\"f5066c59f649fab2\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/exportSqliteDb.js\":\"4ea81ed7789b2158\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fileSystemAccess.js\":\"f963c2252d4cc1af\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/flipSlide.js\":\"e2e0548c7ac7d8ce\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fnv1a.js\":\"818359cdca7bfe0a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/formatBytes.js\":\"7970d78937aa99a3\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/fuzzyRank.js\":\"32e56ac3cd1ed85d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/idbKeyedStore.js\":\"d6060d44507a80c0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/idleCallbackPolyfill.js\":\"9f37448881b1db73\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/keyboardAwareScroll.js\":\"fffc7e683f177a7a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/keyboardViewport.js\":\"3a9a1f64dc5e5c83\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/lastWorkspace.js\":\"4f92af8b5f00e379\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutColumns.js\":\"c4332ff7b6de9da0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutSessionDom.js\":\"22f2fc521e51c9d4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/layoutSessionId.js\":\"0ba636f25bf2fcf4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/linkClickGestures.js\":\"0ab83135216fd4f5\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/linkTargetAutocomplete.js\":\"b19598a47d2ac193\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/localDbCorruption.js\":\"3b33c856330a8aa0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/localDbRecovery.js\":\"2077619b245357fc\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/markdownParser.js\":\"4af913d169281625\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/memoize.js\":\"dfd8fec19906ce79\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/nameFieldCommit.js\":\"0959262eb99d7b0d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/nameList.js\":\"8e6dd02f0be41c66\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/navigation.js\":\"1b4d19156282b13a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/omnilinerNamespace.js\":\"b7a604a3bd17295a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/opfsPageScan.js\":\"13d273c8c35f911a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelClearance.js\":\"9336127227a8dca6\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelHistory.js\":\"15cdd3e7302feddb\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelLanes.js\":\"3e21274cbdcdd776\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelLayoutProjection.js\":\"11d70f0dde6b3d17\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelScrollAnchor.js\":\"aa33b07385bfa059\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/panelUrlFlags.js\":\"f6e47ffdab5aeb3f\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/platform.js\":\"42a2aeadf3d7333a\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/pluralize.js\":\"a5c3692945c87ed0\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyCreation.js\":\"91e6813d064106aa\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyNavigation.js\":\"54aaa2e15b81e1c2\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/propertyValueContext.js\":\"260da3754653d668\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/react.js\":\"32f52b79b11059da\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/relativeDate.js\":\"c18b5ef48fef59c2\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/relativeTime.js\":\"5c903d458761e293\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/renderScope.js\":\"b757dd87c9727b70\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/resolvedThenable.js\":\"a222f7748dc0999c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/routing.js\":\"d47f207e01b81f46\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/safeMode.js\":\"7800c5a42a5f6263\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/scheduleIdle.js\":\"33fffd70adf534bd\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/screenWakeLock.js\":\"d9fe9d68e2268768\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/selection.js\":\"8da70d27973b0ca2\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/softKeyboardGrab.js\":\"a1e2a0a1b791f7b9\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/startupTimeline.js\":\"e69b9381a1469804\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/state.js\":\"25765a12d85daf95\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/string.js\":\"8f645d9e96c6ee2d\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/surfaceZoom.js\":\"459daa00e92a6b18\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/time.js\":\"948f4fba54a1126c\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/toast.js\":\"0702ea11b760ab1b\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/toggleStore.js\":\"e9fa7cea863ace48\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/untilStopped.js\":\"84249553b1640a54\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/userActivity.js\":\"c0d32f0500001df4\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/viewTransition.js\":\"00e494fb5410bc81\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/viewport.js\":\"579d516063592e93\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/webLock.js\":\"7fc3d1ae2aa63119\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/workspaceRecovery.js\":\"2c64fa22eb965cc2\",\"/knowledge-medium/pr-preview/pr-1859/src/utils/workspaceSnapshotStore.js\":\"632eed003279243c\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-compiler-runtime.js\":\"ed8dd888cb27156b\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-client.js\":\"6a0aba940ab37084\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-server-edge.js\":\"df1804ae0eca2b49\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-server.js\":\"44e0af8935c8ed0c\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-static-edge.js\":\"36ee63541a2349c6\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-static.js\":\"b00efa34f619a00a\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom-test-utils.js\":\"71a7eb4d80fd4b89\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-dom.js\":\"bb1b0aee3ab2da8f\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react-jsx-runtime.js\":\"1122aadd1ada1c6f\",\"/knowledge-medium/pr-preview/pr-1859/src/vendor/react.js\":\"96122300e5683911\",\"/knowledge-medium/pr-preview/pr-1859/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1859/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1859/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
