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
		buildId: "617a7d2761f2-f559a2b3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"146ad600f5f9800b\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"146ad600f5f9800b\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-DgCsu_eU.js\":\"dd6556e29be0288d\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"890f44cd20fde798\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-C5VbN2Bu.js\":\"4a375b2ed615c72e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-G_vWlCDZ.js\":\"5b574fda8f28d274\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-C5RknCHj.js\":\"c92964508751c19f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-BlFDu3zU.js\":\"7e7b71bfa39294b7\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-Dhn8errI.js\":\"baa120631764e275\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-BTyK4TIo.js\":\"d2b9fe0fc9a91693\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-MtLnmAg1.js\":\"d244d28c506cad0f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-BXny2XH_.js\":\"6a2631427f5cc84d\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BwaR-NFK.js\":\"800602627d9389dd\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react--NVJ6mJa.js\":\"69dd55b74111a20f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-8NC2OXbW.js\":\"dafc1b659c17e72f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BgB-UP7a.js\":\"e5ad8a3e15db9fc9\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CAkFBPDW.js\":\"ba9ba4a92d9d1e71\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CcgP8zZ6.js\":\"0aa3958dad74006b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DpfdaTkb.js\":\"5370d716b3e1cf3f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DuxGOEu6.js\":\"7c83b67854c1590a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-F9GQUvz1.js\":\"89578190f8df9210\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-DyI1yEca.js\":\"566e2847c6a4658e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-Cpd4WG7l.js\":\"c2a85b5a486cec92\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-CzPUcn6x.js\":\"654f78e2a9281009\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-C_mp9bfL.js\":\"409fd16bfb0e0039\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-DcWoscjP.js\":\"1421db831f391325\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-C0mvh7wM.js\":\"b653f3b437f7b35d\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"8d6165da14d4774b\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"d4f19519d91160eb\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"94fdaf2fbabf2221\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"f7b0bdae386f4f5d\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"0769b384a055f5cc\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"27038f0b9739d0a9\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"325d2b3fbfdec6c4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"d45cf2a03706fae7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"d25c97101a375cb3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"ec667e974e151b19\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"c276378b88fbd896\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"ca82240bbda22469\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"a664ab5a30ab8e31\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"465711623bf7b8d1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"d45c422e76d29e2b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"e247e6b65621ec01\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"7e02388a372fb2ec\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"4438ff9d7e0ac049\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"a6b8ca9f465a550f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"ba87f1266646ce56\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"3195c908a5c288c8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"b6645a0b6c811619\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"08780753fbf79028\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"993f9152690968d3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"fb132779d0a03856\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"c3290b17f4b96476\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"caf5c1709970ccb3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"9db683ed4f6c12cd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"cd3935e3a87c8a9e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"7cd5382c3ffe5411\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"3a44260fc2787530\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"9970731e94218f33\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"400b47cd682f6a82\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"a19854adb982becc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"f39098589fe2695f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"fda12df3d950a1fb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"14840bd80c449b33\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"fabdb18be0b80940\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"782de4eb81c860b3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"56b336593bebbfad\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"1bcf7b006f01fe37\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"1f2d873ba9bb60e8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4c3a5351b9f9f1cd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"c9965bb34b55d670\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"797b13b9133ec811\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"b1a6f3b6fe1132c8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"40843f9fa9cae4fb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"66736b96d3b41533\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"d62283b524982ebd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"dec9fbf45c5c1c4a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"1a59f8e866496a55\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"6f1bf713ae07ffb9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"9aa348848cc0c829\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"00c1f39e91eedbd1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"fecd9a1461cee0fe\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"32809a21d4c84e5b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"7f9eec2ed9eae2a8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"7230386df68e146e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"7736106cbc1ca48c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8f0fa4a16b5519dc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"d9c5cfe14c15b0dc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"47886ed1dbcf9f45\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"4dd7d21a57552ee8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"4cec7fc11b0dfacf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"fa24c9e6c73f26ab\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"b89fe846cb66a54d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"7d7f0a3c1f379a1e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7261753a0c2a1a6f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"12e79c05b5c81095\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"49debbf8e1e0468d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"8f8549b82c7fa3c6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"5629b10ccdddcecd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"c14069d9e74da629\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"c8e2cd08ea6ba19d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"39a201de7c8bbc14\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"a8a24ea5f5e658ba\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"e30e8891dcbd740b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"aeb289ba2ca1327f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"d3ff228a4335c0b1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"6be97031b36bd4f1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"dc88ee75c7fac828\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"7d6d6f0849e9fa32\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"401d315a2edc8175\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"63162d36b77768bc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"93b19b7908e4e1bf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"2d7547c72b7f409d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"284d1bb49c3c9352\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"12b3f491fb450dd3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"57aea6b727a3ba21\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"302ed983da7b1323\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"232a1e10666b4246\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"5e5da84d147a82e4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"ae12ea0f62e71db3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"ad2ddea48c1ed851\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"e65f62fce570f42b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"ceeba246679028b4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"36133cb7cc171a0e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"97ef194a339d2934\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"6a0dccb03e36e7d9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"8f5d10313d75a18e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"71a4a71800d031e8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"93332f4643ba63c9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"61bf38f196414129\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"cbfb25a19e66d303\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"f276857a9180b926\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"dc25f69e3b549ee0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"82d8d4fb56f7b8da\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"aec80c105efd6fb4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"775f2281b602fa99\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"244c9f8687045bf1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"70cb3007115573fb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"53224830577aa647\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"b00c4784320a7759\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"269a151c8d31c2d0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"7bc0b09f776d034c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"e69a51623aa766e3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"517c8a17e9cd1466\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"5924a5cd12f196ff\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"d227d6720a600dd6\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"8307eb34280344b0\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"f8e555b8168d1027\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"ccef58e51a5cf99f\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"ba5237267f3a3861\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"f4315a1ffbd1c6ae\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"396d2eec0dd64e30\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"fa63b7e0264e69e2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"cf1f7ffaf54d40ad\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"dd2c2348c5d506ba\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"d52031b1e0641720\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"68c37fbded055768\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"2f82aa0b8facd669\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"fa53942e5008cdea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"b5c929075aae9205\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"c12182497e16cda4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"29931b59ac1a1de1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"97d52d8f733a855f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"619772dd3f29b449\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"46195e8998542a81\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"3154d57e4782470c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"a3680b736d17e5f8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"c12182497e16cda4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"c12182497e16cda4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"6889a9c65b28b674\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"535707c6d3a0677d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"a3e63d3c97fcaf49\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"6ef6cc8825aeedbf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"228e74a09b079ea6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"339e6e6dc9dc835b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"b46ab2648da06abd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"f87b83d173f73293\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"201d1a51e0eef3ab\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"e493025aa35a644e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"ec768f4834e2d6de\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"e6f87666e1113e45\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"5359475378e717ba\",\"/knowledge-medium/pr-preview/pr-1860/src/data/childrenView.js\":\"fca19821898cbe0c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"ca7d07d64db04666\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"8d42cf04e4f6b614\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"76bd215c9d1636aa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"041d8e4b74d354c5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"ccd147dc84e84c44\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"bc3e7a94a0417c03\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"e729908dc13e617b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"55d469644438839c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"b5e0475b40128491\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"df5643aa52675908\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"9054d499762ea6b9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"6a923192799ee3d4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"7b612a7733236701\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"adfa4619de139895\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"37726af5f7e0d634\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"cfb16e3266044961\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"fecf94088cb80c6c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"960f7ab575793adf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"6965dd6d88aa7c25\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"fc1ea4deb00cfe0f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"221a062eb162b040\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"9d359fe31043064d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"9cd0b32173f1b875\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"72dfc8ab8f8e56af\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"0365a3448cdd642e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"0bf88ffbfc1ce12b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"f2776635d6ba6cd6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"0b91b832bbdc57ee\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"d4d3c44053e2870f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"0650c751701dc742\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"ecf70da02a283150\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"75c6266a03f6c8b4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"698a8ff5e8c57c03\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"363437dfac19d393\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"ce310e0f40b5bc2e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"91c9d89695a0a0fa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"bbaa199e99f8bec5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"915b36caa83b5127\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"3dd44b351e3e9a6e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"ff5ede7d59a57b61\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"231d9259b9c11979\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"53732ee4d519eb04\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"1bffbfb8f38be8e2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"72b627b5e3aa2910\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0a0659a6afa4c1fd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"4de9f7730534d677\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"eb75f6c5e32df5d4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"c6bd2eb01f69081f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"0e7bc3549b75f627\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"7c46f4554c1d4f09\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"132d3a67606a6ad6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"f67d339dc5a5e94a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"a0423e46da6a86b9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"5e29a69ba8e3f713\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"4afcb3a28a920140\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"74e28602cb8bf7b6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"10c32aa5af4ee6cf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"41aad584630b30d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"ceb0819790d98140\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"8fe7b47822412f57\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"0383b7a6739dcc7a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"bb4fa3065e7f6112\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"b1c5259f2b86eb57\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"16ff41ed24bcf739\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"e1fc54f315e628dc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"4b1a09017b1d43cc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"fa2be660780b4a33\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"8be084a793b0cf03\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"bc61436418067adf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"0cf66e09da2bf251\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"a4321dca29f43a8f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"83e7f40b97011351\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"45490fb35c81d786\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"d2e061add4c106c1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"e00901adf8252784\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"382b653eb5d62435\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"78860f4831c2169a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"3fc40bc78c12cd14\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"8a7a6701e96e043a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"40708bf31905686f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"e7f8a9732431a2b4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"ce55b366350693cc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"d7caf7ab23db0d81\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"e076add7aa4d8087\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"e22f0c2e0f50d046\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"a7e286f234a8ba24\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"9933bb3392351e14\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"f3d9cb749bc1ea72\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"99bcfd456491d9d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"fb39fbd9964a1915\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"5d2bf6badaccd7a1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"b4ac296e66da3101\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"4e17bea48bde6a99\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"a392692bae3cdc15\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"e8809ab93de077fc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"e6b0f0e95759e08a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"77d630f764519f50\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"2bbbeed52c20f648\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"a5380e2bb9c97cfc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"c4951feadd7cc186\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"da4740c03d98f4ea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"81a8267b3e9ff930\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"29e340d485e4228f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"9c318aac66b4a164\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"57a5236da2be7ad2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"ca5fceed2ba1f816\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"d6b6cc3ccc889cec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"ad1b8de579ab8b66\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"e0a5cca7472f8031\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"59425599bd453d57\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"346cde97a2adc7a1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"1b875b7d3fcfe045\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"8b3c280f75f2f88c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"5d2c88e040ff4943\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"ae82391867a1b524\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"993955aed00c931b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"a436d4db29f853c9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"621b5fdc7ca8a2b9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"0ae7d47e27f85a00\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"59309471e6fd3ff3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"971af211c73faae3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"af480312609e1c47\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"f53a9e7da9180a45\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"ec973c3ed89bce12\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"e64c80cb7f2176b4\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"5ed8eef93b4a9d4e\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"6844242c90660921\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"2b0c63e2fc4022b0\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"a8256c9f3e1fbe68\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"dd693f373d5e96fe\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"6369421f842fa4a7\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"f44b606294831786\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"07b6c986470a61d4\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"43cca71a9611aa34\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"86c7e150b475fda2\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"45c4fb44b335e40f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"0bd5f07a230a29d9\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"64d1a34d24298a6b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"8b5820cfa6957135\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"f34428ed1026dd02\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"e29ebd6f2bcfbfb1\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"d1b14d4d8bd15644\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"41d83292fdceb743\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"38b1f22046310c20\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"deee82f74a399f02\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"4d30fc8847bd31ba\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"13121eaf872a57e9\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"33dab09eb8cea032\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"0052a80cba0ec9fe\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"3375248e8453f86c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"c08785da1d5f3dab\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"7818ade48a681e7c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"7e66dc173825d310\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"5c9b9fbd823678ad\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"5c3702ee1637033a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"ff265b49792ad46a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"ded243343567b1c7\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"c9fd78648c922243\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"3adb4833761a42e8\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"87483183f570ca3a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"63bea4efb90e5937\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"571991e77f60af4f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"96f23760009fa167\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"8dbcffc56c83380a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"c46b57b5807cbe20\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"d72abff63e470d62\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"b806f95ccc7560f5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"c0fbea9bad3435f2\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"7a343dc4e22c7347\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"3da0837e20a11f1a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"a39ead0aa46b709b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"65c3a5f1d4be7ddf\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"939fde76d6237709\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"84dbb7a20ee73f67\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"ea9db5f0e6b32a63\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"a9d33332cacf512a\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"4272cc5ef741e004\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"767fceb0772b026b\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"ca87e2753f8819d3\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"72d47ff01f02b7ce\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"9038fd6084369794\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"4f076d8e6825149d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"bcbbfe440593e002\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"387c2ce41f517328\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"d43bf97945b3218f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"6922d1b984851e78\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"3e6bd3d1faa88107\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"9dafe2612ba02175\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"cbb73aa3edd4758d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"080cf740346b0904\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"ef2e4f43df57bea2\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"1332d790f68a81a3\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"9666799a74f2d4cb\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"26673a69e349dc33\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"2a03a7eb18eb902d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"603eeadcb6bc2fbd\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"9a77da0291c2c344\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"e507f98954b90de7\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"7d0e71bc2ed7182a\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"e88b28eefbcb130f\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"4a03ecaa4ce37909\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"960fd60d9df745a0\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"7a3406d10f511853\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"5339e74f048f05a7\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"af0451f5e0f72c53\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"00b0fc7f008d6ab7\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"b46c45737ebc3874\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"0c2fec97b1bbf9c4\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"e7608d671a0104a3\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"a408c1d45ef701c1\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"2a55828cf6db3e8c\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"2e88573e2fcbee21\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"704f525ce2445e30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"814b172ef44fc120\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"0c48677d21e608dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fb7587e3ab5c28dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"dadbad9bc788ed10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"cd713ff2b04f026f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7402782e389e656d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"ace70b6b36d140ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"50d27c7c022bdc22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"4cff852ead2c76b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d68b06b62b3682da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"7abe8dcff5128856\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0b5233c565f9dcd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d37e0f8bcb93bd21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"630daf2804367497\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"35c88d573b9abcfc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"3141443d86c14d7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"3e427052a9499d3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d848c0426cf8e759\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"7ea244a36b176be3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"35f43048806e28f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"f512383e7d058901\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"06970a2dede1a152\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c20f3970645e090d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"ef28b148d6b7aa14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"4832733029d2fb41\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"220e07506807ed2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"59c70149f104fab0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"5fd37a0a33d8f0bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"7421988482863da3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"0208935ab9538694\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"85fe0f4974151c40\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"8f93f4e348603373\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"c2ea3a7a5ecc44f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"bc1fcedf6eadf457\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"dc98309b739c0fcb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"6b5b6f759eb46d63\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"830cf0d5bc4768ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"2bfce3cccbced21d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"1db1bb135893d2f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"b4ffd856eb1586ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"f7a49ad2e15eca20\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"bc233f60714d849e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"35b2621fe37bf10a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"17a9d065d7fb02aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"b97b7fda5b8836a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"446fe1106075f85e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"0fe1005d5fab17d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"105de74af6592feb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"c5a068210d3eeb5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"0e1cf16717155388\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"22c19fcc518ba5a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"85e7b4bcb74f5b1b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"8b4b230bec95057a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"f881fccbf3335f16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"64be8dcd1bf0f05e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"4273af7c6fe029e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"72329dfa6de94ab7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"86774a53b3a9dbe8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"2f86006951d2f64c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"b7a1b61c506d861a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"cd035046a99d2a22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"f79007b4e416bf9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"13703327daec7ded\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"df857466547f0e45\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"f4c393861e15f2d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"ae2fc6b2199d8d59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"77a2f0ac68f3319b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"42739113e4fea89e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"d3c9c6b411447a10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"d5c23ca60fd99603\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"8b4eb48f3d21d2a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"c15d2bb85dcdd54b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"0df75249bf207add\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"dc29d3e59ac9bd22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"a5f9995a8c385a54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"cfb207a9a03b99e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"9d474d2e911f70ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"44e1a77d34635446\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"ac266089d28e4663\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"6a23c7787f921a99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"ee198e0e6e2b5bae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"95955f1634440bb5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"ce375df5ee706587\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"6c835ad52c4d4b87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"7b922d95274a1a0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"e058c8b83ffb9867\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"cfc486bdd3e1aea2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"a88b7fa8bbbb13da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"6eb2d8afebc35c98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"a7ad99e6a120023b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"1a51135982b29b5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"a816ddf730bfd836\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"7dea283bfcd53dc9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"32c100831381cbac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"c6840b01ebd9ab35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"5b4e8fea18e7aa0f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"5cb3580bd4564544\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"13fb28959622e9bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"321b8a0a83664b0a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"eb738355edb91923\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"ece1543d7d5e1e2d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"f35c1ce5141e85b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"cb3198eb26c7d27f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"c318c8f904a3b0aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7e1519e4bd391daf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"431aac467c523902\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"07537621479f50bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"3879887738b493bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"b37f0864ad26a55a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"44841dc1b5f96cf4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"38087855a738de48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"48e1e7f9c841b2ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8e9abd4db770ca3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"7c603e456f09ccac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/browserMedia.js\":\"60636247f14398d1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"e8e7f09949e2a5b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"522e703312be9794\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"0d9ce5ca66c57e15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"c2cb4b3a881d2ad7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"990081416f90e529\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"e1935a57475662fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"5e6d1a92c288d12a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"98357a62797c3ce7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"a8a19fb2ff1ab792\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"95e5ddc988781ab4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"544306781caf6074\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"8ee96ba004a7c3d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"d4a93d245a02c02c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"8141f6d915b728e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"ea42dd852ea5fe2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"11e218a02ea7cc33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"1052e481f29afb96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"2fff274fd11f553c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"6feaef9c7d92ec37\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"05dea68ccab54c9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"4c4423879962acbc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"038f2f13d8322d4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"bdf6c55f1b0c3bc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"d217977ca991555a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"89d0c0903bd2c276\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"04ef1211fc95ecb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"e7cc998080abc98d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"d5b63e1061167a46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"29f9e5495d68870d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"73f044cd01b6ea0f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a019657fa41ee2d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"4061ce326737ef6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"809ed5599b434663\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fac5108ab676cd5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"5662cdccaff95d4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"c8553b2d2a82e451\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"26c6f121250c2d51\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"1d7fbbbb41fc9526\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"ff648ec269e834f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2e163ab7d7e1d27a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"a050c0155e33ec4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"73aac9d578280821\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4bf75ecc71fef9c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"09bca14cd42df67b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4af2b614537e8b59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"7e175c42bd7bd2be\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"ee7924e280034c77\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"a550da69a50232e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"e3ef08d353706e6a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"5c046e0c9830c2d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"65a85fa673454da1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"6d89f91b772dce85\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"7a2bdf7693e897de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d9a3b20566877196\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"38c0ee0c2e5ea8ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"422b94e645d8257e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"76b703a33666c161\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"2991f9ee92134ca6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"e85a3c78133396f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"8bbe62e5fbe48c35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"d9af5fdc48f28124\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"75de78489266e174\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"c8c6088dacf74b62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"6424f4e6062c80a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"f5288e5100f82c7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"533fcd4f82222b91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"feb1e6483af70d1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0e39bbf235f530de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"dd27f3eaf8f178bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"ac668e93ebd5123a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"dedbf1b125d88a85\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"83cdf40e3e9a6560\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"32cf6883924123d1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"2d9be0f332c150bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"3a1626399d8ad3d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"450a65328516dafb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6fc7c122fa3982e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4868dfc1df8641e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4645fa53aed68acc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b681216eba74f2cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"01e4c1c631227fce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7e876f4ea0f81396\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"47d343bc705180e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"16433c13699435e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"33c72710147ede0a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"b070d76d7b4da9e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"320f5a49371e96ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"f835943de8e4de91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"e487bc07fe4de92b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"36c6720e0e520b7e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"717967dd58ce8070\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"afac8c6dae30a65f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"8941ae23e29e715b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"fcd3350b0f269521\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"c8cab6bd0f2eb706\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"ae5ae404a87b0f67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"38aac73450de5934\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"b19ede99c934f9a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"0f6950e2b699c0ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"c25668a1ee936d2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"6f04f2eb5b019610\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"a258f2bd69f831ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"ebdb25ffaf47f72d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"04870e452f053c1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"bbc88c1d1f0993cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"a9914a43c8db29ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"60622e36cab9b6e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"1c8d016db45b6d7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"3eae57bb886f6617\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"80d62476fbcfba45\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"79cc2490e3197d78\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7f826b04f4be01f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"824d427c1ee04bc9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"18f4c03a548edd5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0c9bda8885f5cd90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"57c1844cc3cf5465\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"5c3719e01904da84\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0ff53f234a8ae629\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"1759104d6a308fab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"43460c2a466ac3f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"5a67cdaeba1e6cfc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"6dc7171e9f073f34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"358f0168d37a886a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"ff3c64bac177dbe6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"f5b2e7b0e350f52c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"3117e546abfada6e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"f20f2884cdb9cc31\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"00a816ff28ef1c63\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"91d75c94ecd6dfb3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"dcd53d94a1a88172\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7a26ff7323ed2162\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0496f77a81abc5ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"dd6a83645398fe39\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"02c3e5492317696f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"c962505bad0ca2f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"14f9c8d1c8ba41ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"c94cc7894829cede\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"f94587a832f32dc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"bac4ff42b54efaf9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"eb1eef5b09e67e96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"76927c037614ee69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"ba261dbb959bbe38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"b1a03e2099f30400\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"6f6a4aa0c3be5cdd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f6fadeee17467669\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"c18a259d424685fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"a5d77600659154ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"33d07aacb68cc1de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"724fe66757629c3b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"0b72d7ebaccd154c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"d8a9d5e2db79a973\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"27a0d4cd45dacd3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"2fbff59d46e8c6e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"95e6a9219f6f11d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"f6ea8bc9e9c2a09d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"6a3ecaebdfb847ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"8f664c19d60a9b09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"527be7f9f1a39051\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"b0dd85725fd38f90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2dd6850437d129a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"2d942c2a8c6322da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"5556ea301a50e4b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"14a129eb2ed2467b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"fc31c1047179654e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"f880f1b141ed5ea1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"80ca8b2a80eef8b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"edbd3ac68e85a8d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"d02e6c16e5fdc400\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"b28bdbc3f460e91d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"e373a7d2175b78a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"86249db442a93ce9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"1b2c34ca3d227045\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"8a1afa6bae5dc5ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"f0784c13af552eb6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"309d99b0a393ce8b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"ac30d67ca86a1f0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"3f20ced102ef0abe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"758aeea8bafd3d1a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"ddc5977973f17978\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"31a9a828243659b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5eef769548b6779b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"d8488bef5eedbb33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"ef9580f3dd727be0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"0f4fe4e00415dff6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"d1f7d558ecdcf8f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"9a3f9d22088f68f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"84a22fa7e2fe8aa9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"567dd30cf497f16c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"2a4e0ad96b6259b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"856e7470927e9249\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"bf3f7d1ecd9c501d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"93b420be9ed501f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"7cda31dcfa9e1e16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"7d584b8fcfd561b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"6d9e8488f8e6376f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"d77868a926de10ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"8973f997dac54a6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"c9bbf73cdfb0ea72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"a88ad65f34e01e4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"455382aca8dc1d6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"5def5cd18dde03bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"8528b73eea068ee6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"f6b38ec41a3af713\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"1ff52d899d278d81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"aecae4dd2c4bd3a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"06631e5bd51a9c87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"f738e16507e971dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"2db6d82c826842ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"83601d965261f452\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"6b6b6cdb17c8389b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"b2d1c6a075b58f25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"e0230afdf4957faa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"c54e847d94f67b69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"9b41a88102dc955c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"ea37a3cd25887ec4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"f733886848981b67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"47fdddae4d99470f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"dea1c431da2804cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f696956ed0cd73b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ca02bda804d65164\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"af4fc67a59db8bda\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"1375136ec481955e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"d4c25108b83f61c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"43f287eb2faee25c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"b9d95a177a70ceb0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"b8897f7d21ce2cf6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2023783ae43335f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"0c83aa24102775e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"e0f220cf14e76006\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"aed76ef3fac77311\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bdd4ac5b363e7dcf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"2d8816a0f3dbfc6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"9a07e308e9e1f5b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"5032955be2c9b39b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"d7bf934993903ff0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"be79f970f6142d5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"255dd51d450ced25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"c2916e5ded1ca286\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"8444e4e0d6ca5222\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"0db90a3a8192f1c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"aad997fd65de0cbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"ff5e72a32183b2e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"3dbe8eac4c4ec996\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"637764384eef3462\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"2aa15f385380ae59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"d1f8315b91f13012\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"05538a56b9928945\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"4d2f4d81dad31d9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"3de17f246017450b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"2df2dd5f79cf6671\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8b96ecfb71bafe04\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5cc93a69b1d38741\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"09500f217816c5e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"0fdc7772bcaf2cab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"6166935b95d212ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"279a0a72b0522bfa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"6c7f448af7796e8c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"302a17b3378a3f7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"3efb01984cd407c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7fb4effb2a1b5fa4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"c20b0983c721c2ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"31a9c8520d916f11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"ce0364aad90d6341\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"791046994652c973\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"2821445269c39fa0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"d09bdc49ce1ecbcc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"02e9ea70c63da1f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"d4c8d5242897b2fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"6b4765b57f61dc81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"8091755ff3a3fcd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"234595cf6955cff4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"040050ed1b4e5b27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"231ed0309a7bd37c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"67f96e99b4020d9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"620e044dc6299470\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"caa33f8d09e8c568\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1a8801ea09523700\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d85a88b9d86fdce7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5bdc5dac5f2c0a42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8105b145c3a49ebc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"d5d7f4ca42323df8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5112ace9baccdf00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ae4d4c53d9a7c11e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"768e0dd2869370f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"b5bca1c13ca8f60f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"c6435b919f3c1685\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"d09d3c431d6c9dca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"5ad31e0b0a50733f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"e7437863df44e442\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"b4e31d9da74a0bea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"79edf6ad40b7344f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"638f98531625204f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"08f81db3171049ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"422c1e1c66a3ef79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"fdc772795e4e22ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"b6c49665dda83aae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"5d4be4ce7b5bc8ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5fd7c796a41e77b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"95f4d64637ad7b95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"3912000cae32582a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"5bce0fe2d7fe967c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"4010a544dd60ef16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"13311776db920793\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"e251eafa23cb6463\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"69d587f1f458278f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"4537678343c7f49d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"0d23a5cba5699b93\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"49dbbda3b5ef5681\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"30586509cd4f9743\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"825e7bfb27187056\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"75acfd0d7b01825d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7c68411426295e33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"3944a3b13e3eee33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"9837a6b968de00ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"bbb8d5e728e445b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"72f094226fd6c5df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"05a1db94be055ee0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"0b011f591384c3a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"32684351fae1469e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"fe8ebaf1cd51a553\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"d00c73615bde8a3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"e184cd6c08ff3d8e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"ad7e7fb82875c582\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"bab24bf6abe5bf7c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"9446f01cdb535f76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"a9ed7c8f3ed444e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"a4422c6efed3d30f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"43c4eb6125c77aa0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"6c21538e5da9d205\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"a87a9186e6ac6fdf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"1014d08560a4caa1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"7ed142785c38e6c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"5ecbace6550929e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"e47a21a5ceacb5ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"029eb930b05b12cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"3e8a03f275763928\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"39bcea052d063c9d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"10c6b1274d5ec07e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"4a67b7aac5ef96cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"132d0d06084a74c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"cc389b363216f126\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"7911332833d3cb10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"9d7950a4a77f966e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"9b7ef9427015935a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"932c83559ab6cfd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"18ba558bdd10af81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"64af44c2e3752af7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"62cf97042f2df5b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"ed315a920c468255\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6e47400e80b12d4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"4d1985da94c253fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"91acc2d576fee1dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"51bdad5a9a155d1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"62000ef63cc83de0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"1d97ee7e6a9c7095\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"de75bb9ae7c0211b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fce431a55b298110\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"9d1acfd88499d6c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"f852e0e014e2eda4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"eb5a02c0f8f336c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"97aa071964f96abb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"e01a0b5fa2c5baf9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"1f46b8189a3c9842\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"2a8ff45cb66c9744\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"53b9c768c6ef56f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"d7baa1abe447259d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"44ba8b9059d66295\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"b37dc4db601846a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"517f090782add5a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"3f198071e856d092\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"6eaf2ea0e75c3f4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"c4efb4ad16810036\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"14e2fd9e8e8b0b76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"8f657318bc6def6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"486c78b03345fefc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"ed68c581b07ed06a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"42bb95124d96dda3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"c73f2e4404447768\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"63d9cbf73787ab93\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"714107c2736e1208\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"40d333a26b6141aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"061e75f4df5bc3ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"21fd58384104f6ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"557b4129b96e80a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"2396e417ae8ca1a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"043203a1169b4080\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"3c7f91f4664c3cd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"7391cf1459070802\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"14aab06a60fbd4d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"79d6088997a3de0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"9be6909143a76209\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"174e4aa72433d15b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"204e2265df276005\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"6dd070132978ece6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"980fe2d508d5c503\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"80a1798ea23f0d36\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3d4079be4c15eb20\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"dc36b265246f78e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"b942e20379d7fa1a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"24403265d2a5ba2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"36f2e18b54d552a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"c9200ab53a12278c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"17204e27972d333b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"c48fa7a525ca2f0f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ed5b8d5a336883e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"e0dfc8209c09e716\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"622e9bbcb1d84577\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"7e886ea48c6ba7e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"3f911cdffb3229a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0aa062d9641d2f44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"505fbfee19457f72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"062098950b0a1969\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"1f7751c904530da2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"83fc43e8d05310be\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"16e2a649f6bfe407\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"603cec6e0dc1f364\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"c454b4c1381d12ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"a480991004b68d09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0ecec2f658529399\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"dd38c539072b9df8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"2bb62542ff5f23b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"70fe5c4239ba027d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"a0a96c23c76ef6f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"7290713982265edc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"cb3fa89e67cb73b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"cf0d82f25c604902\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"91f50fbeb4b3ee1b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"ee25fc6e47db23c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"9621771c6e21843b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"6ee5eaec41e53a9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"19680c473806a028\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"859ba4640beda926\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"48afd8354efb6b3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"6338ba3bb2011c74\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"bde4bf6d83860d8e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"447ff39f72fbeca2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"2da35709b02c865b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"37701d8c7c5521cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"1f7bf989caab81ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"53f8e3fdfe73f07c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"64cbedcd50b92f56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ff1b61c7ddbd6d9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"57da49c263584fc0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"d1c2c33579f12e67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"dad89a4e1dccf1bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"d4912598cb6ddf73\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"9ecc09102c544446\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"984b8a8a0c16806f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"54ea63a0bd533f96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"1ab8b96ab330f2f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"3e2fd7f51697945d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"c5a4104d5b182402\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"daa5630849848452\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"c79fc6deb105df3d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"20b7ec3a42797a18\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"42cbd1a209c6de08\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"01d8c8dc75e6151f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"a4ebdec4aa977048\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"d25b4e56e016b0dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"485c2faee9ba0621\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"a72a3f2a65cbeef6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"586b5e0081eec315\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"8604315aeef3f100\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"d24089dfc64ed0cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"bf5df681ed395e41\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"077a3f5f5222182e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"7c265abf6f9d54bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"dc4ab00bb81186bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"c07ccaa12e4b6aef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"2f466e9a2a034e1c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"a242a12d2ec050bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/navigation.js\":\"e307e871efa4aa9b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"6318f249a89e0817\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"c33c973091a7a73a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"c84c56223bc385ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"4fe2d527cd06fa61\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"f804d76afca95204\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"cfa79009ed7f8f6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"117fba02101079d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"ffc6fc24afa3a1e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"182ef1efa9ae3f1b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"b4fde720867f66f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"f7d2c36dd16ea503\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"09b9f32edeeaaf5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"0b558349752f9e9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"a244a6ad31fb3355\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"3836fff71d54db8b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"6d39e6aa0a12abcd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"fbfdca78b9fea08f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"94a2452644556e47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8810803a8c3e6736\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"a6d0f4b0b39589c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"cf4513e578b323c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"84f44cc5bf5cff23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"3d0c0a4f5f062844\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"c0f9ecedb3eeced1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"7ef650b8e683349f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"ce379a5c5c675e42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"f37fc0b4ddf28523\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"ac5b05dc02c5be27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"f8a883a34a73d9db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"520560f1cb6f8fec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"3a8c3603fc4c0246\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"c9ee22cd303ceb75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"45a5ea2d7b2b2ddd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"b511eb9f810b523d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"0fcdf81494a4ea32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"503242a70bfb3a4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"149aae11b9258909\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"35c2132b7eba6138\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"ef223ef9f449264d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"921028d0330b43ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"392d56802b99e381\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"7c7558310925131e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"cbff5948b9a1b47c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"1191a9341bbcdd43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"4b4fc18c0c39c137\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"a8a7e3867c1a2f68\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"074102aa336e4a1a\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"f43388ea7d7bc325\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"b29c23da6da8dd4e\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"8d8d7ae6f04f57f0\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"637633581cdce6a1\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"2812d4302d23a9fd\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"80ae5ad9e425e4d2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"33d74323bcb1a695\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"412593d34b5fca05\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"2f73e116f25b67a6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"1484b7cd2c46e195\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"173a408db5a00153\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"bb730264bb8c53c2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"75d197fc58838792\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"baa205273aac092d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"0ed157e0e0f723fa\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"b1b9ca71e81e1d73\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"b9473ef37167936f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"4f44f1d7aaa6b27a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"60675b072398aee0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"e47150f6204a4854\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"29d25775a7e3b9d6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"9605e99ea66a3c52\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"603cce7f706e487b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"a855da980e0038e4\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"9cee242a5dfd1d85\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"7a59b056dbc8a9d4\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"06c08aa68bbb84e4\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"ca5f7a7a0e640816\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"8d0a2fd77a3e9733\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"286be9ac869b9246\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"f88856ee3ec2618e\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"4a5892d6232e98b3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"2c06cf951a81a77f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"7240495aae7f3264\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"fc05a12f2a5738b3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"dc60ad041c4b71c9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"57b6746bff1444ff\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"e3bff81b4ade40f5\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"307f11d1b864dc84\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"0c1686d9b4705773\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"d1934ea49cbda71c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"c829a5f4bdb6e189\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"ca2f746d1ce36e6b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"e4e99b86dc24b683\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"3e94379daa3eafb5\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"610e0a926ecb9952\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"ba22ea6a8bb8b095\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"6e3c7d90d84de0dc\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"6264ef75f3b2c49d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"4d8a9c7cf2ef12e3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"985c537709380c83\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"202131f1f240c23d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"30538fa1914813cd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"43cba821757c8d5a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"af1012cf3caa30e0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"1d3d9665daecb3a8\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"365ff6a5bd71ab8c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"32988eadb18af88e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"3f9c916b16ee5c44\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"207761db908b6768\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"eb5273e6493ceacf\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"ee8ab9b87f64b06a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"29961522bce7432d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"fae1d7ddee2f873d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"c8892f2a30b05cc3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"f28b5da7e7188cef\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"37a703bd915c6398\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"bc2c8efd0d233f05\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"eaa016e5f5c0336a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9e8f4fcfa79dbad2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"62a97bbbf090a711\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b6e3ef33d4ffa174\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e14e2010d9374c86\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"dad51d37f49579a0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"e4628081b42fd5fc\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"93c92011cf2d0da1\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"5aaacfd56266d17c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"bcd6362066389a50\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"f7814cabe0da9e4f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"9d50fddde98a5286\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"cccfb773658ff858\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"0b7eecbad38daf0c\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"e0de331b029426a5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"2015dd05a229e96a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"2f30102ddecc0254\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"3fc4ab8410174eac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"ffa7995a6ae6df7c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"9cb26f9d152360e9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"64727797c84010b9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"aad4f968bdaef5c6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"cd5a031a712b3413\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"97cf95e491559779\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"f80fc1b537a97c1d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"74d60f4f098eb68f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"5e53e5c30a225b45\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"9f57bb05762f97b3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"10ff3170978cc854\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"97a206be54138f38\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"cdd84f8a0eeddf37\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"c4bab6ec4622cfac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"9da51367572678ba\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"9f2f2e60c88333a8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"555672e5898faa4a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"153ba607a00bf5ba\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"dd84f09b13e4dc2c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"9deddefd0400e800\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"eaaa91e8fe4b702d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"6da11406276a056c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"20c9e99dc0ff4b2b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"08adbcbe0467d282\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"30a03c1b08139070\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"4246b79f0fc97b06\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"e308944fdc19a8db\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"0e6cc57ceb776379\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"93d31bf0ab8119f5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"9daa725e329bbc79\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"398981c2f0d3c8a8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"e98b8bf9a30b183e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"afbad33a12443cd1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"2ef7ade71ee7af1a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"1d478e5c9384aa6b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"fb15f2b26cdda512\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"c6adcb155c14592f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"b98c3fe87d655f56\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"1113260bf5c6c860\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"27a20c60203a235d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"97777835b6fe0cd4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"9432d9fc1f3d83e4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"7b9833c351efecd2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"b662aa9f12ec9eaa\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"07cdbd354edd8d20\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"76dbb8fb7b23eee8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"c01bd76de65fb3f9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"83ff9e3b3b5833d1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"e814b092f74ed2b3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"0fdf955073c35a58\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"66caf136a6153901\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"5c9db730f9f60ab4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"fea43f1b62878c78\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"c2591c1d52d1ef78\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"e8e9ca231d465830\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"db1734278c3c8f3b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"96520ce6f9232099\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"d6f41a5c6d284f04\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"3f4215ed2ce183e4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"10035934cf22b4ea\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"9e70fe479bfa911e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"80f3b81bfdd76273\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"c73ddc6c9e592c8c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"3bf6056579ed51f5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"5394ecfffc50c7fa\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"6a5544cd1d3e3a22\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"67171af449a71dd7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"679625a3322920d6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"c6fc8af8cb0d21b2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"208d175a8adc6b7f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"53aa8e5f99c75580\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"7639cff1317583d2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"37adfabc53199f8f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"165968af82949c9f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"e18cdd988bb04d3c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"6f07a0021f99b288\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"ff6ed78bcc9469b1\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"f5f0312ff87d276b\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"a84a094b1dbe53d2\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"0b5557d2a9a8af64\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"28fe8e3a5a0e7382\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"1c48c14b2940f0cd\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"0bd1aea9f9ba9437\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"8554ef55631f5637\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"b42049a7e610b075\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"47813f58aaf643aa\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"296ba525fa18075d\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
