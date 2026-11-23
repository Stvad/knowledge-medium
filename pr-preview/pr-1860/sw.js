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
		buildId: "507129f24ead-f86e9837",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"3b5ac39e68572457\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"3b5ac39e68572457\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-DZ6Wed76.js\":\"fd506192a2487520\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"4882c6036a1167b9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-blAGbVsp.js\":\"8f7b1c64f5243fac\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-CwvNJu3E.js\":\"8385166f31a7fda6\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-B_FeFV5L.js\":\"68777370de447dbb\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-BCHj-TRZ.js\":\"72844f013f0a6c28\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-CstNc6ql.js\":\"5841a7d6ccd6b57c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-DDbjwrgx.js\":\"dd20346d3390619c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-CBqxPcQZ.js\":\"471c09736d9b0026\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-BhHwyvpP.js\":\"38a49cec539f094b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-CdOZFEYu.js\":\"dd69d2ae73b5d8a1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BYlZmHe9.js\":\"89a82d28e5ca3f85\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BkTZhSIf.js\":\"8ba47cd1979455fe\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CL9U4RqX.js\":\"80a1539c053c19dd\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CSh1AtWs.js\":\"4841303a40de9625\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CsrbV8SW.js\":\"03b9b253550e7a2f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DI1j0EUp.js\":\"e20e1e70594458a8\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DmHwnIcm.js\":\"1828ebc0a2ac9dc6\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-BNrNT6W7.js\":\"0b7ef0dd61f6a5c5\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-C0wLxiq8.js\":\"af52d4cce1a7e1cd\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-C2KRx419.js\":\"52bc76fbb656b67e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-yvMHJ9mZ.js\":\"c09e8d4450bf464a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-B58sEgay.js\":\"84dbcc95e3287a6e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-CmOhN16E.js\":\"ec8456416ce4d626\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-ClcwpvlG.js\":\"f632492ec8117b84\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"2a558f138a99c27d\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"80ad0fad01209812\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"c3427dcf5ca164e8\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"56185936cf8812ec\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"200fbf48613cf6ae\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"f7083436d290a296\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"ae1c29218a68f9a4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"f82bb40656326e45\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"0a1945aaf7e12677\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"b6b1c7c798a7df11\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"dbeb9694cfe64cf7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"b52daa4fbb77927d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"e07418b442dee633\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"61374cc8435f1c8a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"63659a4c3dd9e495\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"07787707a23c6183\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"2b496d43cae0a087\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"0b9696e2284fa18d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"9e333dc9592fb03b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"111a2ef35ba9465a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"372b5080bc84bae9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"ab666a97fad14a7d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4a5545020218d07d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e137f22a6db33729\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"8d9d3234c8ca3997\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"379b280ef66bb3cd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"9f96f26cf841fb28\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"cce341616f42db44\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"2fc2b9d9c68f6b8a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"7dee44bc32cdf5f4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"56523f8ecd0057bd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"be3013ee921bcf6b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"220655137050f59a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"7440b10f653fec11\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"4c41aaebeb73574b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"4aa07da804c0e0cb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"d4bf9dfbf6e3e996\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"73f674a024397892\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"e70f3b3495118878\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"5fa4428d324fa006\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"47c81250ed73d6e1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"b62599901854aacb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b1c74031dd4fae51\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"3a06daf19384adf6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"d5310d0a97dc4f2e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"1a12846edfaf381b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"d4adee9f3e320444\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"00a659742f7aa087\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"1ad494c22855c5b0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"284344fa60c32066\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"e0ed1adf8fd79561\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"5e633500097f29c5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"2c377809c3deb964\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"5d9623c2fd761346\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"df0000ce5dfb6236\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"d32707fb77919b0e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"855f5f2fa19485de\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"7fd908db7918383e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"125a154da96bbb6e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e69538d20d28b6be\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"a252ae471c3b3a8e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a6355e37f5ce0894\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"ff87ccd36faf941f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"ecc0c3d995be3777\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"7147d7ee0b5e9231\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"3ed52c057b7164ff\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"d79c8ea1a4c4d9ba\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"57437a4a1d59f60e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"bab8e8583519274a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"7fc138317469e9f4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"855324d63d30c39e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"ce11fa5ef08ddd11\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"c720137c73eba56e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"54780c833dc630ce\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"bccd14083e7537f9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"32399fa8d0206f3f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"a786b8c84629f54f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"5dc70fa95d7a710b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"c1126d5da41fdd63\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"4aeccd6352f1f644\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"085c59bc7a426d81\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"5ecc1549d635a58b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"98297b45a2136bab\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"f68b702fcb023fad\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"53022735f53ab615\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"8d262699188a33e0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"2c2f2bade31b0919\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"07db72432438de3e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"201c2fc478e1b3d4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"f2b670ba97c3add9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"a92c5e49e356a73e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"ea6e62272387d9b1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"b79bb4afb54c449c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"04e7e1b1dc580edd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"511b49ee5e5e2d2d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"e859f072e2951899\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"b0a69216195a3712\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"42f447ed83ca17bb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"3aa3db48ccf6b209\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"f3ee4273bb6f913b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"c9b29bf32b5d3ade\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"5cf9ecdea6559eaf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"d3602b6e09528263\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"0e75cec1ed1698d7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"6ec2c3afafc45804\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"0c4a0f69b2b5a0ab\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"af35a3088bf03a38\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"bd612c653bb385d7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"56fcf2f8e5df380a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"90228417ce9d408b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d5dfaf4e4e57c0bb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"fb665394ca64aa70\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"1775f99089524fb2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"a55592ef7ffb4472\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"673855ca6143b177\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"b27b0cf738f86ba4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"bffd562efebc98dc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"ad73e665e3efe87e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"89602b3c372a7833\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"6f9cba1732ca1734\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"d622e2c89359d9a3\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"3fe32bcef2feba50\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"460446b2b961cf77\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"c3a2e0db4fb712df\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"097566d6c123b4cb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"9385f10fd1ed8401\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"f9a69115bc802521\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"e8c9445cb2fa2a76\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"a4ad27861e427a49\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"98ac791c15487ddc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"89bddc2cf7a98ca0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"b48d4daa21690cf9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"c24c05b260c9deec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"bea0eebff33a4652\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"865772090c6b11f7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"37efab4c91813cd0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"46de1b14a6613b42\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"5b6203bb7d9e7219\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"96cedf81c7282335\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"2892146670f06937\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"bea0eebff33a4652\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"bea0eebff33a4652\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"635487d8c417e1fe\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"24c5806c0a75be27\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"ca90190046852199\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"a45c4c4615d9b5e9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"6e9caff3f755c0ac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"0374a68a6671e2f4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"ce0902c6ae7717b2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"4182c6bfc9da8bcd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"35e90e70aef78417\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"94e1ea0a9e8bddd4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"b61c1a865d3b344a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"2252075f19abf67c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"982ba8326960712d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"2d188749a55401b3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"309e013c37ee3698\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"b087065c6178f2bd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"efbff03b0c712322\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"0d0059cf3c106924\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"1649c89a7a67303d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"226ac019834556a7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"ac204a925bbee288\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"64c4396364de4458\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"011fa7ccada277d0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"ea1a9fdbd06c001f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"0ca166279eb2fdd8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"529a7ddb178259a8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"ff36d03dc7a2e60b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"fcf3f31ec75509c3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"e69fc38447960fb6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"bbe387635a668e4e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"13b665a62e05800d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"26f3e01b437f3935\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"326339331e9625b3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"f53e9f42a0564b08\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"2a0359364c546f1b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"99bba64195f8a4a6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"06814cd9fddfdf83\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"fae37218c5391354\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"2c77a240c948ac53\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"874f38e25b0cfaac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"dfeeb2cb797c0b5e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"bd0d9f771d59d066\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"4bf8739c8cb491c1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"2831046697982bd5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"843e33384baa4d6c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"afe47cad485b7b35\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"9f47e782e6229696\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"a45a784b89bbd407\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"fe5deb0d645ade72\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"34dc43ac7e7f8987\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"e851702a651866f9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"e70782e4b7fbae17\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"a206f65764aa48ea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"6da80e559924be48\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"cb22a5f718df0e55\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"7920341ead9830c3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"7939adc604fdc217\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ceb81c1636aa1f0a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"1ef10075c120fb66\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"3ce406ba94009818\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"f2c3d35a29f8a2d4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"5e196a9f67ad29e8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"ea02279686230e4a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"0eaa160222d5d04d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"641aa84f2293ba67\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"4cf8e0ef4c2ed8ea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"af047063ec58f49e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"eb37ba748a34245b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"240a15b4713e3e66\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"1461039775bceea3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"244f55c38dd9be5c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"695f3f2bfc57ce07\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"9bfef76f4293759c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"802cd8d80408bf8c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"427de97990dfa135\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"0b7e009217322c85\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"fa35fb68328fe318\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"c5fc729c837032f7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"87c8b6a9568d0c39\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"6e4d34d9979202f6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"14a78ba12d65e1d5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"e6bd1376c5fa0f95\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"6a8b753cc4175bfc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"e45a75342787f74c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"605844687a50fc6a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"6d8728c0f4e5bce4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"bf3b9438a61828a0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"ac28ed16c9fda2db\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"e760d0a3cb7602ac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"069cd8abaddb6bbe\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"235120051a1fb9cf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"59010d20605c1c51\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"60ca09ff6d8e1739\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"16d22ecf05d2af6c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"b75cbd16a936b89b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"38207aafb51ce14f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"9b809b07a67b44dd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"c80b504fca46d0f8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"cdff9143da78335e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"feabcde775e7b6b8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"ce88f0b9231a6965\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"94e53f117eb2183e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"88fe4c5c08c03f26\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"0d599ee61e5af25a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"ea8aba6d77db213e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"7e7d4a0ae50fd80d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"ebfa1366da85eaf1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"2110acf2315bd1ff\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"a09e4a2ea0f7f251\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"c49ede833f2bad6a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"bf6cf9c522f9c462\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"cd7c75a5ddc3b59e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"de3cedcdc69b4df8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"642334d031125bbe\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"0325fd97c80e9faf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"f1641d6083f3edd1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"b3beeb7f3ae3ef5c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"5bdcb64a48be3b94\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"f94f4bbfc61a4473\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"266e0eba39dfb560\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"39a4871d06765386\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"5be79d47ac97667e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"981b199bbce93d59\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"bebb173a0cc95e8d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"326aeee864d83a56\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"1eb4dd35c0aa898a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"850eea7162ca628e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"22dd79f283a8ba63\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"8cbc2f847890f596\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"71e7af3e18c0b0e2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"e8810a8fc38126b9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"ac3e999370ffe90b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"c868ab08e372ecec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"ed91226523ef9a24\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"e78a7e0eea6cdb7b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"67a438cbbe080df9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"0a3bc1534af8dbcc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"f72670275628e017\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"baad2dba17783425\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"ca654ff535575480\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"22c64a710bff345c\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"d1174cb694022a12\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"61afa2db17fe6244\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"189534db912c76a3\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"54350881b9772eae\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"cc1abfe0d0cee968\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"1308cc91024a8177\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"91867179c3dcd778\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"c9400dc21d4dc050\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"77b635da73403d61\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"a054f5414315c0b2\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"e32a789ed1a12a15\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"552b1245b559ec76\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"6ef729e6ca88de6d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"fe202ca9137f7362\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"9f46a03df1b82821\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"01abc1d903847f1b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"0b17ebeab5ab2659\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"eff875e0689789c4\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"971e8858c2f04738\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"34a8646225af9166\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"35b1b63e161869e1\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"0b6ad110a90107a4\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"88f33bd0a1a43105\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"0916d30aab6c6f10\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"81e570ca489be446\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"9b19c87dff10bd3d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"41e6cb52ef4a77d0\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"323a4399da0c9b47\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"522bb5d6b222a522\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"7e0d5d836f3a0daa\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"c7bc7f911b62560b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"77fc60ce3a2344bc\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"bcc866852f8687e1\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"21b0a83b5a7401d7\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"703ffbc8e81c60c1\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"f0fb260144563fc3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"55c9ec64feda84f2\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"635f91ffa53d3109\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"7b380015d6f6343a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"fa6b2ed9bfa985a7\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"55401e5e5c34ab3f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"187ad4dc52c14234\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"9fc0e7b59f96109f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"bb2d6cbac7962b90\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"bf59fccd373b417b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"2b16bf6d8e976a08\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"92e9bc1f7318746b\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"e0e595b0046e8534\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"6a5784c333230b3b\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"feaf17aa916e0acf\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"37243bbb44074361\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"e385f7c87ed97d23\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"f9dbea7e4544612c\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"f2d9f1279f88b73e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"1acc47ec9d31d4bc\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"cb8fb4cdbba5f877\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"b9fd82efc085e70d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"05f645b28596e713\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"b12e818da9041f0b\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"26c2acd511c9593d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"d04dee7f7c71e51b\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"c9ffab65ecf489f5\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"a83cc369f4e7b2d9\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"f4852431fd921d22\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"dc8ef2c0a71fd133\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"64882d9fec4586a9\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"5a848a34d5ec655d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"6de914c364011bdf\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"34e1b206ea055d55\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"adef1d5488cc2b69\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"2c770d7467807005\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"804b251bf1bdd06a\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"3387bb40e0162e6d\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"dcd06cb14747846d\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"f27027830ee111b0\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"664a91e4804070f1\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"901e2148410e5bd9\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"52286e96fe816eb9\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"c35d89694602d101\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"ac6bca0b5d737840\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"ce27b762dae15b35\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"305e0901c92793e4\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"6d3ed907b41039bf\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"4f876aac85a428e4\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"e035482437fd0469\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"9539c7566bb2d2a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"cdad36630f3ac247\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0c5f75d38632c195\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"089ed629105b1084\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"274679dbf8e3cf53\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0c35967ae02283e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"3cb822e9f0c12ab1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5dada5a8eb397555\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"19089ff5fdd53f29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6fd7999187ea7068\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"84252f2e6ace16bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a9e917a0407274f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6427ef5342c67661\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"f29c7224c14c5897\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"54929a5418e0d760\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"b65fd61de3e0fef2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"1719c405484df5cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"aad3a45437ba2f13\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"2febb858327407aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"e094d18b5064a8e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"f3d1faf21aff5a94\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"708d831be5876983\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a9bf35720b704e18\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"00642bdc92ab8889\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"621d19d31852c035\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7178aa0901092b83\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"7561d348183c2d97\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"f8b064a0db7a628b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"966df2360089a7b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"891e87ada1c488f6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"7eaeb4e149930923\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"59341a178bfd20b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"cdf7c080e1553669\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"016d470c194a26f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"e82b37979a86d01b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"d5b594ee7783cf0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"aa24f9f4045aceaa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"76840bee84cc193e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"70ba7ed4a831590a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"f3c64f8e181e8f34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"751128456f5bdc95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"26d6ffab9db6f18b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"ff32fafed13125b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a83d67e247630152\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"57ceb8b4286a33e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"78812a56215eabbd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"fd462fc5a7ddd459\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"292a76c5163e12c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"eb8401fbd35ba50c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"5746196c11b09c00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"d325c58d543a03fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"0a7a12081dee5a18\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"f48a268706f0380b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"005de458a47af16d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"47a6a9e379c0182e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"9c17516ba2602566\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"347f947b914eb5a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"fd10c51778ea0934\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"148b582d48f5b6cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"252ec76458144892\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"4726caff723e2908\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"0413cd49e7f5fdea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"d1052251181a8d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"bae9cf3303658a2f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"f88941754427360b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"1d551de5b5bd4e33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"d71b0e33e172a157\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"155e4957c3649e89\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"31b1d8c7eec78de0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"7c09db07383d7ce5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"129662a2d1a69581\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"6d6671614f29c17a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"5146c8dbcfcf93f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"fbc81a74c2d24241\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"befcaa9a9b8930c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"75e6c0e84f54f39c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"ae6c19b9d783f93e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"81623847ab44078e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"05b0a5e67bb4aa4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"4df5d3ab156f370a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"c5e83ed5fd37b5a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"804c11a0008c0cb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"40e7e467385a660a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"4d7b8667f2fd5125\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"6311ba0b04e1ed37\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"f3c2db25f136f5d1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"adec67b1276f60f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"51e458d431fbc693\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"fc032db8091948b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"1b65dd6bbb6aa4d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"a2ae6283326ce011\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"9601f64ebd96a111\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"efcbf697f2089054\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"45caa254b774a23c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"dae80b8c7fe5fc62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"8f56d2ad610539da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"f8823044fa2df926\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"901e38fb70c9170e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"d2da09db1a68c7cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"7d57fe3dc57bee5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"84e8c96b784ef7c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"90b4385e7b3d147c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"6a9110fbb35977d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"8b4f4ec1cd3feeac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"baf1617038e18458\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"52a6a7a4215a6532\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"664fc7f66e678f3b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"42b1f84355ec0860\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"0060298012d61f71\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"224946c494b3b201\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"f44f67b85ec4c8f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"5e379b52e1039c43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"50933076270691f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"9e6287ec146375ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"57455d55f3ac0047\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"51afeaf7a76ce283\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"78a29f62e8fa7f24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"387a993a61b0d742\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"2c92abbdd8b970b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"7413fb77b26dca5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"85f6e42653781839\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"b3c99c5e700b19c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"a5039e13656a4e13\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"79fa4980cccba5f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"e9d273ec17a14da7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"f5a4493ad0aec64b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"38edb78866b3f4fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"9c92e915da717e47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"036714d218750737\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"f2593de44a5fb495\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"03585d68cdd30938\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"9bffbd976f67a7c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"1d78d59a7bde0420\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"86316fcea3a82557\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"e95eec02530d0030\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"62fa17fc66263760\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"ad9ac432117566a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"2b4e907e2bf33100\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"04609d9fd96d209c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d0f70690ee9569ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"b0a5a5ddc30c7d8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"09702f39e854754c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"1668bd55f793bbef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"40e66c3c167bf2f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"649fe538cc791b47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"27650afac0b060cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"5576ab0da3d55362\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4f44fb65381ace3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"c450238a7cc7e503\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"8edb5a1a552f687c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"178067481c228db5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"0f15efc44de7045a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"0df00d514356483b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c48e200e321fa6f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"9547b5b1d5f2727c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"1a44e72e6649d2f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7fdd510ad796fdba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"52a3c2cf4e4e3926\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0dd1f3dbc8947348\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"5597fb8f1d74ea37\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"add2098655ff51fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"a9a8865186bd34dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"48ac77696b21875f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"8ac246c03a6cc680\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"91899793fc261fcf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"ada540c43d00599f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"f962b9748fa6c702\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"51f6a2545ee83ddf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"bdc813e45fb5c56c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"2b8d8c7c4a7b3551\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"1bfa4e9c8ae78993\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"d777a8ac0abf95d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"f9e0305b8cfab22c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"5f896b900fb59d7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"9b465bfddb091c34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"b3b8086fb143bf3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"c106f2642a415395\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"f1b44ef16e7e8f62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"9ed017aad199d38d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"e83b21bbe519b9c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"29458c5231f99fcd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d0aa563c7f6d693b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"3f32b1a550c46d2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"571d64f3af21218b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"78ab622b636425c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"bdcc2a6342edbae0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"8563559d8f7fe67a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"5be45e99cfdc6b4c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"82f9d269d91791cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2487108980cbec0b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ecaae0a34f6a8c2c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3c20ecf6f595ac57\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7b764882746e6149\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"56311c894e35262f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"4ca796bbc2fde6e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"52663e55d8766259\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"0ecbac838f6a0bc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fd4d34070558f45d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"8308149e9dc66552\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"21779c752eba549f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"854f982f4da8e892\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"70f9314cd784340e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"447151f4b55774b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"fe017fc20790e4bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"b110b465aaf2dd41\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"b99a500a1c4bec7c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"6fca00b58b507969\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"7a95da56c28009d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"5bee7ba8e59ccd38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"ac03908f0edc6baf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"2e36970741c17615\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"28dc8f005a0fd8b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"b24c25e38d7ad161\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"e24c3d236ad7eb29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"2f84ee6ac608bcc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"b515b319cc6ebb4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"357a883e01a3e379\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"70d05946908ab76f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"9ec5748190912a02\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"40e2578937a459a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"0364d6842a9a0cd7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"ef07c39af0753e30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"b0794392aaac8425\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"f67d9d2ec2664b23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9fb97efee02b38e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"38fed515719c7424\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"0fa90bfcac5a0727\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9d40824004d1e4bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"28b3e1a8c74c6c0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"c34b55bf14e92f7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"84e01f33158c2a94\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a26d6c347618f4ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"c902e67c1d34dc80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"29e89c62428ac2e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"bbeaab87324c19fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"f1883be7e721a688\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"38c068405e1b2364\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"dacafb4044bd12fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"255b4d6f205734d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"a75bed1408819cf6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"5d8a309392fe796a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"e8c528ca69838d7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"0e701c96edf2b910\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"aac330c9e383050d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"02738d8783eafc0b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ef049483912aafaf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"cd0473df3cf8208d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"9a5af4fe123d8836\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"c443742395cb8f91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"c42bdc8f2f2b43bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"cf4500d2223a94e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"be82ce518ee5fe25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"c5bb1de37d412e36\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"744eeadece5d03c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"5bd70ff9ba7880a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"a79785c732468cd9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"8a0e3fb6c8da9a55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"60807f201b922df1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1ae981a5c396bc27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"e899ddc0bc6f771f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"cf642ddff69f1b62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"159317c2a120f717\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"fcc415c9ee369f8b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"2da9324ae50993b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"9fa8abd9d18cf233\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"22e1f5a5c5b6985c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"39a216b359782de2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"02f645173922d159\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"af63488b57417e0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"e6047e24aa9feafb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"32b0c02bf5b65308\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"83f871d26359b6ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"a91ed1c7935907c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6a6f324572e85068\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"72366d92dced413c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"b1cc84b28863ad3b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"c2c63f10cdb93d13\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"17413fd7abee1bb7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"fdb189b7e78a6c54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"5064adf0c961ecd6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"1385b4be305daff1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"0d2aff75cebd9572\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"ea2c6e78db633c77\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"d88eeca4c5a4238b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"1ad89e4866d4f99a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"0bf76d55114c971c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"b8341ef4783b9356\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"2fcf8540678c39bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"2384bcab13313e88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"a1c1d2ab5c2623b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"36dbdc9b9143b2ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"7f48d17fcde989ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"f434b283839d0920\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"052d08ea5e286d26\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"065d748f8b9e41d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"e2f9859168343fb7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"811858d4ddca0276\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"4c720fa56c328982\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"2a1cb70dd5a68442\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"d60352df6180949b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"31f1c76d61ef47e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"b2302224794ff3f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"0ae7d356a76ff1c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5faa4be2abed4371\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"d35a0ac44d07cc0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"1b5bad71c7df3f46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"796a2569c4d58ef5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"12e2cd07526296f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"a46716686b2b2397\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"e281cbcc72fe679e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"3673489f09c82fb1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"ee26fbd43a883c64\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"37a89fe59b0504c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"9e9a8c31db0d67d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"8da630f29acd885c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"d2fb5c9e805a1cb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"eece5b63cdccb14d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"132184a3e2e323b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"c33c9a6dd077e3fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"76ebbc78facfb32b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"30048e27123ab710\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"a08d78ab67b2e818\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"9354d715e3bba541\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"903ca4f709608255\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"8dae1077fa23f4a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"da4785cd854cd7f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"7369eceb8b09346f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"94220d6c1d959c6d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"ff669eebc78cd1ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"f78eeb2a0c1df843\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"c9d6d270ef16ebcb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"1252491ad4e0c8bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a18dc04e5c4a2bc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a2b53497f9a3f3f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"19418f0285793796\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"4fcc706195ca5fc2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"50b68b1cf38b2734\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"9488cda83aa81e7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"93233e3bdd7a53a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"61f3c2070e671e61\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a4e1aa8ab6f44a7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"2e82c72cb2dd344c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"7a6ca2e34fccf90d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"53c88fb38f0af187\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"86ae73bd2a18d077\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"8ccb926bee0d1f42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"21d39a2de2a12286\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"d2b60cbeec768382\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"a6062c9883929cb0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"6b583655411028bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"1c28a477f166be19\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"ebe077acb0bac86a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"ca7f67345b1009f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"bb3f40f1eed880a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"5e68e16c9bfb55f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"fcfe070147ff82ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"acd4d17c0d6af2af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"b29ce068b259d0d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"868a2725627c2cf9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"11193fe76d9bc263\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"cd8fcbf618bf4bdc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"9453a6f064a85654\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"3f8cfff3c5d4f997\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"1c168447ac710220\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"920b719ecdaff118\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ec54559c918fb84d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"95d1ec935c791b38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"e95a045749597cc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"b9990af3884b9b95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"887931b446490a54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"c3a4737045760a59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"92d6907d3a2eec1f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"b52c198d6bd19e14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2e2904324822ae60\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"0f33e57c3d7c88e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"bcbffe63365607fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"a5ba3efc2e03b5fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"42252c00886d3008\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"a409183dbcefe211\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"f44f37587984862d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"5254a261b16a68ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"54eada08a35ecd3e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"9eec84819e6bb9bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"f005647fdc34edd7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"9d436f95bc1478bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"0a9870386cd0c4da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"dfa037fa4e3dda16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"648e5fcb82ae15df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"463b620089fb0f95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"f7e2867e33c21293\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"91de2c8fe7111479\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"15bc56c1ec993572\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7372551c0d7c7ce6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"480a5a47d25a31e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"580dc283f2fc3900\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0e7c5b6c08dadc44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"629eac22fe8cfc0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"dd0899dd1686d028\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"a8b9db2b982bf8bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"657e67f370b23b9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"91744987173e3e04\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"ce6697f0081101f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"e8a5e267ae21e3b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"98cc02185c405959\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"293a384094a6b545\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"44a96c8e29ca1a2f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"6968558d9b4493d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"ef8637f4c8d9622a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"58e4b7616c0da812\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"78cdd85442e238d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"28d334d799ffb223\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"632d770c7676616b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"2a859491868768fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"5da67de16cf40b53\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"10b3c42c01a445c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"a7169e98acf7d1b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"6cd94cc2ff6ea619\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"582015b9014d8ba4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"3334ec3a5cb7d2f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"19a0162f61a071e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"a689508691e6c30b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"94feac776bd52e6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"c171276a5656af80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"3515268cd2000c93\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"c8f6714997a26c7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"58f4e403040b1ecf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"66582fc612edc1d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"a78fe5cc7c242d62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"a97c2d1ba4ac5494\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"43555f82275e576c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"79fcca379b22b121\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"ab2cfd25c6f88b94\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"a3d2f47afd45ae96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"bcffcd13c7a6ecce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"a1b75c385f7575b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"32ff4835406ad30f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"5afe34bd169b9b42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"940a3d5982ea84dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"285ba7b419f8c070\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"83139129882af36e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"1ca31d703c33ef4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"7696f87dbcaf33ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"a477bbd0c8fdf240\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"57aed884e4b25fe5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"00706ea5f8eb3289\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"1916ca85a04f8036\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"997bdf66092e80f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"cb1aed76aa89616d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"60f10ad1c638c038\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"2219e2ad05fa9c02\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"29ae7dd7fe05ea41\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ec26d97ba5645511\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"138838580a1eab1c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"ad7a01f2b1a73354\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"793c5054bba416d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"95f92a58f124d736\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"77c8369392995b92\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"04f8541b5121af1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"a7fabd7ba8aa4dd4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"fcd02abe998161aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"64b09f2b17d40941\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"b9c244cfeae035d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"b48e2ea460cdd83f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"53724ce7561d5d4c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"a1763023b834713b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"30c24c21485668c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2843404096b5e747\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9046a8484fc670c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"f626a66964dbb71a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"133a17e47ee9b2ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f2f5099e9371b812\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"ad169bfa05fb76d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"809066d905cde73b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"a613f613773cbdf5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"91047a829773b531\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"920e8f75cb1e4547\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"c78e4ace0f24945c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"8c084f841295c7ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"56a6b85742e491a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"07031d748452e6ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b1916d831be20e7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"fe72b768129b72fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"e916b1dfec97a8cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"bbd04678887d48c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"864a984b3384827b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"dc0d6fb2ed13099f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"ac2cda88f4ea9b1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"c02a0f64c42e9075\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"9811aaca2c3f4f59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"67b87736a70600aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"58cf84ec966ae578\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"24382a79e89ae201\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"ad0a1faca0a75b46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"bab3266374c0bd0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"6e6e3ec64fc3f913\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"426ea152b1193183\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"95b180e3c612473d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"0cbe8d60eb87bd28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"9026482b35793119\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"950be34c775880dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"2a63469a0bd549a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"53485e5d581be19f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"62add62840f427e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"f07b38d34df3191f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"44d189c779a21328\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a85cb58e8bb90dcd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"185c7be879d07ecb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"bb720f35bae65217\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"faf84cf0a1b0af4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"cd895a92cc1ae816\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"2f3cdb485d1c64ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"85854f2ce33c5835\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"4cb882615a7c4e91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9a8a88b77af04278\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"0a63ae5282d06d61\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"85a942cdc2ff3e53\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"d6b9b9e16bc6b7f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"55e866a1a3e33872\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dea8e03e772ad744\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"78011e3a01c43e4c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"73b5ff4ae0fb627d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"8be48047bc5fc8c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"ac1fcfa0d8fbaaaa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"20a116fafc87a6d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"ccb0e591fb2146e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"f012416314f87f62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9dd98150476ded80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"c1322beffe4d966f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"dc604d74c2f67ca5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2eada5d45420a3dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"53956cb7efafb31a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"db79a78ee6db309a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"aa11a401be2ae4e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"af071b5e3d7e4406\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"d47d8a3f6d8690ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"1a3cad10831cf8f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"83f6ceefeadfd058\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"02d5d15f04cc1b09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"898039adb4b1eb30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"cf866372b3588cf2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"e47e2a1aea12eff1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"4e5af7890c4f48b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"c74e7226ae849481\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"b068c4ae21348b80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"f29f54869ccf75d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"12c2508b43d766e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"d1bb56c764d9c36e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"1879d56e0d7a34fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"c1cc49d247d66d2c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"3c55f65cc6f1a119\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"885b864053531118\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"9b92b6b3147d5b0a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"00a3ddb124c76612\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"3b0dce05dcac86ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"c329344f9037c3ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f56f2a2801598630\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"26fb9ef88ee0aec7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"de469f9c2ee2e00e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"b420c59707716dea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"eef3de367eab8a0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"c9a60c47c1324286\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"795c69ba755a30cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"dddf884b1488b95d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"0b5fcce906d2e5f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"f097d1d6432a197f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"94fc487bfa01cbc8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fcb3037836b03c88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"a6889c926ce6a227\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"fd584c510693f3f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"77e3ed6c8f0542c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"0ea4d46645a3020f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"281539ccfeb15d43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"46e1301ad8f31dcc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"87305de9ac69d3b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"ff0f217e54a91f0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"e4f724f17dc13423\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"58e05e616f97ef62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"cf22e023167797ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"97f1fb2ab31dc0bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"388f89ed71ed937f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"dfd7eb1c9dba07d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"c4a6f2d1567623f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"bdb5a26adccfdf05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"83d1ebdfc251087c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"44b3ea60cc618ecc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/navigation.js\":\"df035d03d4245f76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"50e3acfad004e3c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"e3794571f1167ddc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"6f2de10567879e2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"c20ca5e501dd8195\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"f0302c5ffcfdc031\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"59fc80655675263e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"45f5ad3363579853\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"bf99413196fd1265\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"9950182138425a9b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"7c90b3e32b86c955\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"bef998e2d3166c28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"c1517373d87607a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"3237e6460ceb4d95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"e6d45b50e2bc8e9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"c7ca4addd5192960\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"937ed4542a3af4ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"8bdfc363e4b9689b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"ecdb49e9eac6164d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6f0e50b5d6af3b0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"41a01d629e1c75e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"13af509ac548875c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"e0574039813e752d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"bde8cd739305c1d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"87ee5a138523dd17\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"3dd96f718307b880\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"539fc7590efa8156\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"dbc4bd61130c4ded\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"25813520994d4db7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"776421336e744136\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"936cbb5227e714cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"2eafb75ad193f735\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"ce9b6b81d801dbe9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"13b3ccb98269de4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"0c41a82873baddc9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"5187bce0052d7deb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"2fb54e0af989f617\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"b09f5ecdf5a7dafa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"387d49b4413bd1d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"943f046009e04b67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"ad85b7dc18217a9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"c28101919dedc1c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"a6a66f0f9fe2eb44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"346fcd0d116a5078\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"362e85bcec1b6dfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"7fcc6df3d8378e17\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"655fba9463939da8\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"d04649e108b6a37c\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"e92ff4a649add991\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"8626a6bb0199d197\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"d95141b1bd9d0945\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"ec7faeda62bb5635\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"b834c96d2da9b741\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"ec353edd2061af5d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"fb45a89d004a4514\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"11d71fc86089ffc0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"7cb6354ee98519a9\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"90a58af5b77fabac\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"a616c65e6e94aebc\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"6502fa6d1333afbc\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"b0ab4a3452e4f4a3\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"0a5ca5f93a8830ca\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"9d9986219f56acf6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"62692fd28da6c09a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"63b87154121ea686\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"df17a15f97e28259\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"1aba8a0228147af0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"11c096e3bed9f170\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"ad685c99954adc90\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"84ff81ea47096438\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"eab378a67cc1c707\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"12f2e4ac5465f491\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"4c74ca2781e82b2d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"b54d17393849b98a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"ad52dbac69980590\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"fd60141b5861d1c6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"77a50768d4eaf71b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"9bfe0c48042684e0\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"63c9cf9e8e28bcb2\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"e450613e35728ade\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"927cff0f71237cf7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"ab884c2b93f1356a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"495d5844c1389b30\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"6e9d0599312aeb50\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"529fabb3b18ce002\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"402c20dc52a65f31\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"7065d24e7c02cfd7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"db12edb7224ba640\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"f1da14eed4253b19\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"bffe23f8fa905d0a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"dbc8a4554683b544\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"bf5e19bc02949077\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"096a0d87c4b9a681\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"3e631a061a2c5890\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"d00871925554bc8b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"fa7500e59de2d26f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"aaaea3c581613e84\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"bcb68b331e3520cf\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"e18937567fb5b22a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"94c1b803733c41ad\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"343caa813933c096\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"89a2e17230d6fb9d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"f8e1c2cd6951e49f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"5c9b22e503529ab8\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"e50dac19e3a50e21\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"6a8d1a243d869d7a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"6238aa7d23d20aca\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"a2284a517dc3acb4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"ea4d5b0ed8333945\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"63d9d3eff7cb3a0a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"020b5f8cd4b85571\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"d813d38608ba23d9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"9f855bc6f2a938b2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"5693eedd5f659781\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"fb5652bfb1691f6d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"e6b9a92e05418d16\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"0c86f6f744f77b79\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8cb5c8c1224b106a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"69d9e4e12e90c90e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ab8c3d5cce1080c4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2bbdb7d1a73abda1\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"17d135b10305570b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"2fd5c25045f697e8\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"bc964b090e0ebe41\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"552321427f79535e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"bf52bc550f7c7a4c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"75316f68413f0c3a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"321c26fd5ae4dc74\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"afe6004c42542ceb\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"b4b2d73a81396dd8\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"7647a01658e11c57\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"a9ff286581b7cc41\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"f9e8364304312786\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"c1331e27d655f549\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"df2364ed56e9f561\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"2a418c1ea547b049\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"44053a4a48fca0ac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"98151ce9763520e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"2a16e09d9752edbe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"38d5dba7e9b51827\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"46a8c613d99dee8e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"aa0f9021f2293998\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"da2c627e1bf705b2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"b5a1bf934d6969b6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"41edb72c52d63902\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"ebe559282edf0405\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"d5b2fa65c0a1edb2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"ce5dbfe009028537\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"752b7a62fe7b3e22\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"5b6518b23c5df23a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"94e8178d51b94273\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"35a9da50a4f4a744\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"98db7d6f7ebe0da0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"b12bdcdf00b338e0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"7a98338b7ea2ed42\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"0550cd8c017fdd7a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"45d6867cc2d5ef94\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"1f3667ff422fb6cf\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"399abc75ec20f2c7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"c5ec6b1e87a53821\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"ddc9c2b366d7a751\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"409de6cd9d4f552a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"977522ff3a61f01f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"9e50770cfa1eb77e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"5e11372e0a4fc6f1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"2ec354f56083c130\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"03c0f2477731a98c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"7feb3551865370e9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"d1d82e74620a3ff4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"cc08cc7d11372e42\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"0611053ffa46fd1d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"b0e7d4f872a8bf2a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"ac9e40f1f2d99367\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"dc7319b5a936d684\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"d92838bf2944c535\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"6d3f0817ae6ceeec\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"0ec1a7756bb236f3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"0fb96c0e330c8f7a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"62232cf108a34737\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"3b1886bdfed8f2ca\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"0da7aa74754249d3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"9f0f17c3b81b8e59\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"3bc7a564e1157cad\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"09791845ee4a7bc1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"1e2de573a359c8f8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"b6faaaadf9bb649d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"201fb1980fe1f13e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"c9efbc9cce72c7e2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"38dcc8b02f14ef3b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"c50632cf76b413cc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"460082da6b9ee02d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"f607345fa0873cd9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"d2db2b5e0a561879\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"4fd2152a708f3324\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"b2533a418a3d82ba\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"e63dc07a8cfb4bfb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"eedc4a6b24078c42\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"ee2285deef2bc2df\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"81195c95d94e2d8a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"489f4ab7e6475932\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"76266937c0b39fc9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"065e4fefb5d9a337\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"356d14492f566510\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"a595cfb99c47a384\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"4ecb71b1ea9e35c8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"8acb64661dbf6c81\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"acf618b5f278532b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"58deb9c102cc528e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"263dc0fa38f0fc41\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"46ab1d7aa675f94a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"1e1870cb6e0bef2e\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"56972bf49ed485c1\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"293d4ee2971b0afd\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"4fd80ad68297c2c5\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"0c1bd725dd482ed4\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"1c6a92b19e7b0b66\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"24773c0e8a14a1f2\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"dddbb127618b7b43\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"6106d655358cb010\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"1c4db6dd868c7b18\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"7aa293ae94459b5f\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
