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
		buildId: "7b0a25f938cd-f57d30a1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"04c509218202d47b\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"04c509218202d47b\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-BaJP_-qR.js\":\"cc82d06dd8888de8\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"a61078866ee69541\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-S1-olxmo.js\":\"6615539cdc3b16cb\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-DBqMJ_1L.js\":\"a4708597df287d9e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-BnAgeQwh.js\":\"952ee38d790b09f2\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-CTllvPED.js\":\"5c835bca622e9a6c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-mvta5gb2.js\":\"4e73dba7896ffe32\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-DTJ5OvqZ.js\":\"0d467d613924426e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-wU6nRybw.js\":\"d851ef01673ab822\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-DT9EyvAv.js\":\"a92f980f89ef11aa\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BrReXRup.js\":\"81479bb15bb6c3b9\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BTS1XSgc.js\":\"b7a436d822e21018\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BnInjlPK.js\":\"9344d03b7bab8bf0\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-C-7f2NVo.js\":\"d0357c595633b61c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CY8BXyi5.js\":\"0f9ea899be6338bc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DTtCoslr.js\":\"347d89bdfb47e239\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-Dw1yTcnb.js\":\"98644f174e570630\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-MVi1Brig.js\":\"52c5d390128f1cdb\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-RB1VTZO8.js\":\"2b5b94859a02b2e5\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-C8O0YB6t.js\":\"d56480c9fcad4dd2\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-BUpxZs-N.js\":\"4dfb94d850b3d94c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-Gq3ZzdWO.js\":\"69124900af414c5f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-CnktxOua.js\":\"b8b788b199503a90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-BJzyfp8I.js\":\"a4789dc12e7acecd\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-Dv3rR--s.js\":\"0da996a081ae467f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"f49a1708c2eb3681\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"da14364868f0d1ea\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"40a7eeefba6e8df7\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"4f735ea299f96772\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"dd64b6bf32d1c7f9\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"1831ba5f41580e4b\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"121ab7ecc7531f3e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"d330ec8537ae242c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"bbbdbc3a633e9ba2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"770ba8f9262f6d24\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"4c44ea67bb9ad265\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"133ae68904de9a30\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"d4f69e69d93baa91\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"97e652e43be21815\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"ec6e6ef825497e59\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"b3247d5b25322cc5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"aa2241c22af99b0b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"0b0a2e24f78a3aae\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"e49a6166bf55dda9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"bfaaa43a6b7dde3b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"1875f8994b107693\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"887347675fe62beb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"84c8e144b8ce6dbb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"adb6d3629647ff8a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"74156bbaf794b892\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"a085a5538f19b24b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"ef57f1129e5d417b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"f38845af5565e479\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"9f1c4f2f67a1149f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"32ee5bc1614494c1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"7e437f031cbe4f03\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"533a7f4d2615c180\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"0be8acf95d43497d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"bdbcd3053a4658a6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"3161308a02cb761e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"832806ad3dce490c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"43c36d615d3616be\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"66d0766a08185c8e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"c5d8fa93693bca4f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"f0dbb35b1b0319d7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"e7f70204aff80691\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"8dc578bf1693287c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8c1d950154ca9046\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"ca742bb872305b80\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"aba0e522629f0437\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"72a873aa1a6cda75\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"a84025163aedf3b0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"44816534d8f6ffe9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"583f4ba3261500e9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"ee484a05916ed18d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"1365aa954576aab6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"330776357fdbe24e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"a7afa3e9e102dc84\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"c862cc487bda1c4c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"30d6e8bfde6342e7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"9e68e3e82f9c5475\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"bdc9986fac253b32\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"856dc6c22aecf061\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"ec017a52a30a46a8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a50c6970a932d28f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"e1ae84c2dfe9960b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"806795ab91037f61\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"426ba85af7e1b86d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"baabe37925693a0a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"431bb64eabef14a4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"b69e4b97f58c8d63\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"0f591f8fd4c3ff58\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"52949226de759f35\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"89760be1a2b902f7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"08c658cc1a7d852c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"9a6ba4a5f556b7c1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"cd484747d598a843\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"43ba4a4e5a493573\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"e7bd51cd155733fe\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"b7aebafe4521bc18\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"16bb29cb43d6d0e1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"2688c7dc19888ae7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"fbcd45bfeee64b7f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"999d2de48143ec67\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"91a9752cdfa187a7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"e585881050c628a2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"0d29c07dda83e77a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"fa28550a2a9bf1f3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"185b59c1df83f427\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"fbe541bba39807a3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"5d6e398c1cb64ce7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"9f9b9b47a3e6ab2a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"ae18b11565e93e5b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"8e7d8f7241639c36\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"79889da07b757c43\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"3b9a8b87139405e0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"c37d91319e7fe1cf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"0817d635a034d4b0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"724bcfd1b1d4aa79\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"4f10732f3819044e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"e67911941354b5b1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"1d4bb425ffe93e81\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"dbaf69f4803fea47\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"855e318c2505d85b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"0a6af3a25454c570\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"d3d05df2a910fe89\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"a675cbcf2568d016\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"cff5c43c34c7f397\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"fa76f4a910a5b782\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"3ca6f9c1655d32fc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"15bf36069eab6336\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"1f337d9904a8624f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"6dfa556551e36eb7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"72773e6d2057d143\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"373f476bea131a1f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3fa5b5e78384dce2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"30fe969322fb65c8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"5c00ce7facae41bf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"1b180171be360f24\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"91df775bef58b6e0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"e9cf84a0125d4844\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"e1a983842d4fa4b8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"2f5ec220f13be45a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"03498f448531ec94\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"3e572ec6ffbbb76b\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"25b9022dbefd6b11\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"5ce8e5402229e872\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"81112506ed1891fe\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"83f98a30da42ad66\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"eccc42ab862ef9cd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"afa711f0324e6082\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"5456a56db5e5e577\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"877a788135415253\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"f529d24a246f9053\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"07fab7ab96ca4a05\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"1cfa361c517571a3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"216acfe07dd1b575\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"2c0274aafa13c2a1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"8ebe756b5031dd0f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"3da452f0cbf3d5a8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"b2f12e0396063d7a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"7a939df7ca3815d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"1fa0ee10f62c1fa6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"5609a701b00e75cc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"0dc5a451d3b19b69\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"8ebe756b5031dd0f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"8ebe756b5031dd0f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"80043be71ba0e564\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"9b50900b3da7c113\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"3a886b3e92f99a22\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"93639add22a1cbf8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"2b976be2e1e26083\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"2250ab3ff88f7f19\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"0ac9772e37db2b4d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"18de771eb16da1ef\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"d97769d7a8730f53\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"89a3212cf2d222d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"83ba76d94a087127\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"7173064f0f35a650\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"b9f126e92d3813e8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/childrenView.js\":\"9b86e1c89566b5e6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"9d7d99d153d9538e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"3b4ff940545ad1f0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"e169e7a7234a5ef8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"ffd44f05398a4b69\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"d9dd5c2544a2f09b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"4681a2a5e057c27f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"c195892db6686a6a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"d1d017114b306da8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"a737dd45ebd15662\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"896525a1062ab835\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"d553afcb90ae3770\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"b3fd55e066348ed5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"b89b512b93dc57a4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"aaef5fb7abc6b912\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"ba9c74671cf8173c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"8286b23b58d17b42\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"4187b889288975e3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"b8361e6ec5a1ca90\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"8ab3fdd4da2009ee\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"192c149be746ae2b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"2e8824a45284d6d8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"207a6b614edf9f09\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"999156ea5d1ce39a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"46560fcda6dfefb2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"991c0a4cd1b520d1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"fe51227f0ee70fcd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"2920b12d8b91b701\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"8a0267c667186ac1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"e612783ef6fffbd0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"504a34ea532348b1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"ee41d6f518609b2a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"7190fe3b285a7601\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2063b41786ef5f2d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"df5357fdc3e72b02\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"3224410b0de44c62\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"38fa4ec72dacc13d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"9b4c2902e5515087\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"51c324ca1cadc810\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"22a7e352c5029c91\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"73846424bede13ec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"243729b233be636f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"29f72812d38632ac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"0e06e5f1db7580ba\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"04c486d52f16f674\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0d19e650de23c0f2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"f3968b3f82a04d08\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"35cab825f90ec1dc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"571a0caa5f7b36ad\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"5df2e13a93e8b7d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"9dfee1a7ea9293fa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"18ce069325577e1f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"454f68a507e78a85\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"0640351abb4a6c54\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"6a58f410f69295b2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"aff919f8d63b68bf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"4a5c2a6fb8b5576a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"4010fa4c31256d1e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"d32e1d314785bfb8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"2d15697b4ff5f18c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"4ddc01acc7f61979\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"bb5283c4854c355d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"701112ee1c3bdd7a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"55f04d6f6758df09\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"0a610f4e3064311e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"c422b4c922ee955a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"b2976b18a3c4fb9d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"7686a28f4183c204\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"2282d1a8dc6af151\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"b97604b0b8669db5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"59baf57071b5a188\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"4d92df49cb19ba4a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"80dcc282b90c0aef\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"7b4a96cd31a78a35\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"5a336c33d7b0302a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"5951f9433d9dab97\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"4cebe721904e265a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"acdd1ce49f06139f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"a1781d0a1e7d0f71\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"6264b40f97a829ee\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"57da1b398f279541\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"f0cfacad94d26c47\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"94c69f07fcaedc4d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"449b93537a235bde\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"fe6c5c2a3609efe2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"9cd8bdfd9a683bcc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"d40702045c0b646c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"ee3369f43cacaba5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"ca8a754d33ee1066\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"28bfeadae209ac89\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"e897ccccb5761a90\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"87cc26d662f9f109\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"3543bb2e6b4bfbc2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"608ca7a7c1e5b1a8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"1af6825dbc77bc19\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"e9ac1a64266a1b9d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"068a2f3612313eb7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"cb6116cb2b9505f3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"50ed7de8f21cd5b4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"fc1752ade26303c6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"5376d5aa1582f2ce\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"5acc232bb8edd353\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"c14c87a67661c436\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"ee1210b037d8d27f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"d3c9411413645610\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"c6e2ba6d537db60b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"f83396d05d2bbe4d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"14263ab02b874999\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"61e9f3f382667457\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"9868b197f2a84b00\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"dd80ecda769243c2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"45f0fc44ab945bda\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"4aab306538b39ce7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"23f4662431ca8c96\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"bfda4fd1f53ad23f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"5cc8d43eda219ffc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"6889c47035c6e5c0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"f0fab3541278d549\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"6586353bb8d7964b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"89b07dfb28bade00\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"2f61094162b850a9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"798fb3f2a460b9fb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"0bb362a988229f03\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"d8cfe660f80e2ae9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"10efb9d96eb1df85\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"57613fd2609a6750\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"0e41628845d49f1b\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"d45df1c37451e31a\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"471393c33e545502\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"4afc970f0233ffbb\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"4d8c3ff46443abd8\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"117e62e147fb341d\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"b2a64efb116ab302\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"a289fdf9c032a84d\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"d6748de98ec59264\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"480a5ff5cb3469b9\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"cb0dd542c7b6d409\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"166c05d8832e6092\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"60562e2a9d46a3fa\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"cddcd9714b729262\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"2c3d165ed8ddc261\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"18396ea9a60e9432\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"6171b96f7312c034\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"d9b9cdc759997830\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"0964f8045a882233\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"5f26e0db51e02b85\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"65cc7ce434b1eb03\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"de84aec355c1dc1d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"d7b0984703865829\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"9008cbca10c448f3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"09725f3e04586b32\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"24f77b6ee8a9f383\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"4e4ceb200bfbab0a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"411d269c583dca8f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"f04baa15613ed7ec\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"aee185e5c7b68556\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"09610a161f246ac3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"68919d21a7f53cf0\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"07c7068e7603cb88\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"1e2cb3db12b827c5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"1be3175bb32ac7d9\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"34e0d6762d60658b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"85c825dde1f33bf6\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"c58868f118bc4dc5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"f26ad76c561ab155\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"4dd6f0cb90ead32e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"5d19a0227e28fefb\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"2a1c99ed55fd3d42\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"cf7f13fd42376423\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"9a5394ab499b7235\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"47793dedd4cb3ee5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"0d3e1efc0cc8d1b6\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"05c4daef8e124805\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"7052157101bcc524\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"c17b1488887c4681\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"c5201f1a6933dbc8\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"d8311fb4293690dc\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"fd364796edc0a79c\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"ffc197702f4fa2dc\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"8ed674c774f571b5\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"c7ef48a012dc4ed4\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"d6471d1eef4c1a3d\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"6673a9725783efd1\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"4b3912ddc8c12f20\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"5f414ae896d5c46e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"48dc1250beffd08f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"3bb93ed32c8aa71c\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"0f0cff362574c314\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"5b9abcc238da72e0\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"22375bbfb53f0489\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"62061eb1779dcbd7\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"0b5d3d23a5428a4c\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"0921d0d7e956b52f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"4ed2ecd33681e94b\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"2ecb33a1f2b669d2\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"bf2bc0c733db7e44\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"6e3139c993d40ccf\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"274ce47d27fc5ffe\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"0d607bcac6d09687\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"cd06f5a655cbf336\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"9e86c90c2ed1c25d\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"b142d07bef0d8910\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"931822c989ad6bed\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"029c97fc019e28d8\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"ab80ba8d2dae254b\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"fa9b813fac1c4219\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"82997bb9f2e0a2d2\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"93d5318434434851\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"41001d2f25f628ac\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"bbb8202a4bdbdcd4\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"88306f1771d49d54\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"61695653bfa0a65b\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"7390b099214db115\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"387927b38294f033\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"cb22c50f36bff235\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"09c77cff20a27a6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e2a5c33cb385ab48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"e7bfd463e537bc5a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"064ccb7539b8c114\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1cf2bad8c66bb632\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"db2a7dde43552059\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5d28e2740f437465\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"dea5453053d05230\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"41d5120454c9a8a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"3c375cc069f74b81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"585d948aa249cbc9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6e8820a41427b6bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"983b62f76a87a1a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0ca1795dcd2e7a44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"6a6d9c46c0b33790\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"f359fdeafe585f19\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b70af5c7fd736b25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"720b04a9ece8605c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"ac3281d6772cb038\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"cfbef0e425d981a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"b8c3fe7fb5ac7efe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4dbd27c9926e2ef0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"545ead3df991279d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"53119b4010ad4253\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6954a4cf440d6671\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"ad5135c283c7ad2f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"59241100d46e3f23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"4043f69d25a6b9a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"a19c40075b9b4a3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"dc08d2e5ce6b4b6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"d8d3441d045fa21e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"15d7632adb9a18c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"3e33dcd89a8ccdc3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"b7550e921224b598\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"80c706ffdafd8f67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"e59d1fc79832fc2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"b9403816aa9144d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"1b88808d09b08da6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"f70d95131b19c3ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"ca637a4948000bd4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"8590a5a1d2265ff0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"0adaae8957c7cb10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"eff8f2e23444ceeb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"38ccdadd6c3513f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"4bc010b25835627c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"f01a1cfc3a4be84e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"fa02cd70e691eb4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"fc97be32e903c1f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"aaa36542d8c6e83d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"367b92b35cf58143\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"f585872c8dabe3af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"6223d803efebd58d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"501cea0d95f2cb30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"7daa558d053c2c5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"8bc55583f02650e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"a2558fe898183a46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"d144bcada47fbcf2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"211dcff825ede0a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"35107dde91b25199\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"f7a9a81ac6f61db2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"cb0609e31e3a64c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"b6e087ee335760d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"ffa4e6ce873c5b38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"934261bf17a2f2c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"c1e061d3a1587f0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"86855bca9a0bbb1f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"63cea1de17d8dcdd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"32bbdba660ed4257\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"15d66fa79bb6bc8d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"8d12cc3426a2f2ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"59a7b8aa4099df10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"64045cffe45250e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"2ae4dfc91b89e65b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"4fc156e6b6a56b34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"1ecd29b77f5628a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"8da2440ad44fc4cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"ddd2389b678acea9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"696cafc357aa237c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"e9a0ee14214faf21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"b8b6b5d0b3846d21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"14a9eb4ba2b5dc40\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"05ae7b2cf1723ea2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"4521725ee5bafbcc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"f45f18c211c89dff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"2aab55461dd58d5a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"75a23745d320890b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"086f15f5a17c7be8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"f6da4909afdb2f9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"c411e1f37e6d0364\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"dac0338d285c16de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"7559cdb0a594a74c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"5161944086af3a69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"2b15e61d6a8cd092\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"7f471b09a437f58f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"1a3979cef370c6f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"933e55fd07d2d9a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"2d658867234ca62a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"56675b08d91b09df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"e5e9de3d52e8ef20\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"da4f5e4017b7c84a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"f2f519aec68c0df8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"810b4ce7050ba794\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"ec1da4663a7a670d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2bd814a3d8145a1b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"ee91796b88d92034\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bba1cb5686422cd7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"26a099a4c34ac273\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"82f107ccdd61e4de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"07c50578d512f04d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"405aaba8fa72fc05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"5f32b06270f83deb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d940157df8a8bf4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"66fe81fbae737b58\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/browserMedia.js\":\"2630ca7949bcb08d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"739e484ecc2acbdf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"7d48de33f427d442\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"dc4123193714e713\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"11c8eeb89a30cc90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"5a01694c2d536717\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"02d92c091c2c562c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"26a3a0b871d48548\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"0543a842f4810dd1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"c4f8579ab9316290\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"5a2f7de0b74b758f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"c015b228efdfb638\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"0e03825393815206\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"c609b36b81134204\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"cff6065a84e57ab8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"43bc57c00a4ef962\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"ea57ecc480995054\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"dc8e8154a24dd9cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"f4835f1e27aaded2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"05bb480d155ae270\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"a23dc97079787f37\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"4a6273f870b130f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"4fa04e5d9041bfa6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"244a40c51db1f4c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"de2a5494c9b907d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"53a5d422ccf75276\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ec6e3a892a8a3966\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"313b05b440d5e84d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"85786c4f0b9dff35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"3021c051a21ebeee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"5124325a9cb42e56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"da49c3d0eeb9cb96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"d71cda864443291b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"d3cc1ccbc8fd9a04\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"73acd108ba4aad09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"410af95f4c45f17d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"1e22d3788e615b0b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"c1196f7c7abbc1a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"9e05ed73736ec5ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"6560802480445e01\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0d42fd0754d0db33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"c3fefd89005d08cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"f056f263eb5c9020\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1971cf7113ddd052\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"52625363187b5ea4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"35d42578c78a07c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"216ae48a101c3edd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"5b20a784123fb03b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"b247d0f7dfccffab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"651823f0bda1dbe7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"8965fa5a212ab1bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"4b580b8f602c5b94\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"0a558a525179fdff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"ef898db821afb309\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"80abeb7cbdf63bec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"1f335830558f6539\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"d4f59bce21a96b92\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"caec7a1aab9c7fc2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"8db599506b1b866a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"c2e7e3d667f3d79f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"d0a37b2570721b2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"d72538ac7fc1cec3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"1f55c4f5f710c1f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"1e07f2edb98f8ac4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"64d5d7dd24a85f82\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"e002ffceb9815d19\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"4765b777e26c5e10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"b0d0619daaf0a0e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"82abb68d4bde74b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"70fe74cedab05c18\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"ccd320dadbc18bf5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"d9ff228dff40dc91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"0f30ed7f0def6adb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"f08198210529009d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"530eb459af9c5f22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"52ff1c5f1bed2e88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7842220faf34b1fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c03aa3f47f8e55de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1da22f51efc5d0bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2d05f6b5eba1400f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7b4030436a8cf92a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"144daaa56408b342\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1a5d6d5d667d697e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"16ce1214cc059c3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"19adeb8492a4b6e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"38f90ea5c8780b01\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"d1868d1401a6752e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"03752d68816527ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"15ef4fc2dc33736b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"d390d5801f4157c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"e1dc633404c51695\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"d2edc8246bb2bfac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"bc1bcad29d9b3f66\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"3ded2d60367c8185\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"8d6cd2b222d8235b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"c29974496e058215\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"ef4569829265c4a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"a905ffb236ab2d56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"cd27a4fdc36cd880\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"3d66def38d3bf69b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"cdd28debbec2eedd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"204d0c3a09959576\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"c8ee52f3ca8338b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"c3a5581231a6fb99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"8b5fac38ea631aa3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"fad8c5ab0fde2f3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"2750b333760c8e2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"4342943be12523e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"329316941bb2845e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"f62b3b08cfe90f64\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"b51e401fc810a95f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b8d51785b5289f8f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9aff9b0389455e38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"104bbd8fa15cf260\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4712872fdc45425f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"ff16a0010193cbe3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"4a5115f4bcd2397b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"bfeea1057d3f4199\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fa216396325b190d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"db84ef218affc969\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"53ace9cc859c7806\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"cd616442cda0947a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"8dbdd53d98f7a3cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3b1ee8b6e0164cf8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"616ec85920f881d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"57208a205becc246\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"eb21670cdd323288\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"d0e43960108e7f3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"e4aaf38c113116a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"97d435d939750a97\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"af0224d3c23087c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"013fe7c2a4f333c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3598c2a0747cf173\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"615a44f5eb4e45c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"9d1eda31b946aa59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"4da0fd803a80a15e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"66baaa88ce7286d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"da28aff41466c494\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"3faf944e30a11eba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"3ecd3735ead2d720\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"195c44779b15f687\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"3befe2170ab3dcad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"b690f34a1cc6318c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"a4ffa524babb2d2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8a5a2a88b25b71e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"321110dac798815e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"1d20e33c85463766\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"dea1173077ba19ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"fe7fbe0a5fa64e4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"8caba681167ad666\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"fe3c73f1bec551b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"d4076a44239ba996\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dd8c42120b5b7e44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"2c9252d228a9824a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"4aec7796b9a57a3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"6914496ea97a1229\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"06f93fe790ebdb54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"1426cd94dba6ebc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"8fceb27b09a924f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"316fdf70133bfc1a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"097c061194579403\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"39b0d617f66e1c33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"9dfe488c0295850f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"387c7206b432d9c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"a9d3d86bd9f38249\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"1960147db18804c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"f60ea89ddce5e94b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"ef966d2c5cfdb907\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"5fb01d182e55b37c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"076788389a4fa03d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"0ffbb3957a430395\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"d42d0973684d15c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"9a9ee5e047b8f4a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"84a5975a2a5d4999\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"08db528f5905e2a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"0494f5f6a04ce545\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"509cdf11758f0c9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"af4155f7aef8dcc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"9c5df6407024c0a7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"f91b164e340cf207\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e1e32c5646ccf7ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a5413823b7b59280\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"f3e6f942c3d1631e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"8db92ff60cbd878d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"b3151d5fad6355e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"1bbbd511ac756987\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"e171dd6aa99aa5bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5f91f7e72ced5c04\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"d45ea6ae4e06ed69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"547596ef4d2cdfda\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ecfc662d386fadd3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"ea7db79ff2209eeb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"c4568ace3a9a4a6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"7cd49e1f8f4e6c03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"962730b1b9b990b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"52955d8115f5a9fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"a2f9e1ff18321a5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"b3d784403d9732f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"3b3cf4f28326e725\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"85bce3ff151b2c6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"9e9901a7d65ca856\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"f04fa70501f3c464\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"d51a7536fcfe4f3e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"11a346704928d281\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"b078919067b06d76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"0465f81590f138dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"1d35ddf78338cb7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"cb337da36c8571e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"defa8c2389eb6613\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"66cf919f6a72ee15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"df21899fa3fbe56c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"df61551c7487b51a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"13f13139dbf93a49\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"7f18501d783b579e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"e0c8047ee0413661\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"33a81aa1f3fbf124\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"9ba845b878731ab9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"89aa6e6c443a58da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"7f0f352304647fa2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e2f4df432c66b074\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d2f7623c5f92ba85\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b33be911f9ee6f01\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"23e9340d6a83655c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"f250d5718db0db89\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"3cb31bfee397858d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"9afe972a27c1815f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"eb7211eda35fb059\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"54c22bceb324892f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"dde1d2b25171b10e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"a1b27ebd4bc4fc66\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"269d9edf7b25336e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"acb225e93ac99dc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"43bcac9098ede552\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"4875a12a86b713de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"82db2027aeda930e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"292a478a2a835203\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"795bfff6b0058a03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"29c49b95d133cd26\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"1bafcda88cebead3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"1c1beadefa082f8c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"16e2a18e2d513a5a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"b7d6ee19c85ca61c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"24bdcf0eb9e53c69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"4512bda5d33e99fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"f21227568750441a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"35ab014603a46a27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"6077e3223beb7b2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"df838b890b9f9466\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"942ae9b7d95c2d8c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"d825868560987804\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"44d5f434e2219caf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"21edc815021ac3f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"22e6b9510faca48f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"6f4301ac117fe1f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"6d202d5e00fca48d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"85e705fa9c1f7112\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"0a4ab36dc17d4d56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"b6751c3ee25b8559\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"07ae760a68df0b68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"841aebaffc217952\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"443e565091072502\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"74f7a02851d528d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"b02c86b63b3239cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"88700a8dfcfe3f95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"b6a5450c4f08e297\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"760a7b202200000e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"44e8c7841c7b5099\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"adf83d3cbc05d70c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"00333460d2a0e190\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"f298546465bc9b51\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"0fba3951979301e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"8a1408baa17e1f9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"1bb4fce2d53645cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"37c0994c3732bb01\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6e9335dbb36cd205\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"1259c1b50251b492\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"c61e035e20265e43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"941db97a7b578815\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"fe95752659b025a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"76970f4308df30fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"82ad1430ee118e47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"9274eabdb9112ce6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4e79a025d0727795\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ebb94fc7c978b386\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"540d8d4b48060981\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"5e794bb07dc5b49f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"f2eff7d935b11329\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"a74d9aa283c8da68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"e34ebbdf158a3d07\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"75afca7ea7adc670\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"e03af41a73b41709\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"b5257733215f4108\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"ab93ceaa71c22a98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"e16a03a6af443b12\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"908a76e1baf870a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"a898f38ccb11223f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"913f586f2e584b76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"10dfd0078e1cc1a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"06f0f5b8d0c26289\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"fbb818bbf2db4288\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"5b1f04e7e802b3b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"1e4abf8baac369b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"c44ee4b20ee42942\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"16a1cbadd77aa648\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"401d64db812949c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"948fc8302cd964d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"072916a43feb3ba0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"203277ffa9188875\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"9a8096c1d7c5ed09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"de58864614478870\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"a0f7c24b55da8ff6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"a381dea56b51271c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f32e7005df7f1e1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"4bd66c787a929269\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"1fe3d7b4d8fe3d51\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"d20e0c657def9b12\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"ffd3ea93499947ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"8a9f457c3fae0e05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"ca7965a80363e896\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"181cf0a415797b2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"8abdac6f60e51a6e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"8fe1b01d66776e1c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"be9da1cc16e60678\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"7b6ab2aa0099f734\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"fadc3121852b2796\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"6b385cfc24bb1914\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"e71b50975d2b891d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"605b9542a851c73c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"b3f80d8e5e3367f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"07ca9f24cb69b402\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"f5c4cb9303d200d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"7705b283fbb0b6a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"6f89e2dddb8e5d82\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"d0a0082bd04adc0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"dbbb06ecc9e80228\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"447e80b13c710fc2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"a7df27efa541f891\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"d3c33dec71898591\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"76dafe4c5a6567a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"e20b90953714696c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"508e5dd162f15821\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"908625e425cf5bb0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"10b2d8bbfeb68113\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"0efe10c9f130113e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"fddb8b7cf3a998ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"997956e017558b4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"140c32248d26dac9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"0528ec156cce3bb4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"274a25176e06f937\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"9890d7bda3efa5cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d7ae324ee2459c1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"da4d778cfea4f5fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"0f9013d63284ee63\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5732909d81b77645\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"86572aab664c2970\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"480c9cf3b094a2f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bb805975c1e2ce90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"98eaca36cd7d0952\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"4e70dc7f7fcf0c6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"4b6f5c5e4ba7aa5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"fb291571e75f9e05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"21b99f06ae196dde\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"53d66e80a1695aff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"81ed06f4388c1ece\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"c6a1d137a48323e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"fff8016c1b2fffdd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"270ef38ff262ea5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1e9da5dc35fe64f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"7315dfa62daee00c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"7fc7701294727596\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"0367ee35edf1994d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"063c7c2380a16bbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"c57dd8092ee6f7fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"722cb079544d59cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"2631def8d8ce5b2d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"e35e945187f16850\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"1abd05b48aa04832\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"3106f4f1dea53985\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"f5d3f1861855eace\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"90b089fe25bcd7a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"7d2f1fa08106fe6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"425a74d136616bc2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"2f443fd6add14ca7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"2f9216c8cc1f8ee5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"2e9cc428e5442ab6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"5bee7d70bb9c8a46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"9af1bce01d6ee350\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"d048ad55b51fd2e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"6793cc51bcb06883\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"76a5d3c463c7a96d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"6aaaf9a1fcbb6a44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"7ec9cb775a9f9226\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a450e90e876d254a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"fa75a3f9775efc29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"fd716fbc584d31b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"620a86b0cdc9d19f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"1eb010bfcf2866f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8f7b99aa7cc2c396\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"2a6987b20a9db248\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"5f279fbe41a24d5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e5e7c2e4f82eaf8c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"af4b3b037260c0b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"7fd244212040fce7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"470f27f678d87cc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"1dcc37a7364cdf72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dfb46886bf187130\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"b437e6b88709da87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"e8e2aea96d811ba8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"76788e791f8a3640\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"585861e4746d8f35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9ad0686c9e9798e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"2e8238d09841d78f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"200c3c015828bdb4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2776a7a3823ac1b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"de710cccb405ff8f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"77d17fe34e6bfb09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ad890b6644d18fe3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"751f3e5ab1bc0ad2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"9bae2b4c1585afb3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f97d3fd81cb55471\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"40d99212950acc6e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"10f8c9d92afd9021\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"4309a61de16d0a70\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"d53a53ebeedb82b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"2d9ff48d7dc8a965\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"3a8caf9300dee1fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"ce11af1e640f2647\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"e36c5a9602f40a55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"9d764bba0f09edea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"4f97bf298678df23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"e0f08e89781bcc03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"9e1fcdee23604fd4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"116f2cca05df109b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"a19f97a6bf769382\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"439ded8b4fa06e3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"a133983564451e7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"846fdb58849f317b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"e64e5d871670954f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"faa4947869cdfca2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"3722b8538a892d88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"9570e5e050ec6d28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"217e4cdd4147db84\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"751f2fedbd33bda2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"362134aa5698bec8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"eeebea0406a7ac1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"984be657b78aaf11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"69347f99dd221076\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"467b14c699cb32f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0ce2413d526b135b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"f0ad583b1eeb575f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"e2efd69ee7a49ce5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"850c8cb1784c89a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"5ce61c5525ef22b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b7f18ccac41c45d1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"740d7ff7f21ad40a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"d4db0caa1bcae421\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"eb9b16984714365d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"3395383d7459719d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"1002d9f894c1f2b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"da94b2e337485966\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"1bf903c741e5a453\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"620aeb3eaea5b9a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"14908a72de7c1692\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"5caefd814c1224fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"d157ffd152928dc8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"4eea55321548cda1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"9e14b92259335378\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"7aa4c833edeec1ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"ac9551feda2b4509\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"3f11c86e637832a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"766832f983d4b35d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"36d2e8ddc2c0fa22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/navigation.js\":\"8d3f18d2fc9a661b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"6c73f8b39c9be4c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"fe37455b1ea446a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"acd56afb4de5f2ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"e69da4498693db33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"085fbc92c78908b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"916b8fc669ce742f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"38f9278cd7a5f83a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"38ad378851cbfdd3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"41b709396bd9b5e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"5df7d3cac7524b2c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"3c940fa55983d46c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"b2a2eeecf1c446f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"121588956bceea93\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"75f7a588763278a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"2f73f6053b99889a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"f4bd4db906b91aa1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"3f80faaa380d6787\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"d6042f227d7091e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c4daa525eb75765c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"a60a488eddbcab00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"9f82766e02bb81e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"4a960c02b97072ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"04c96d830f8fe024\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"99c96521795fa962\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"d62f6f31b637aa2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"7c788bf1170e30c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"a1a834842939210d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"7bc2f4728436d3b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"a7299aad0645cfe1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"8f3768973547959c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"50bdd29283bd0558\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"fd887cfcf32e486c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"2746863487098c80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"70de12206dca4629\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"c75aa262a5b6b9fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"fbb7c919bc2d80c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"fa49119f78f249bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"0a09b381d6f0142f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"018a708927f9d4d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"f10be421b8c6093c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"f357b07dcce3c53c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"a1b602e8f0b270e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"d726a8feabfd39d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"9293a009d21c16cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"e192465492c91254\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"c3d6bafe19b25574\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"bbdf613abe6056f5\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"a298ad06786cf158\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"d5c52c096af8786a\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"9751b69a36569858\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"8b8a58b43ac34743\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"da748833adbb3517\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"e4c05f5bc4b4373d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"d4b1aef46f67e4d0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"03c4ba1136ab05e0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"ec33249cead54409\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"e66170d34fa6ceb1\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"74560dff32f6d837\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"13cc57d6d0f89cf5\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"98511877057b0e66\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"02acd56d9a8e20e0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"a77c9abdac5d773b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"33839e3f92bbc191\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"52a6859c27583905\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"cca0d58cae961c04\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"af56892522a8890e\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"be591ad5b3c2cd4b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"4fbe28c99c713d33\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"bffd389356b32c45\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"cfc3379d8449f020\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"ec233bee15b753b2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"77e6aae37bbed7cc\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"cb3f1d3082a40893\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"56b801a79ca568ca\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"17c2dc2f5d3e7349\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"39490088355f8fdf\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"a75787bcd93beba0\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"fc3183c88f23f864\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"591683d6058ef986\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"549079935884ddd5\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"8badff43294bea4a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"1aae8d4080f8f6a2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"5ae88e84b31efab0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"9193ab43a846c31d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"4ea58097842bdc5b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"4e7daf4a65e0fcde\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"db37b038ea1d32f8\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"b0c601cb5b3a743f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"32be022280ffb987\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"474cc315cd886168\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"5aef43ec81993e71\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"66a3b36f8cd713fd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"bfa75c7a207a6942\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"d204a7f46ca0b1c2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"58dcec383333c839\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"2d999ddcd2e30856\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"dded7e7e65255324\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"9faeb8ad6b90005a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"fe4dac637c9b670a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"fbdde3d7a39b2ebc\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"18e31f9b88c3d24a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"8d05fd3612623fc9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"c2d92640abf94d5d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"8c902a87eab573da\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"3eb7fed651a0aec1\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"a4b509f89ebea0ec\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"1b929695cccd84cf\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"7f4c554c6bdcec41\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"f97382db7f8430f3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"184ee3e0627d2119\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"f264b368547aa8ca\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"9f1f0f7e66dc0c6f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"696d51e7763574fb\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"51da1c775df7c009\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"f003c8619228f299\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"e826d4d2ca6a3c12\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d5f9336baf5bb9ea\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"afb84435dfb2dfe5\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"76d601c3f3ed8579\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6bc3bff3258aea05\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"a236199098512a5f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"06e1a2e66541b434\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"e42bcfad223823b1\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"099c97ea0764b48a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"e92f3cf0ad2f0fbb\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"442eb5095ab7fa26\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"f58aa532f99e8ee2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"6c809b37dda71773\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"fb6395e4a1cd0044\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"831575f660d5987a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"c1feb3e8135256b3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"32654e8fffa1007b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"c85d42cec7894e64\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"781f5704d75baabc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"0c9c691424ce36a1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"cbb50432e12028c6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"427283e55fa6f80d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"487b2b3129aba18f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"5974ecd0d9f4521a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"564e725f17686146\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"03c9cc8ed83f9d5d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"a1b465237a8d53c4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"dab4e39fe0363d5b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"12e080344b5f8a43\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"6ba552f12c940249\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"dfe9b6a7033f0748\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"17e94453bb6d395b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"a3e986c78ca069c0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"6f41590481b2cfc9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"567b0eefac2c8aac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"c7ce5b6d1f3d3cbe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"d4e9e923fc8a413a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"becf117713ce3687\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"9d43fb51d9467da4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"b4c16d7c9d24c5de\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"bd7051e3c3a8588d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"d433e370bcfafc99\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"7f00d236029f3164\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"89b886973dccae70\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"b442076cc6d7d1c5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"95486dd8f61a0a03\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"ad90c97eba800dbe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"5a352036f3b594a6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"64181f63b4d7f06a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"5e97cc9062286d5c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"019ce6007f6e93ed\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"52b089ac78685eab\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"4da15a15192d3cb0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"578e4c76fba19fff\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"a730522400bc3314\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"52d34c0fc34c7e73\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"39d7dd1d4c42f022\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"9ac4384ed4a13339\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"d6e58a56930d3c46\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"d2eb376a03f24535\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"35cc46c7e772c1d2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"a41ff5e8b50aa101\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"1d83e51a8baddbc2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"82a4f15fbe6627cd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"7fad057e5705a9af\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"c829903527266657\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"4fc41479d68b8c20\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"6476b2311783bc7f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"8dd0f4826a530635\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"c6921ca7f158cd67\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"17389241be3be3cc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"02fa1f37aa06c6e1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"a07551acc07d436a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"bc6c9c8e72b93f7b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"36a381fb8760b0ff\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"56960bac923e88e1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"3c3124aa46cca40c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"023d8c6341bf2223\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"bc294dd97f8035a7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"0341a85ddfd8d9ba\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"6f2197a4b872b0f4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"d50e69e346be56f8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"a52e239b7485362e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"f28b06ad8745709b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"8053169f4a523b80\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"b20d64de4d55a19d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"7e1c912d89024bab\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"fb6b52c19e69ae67\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"089032971d17dd38\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"cbf1c9431918581d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"f3925993f706dcad\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"9d00de3e6192db5d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"0fcfd6c59560bb44\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"1cd1385a00d8edcb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"cfe3ab8d12a13440\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"6aa2f4eebbb3e47e\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"0dde7369e0111aa1\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"6f931595f16c1a6c\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"a51449741744e33c\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"cdb4dce71bc9e3ad\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"b065887619f23b27\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"f5603f08c427a1cb\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"adbe2deb2edeef27\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"afd1b47de7db02be\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"a976cf96ee2dc0e2\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
