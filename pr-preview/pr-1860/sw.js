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
		buildId: "5ee89a9b46f5-82514585",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"d8c4cf91207b3efb\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"d8c4cf91207b3efb\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-Dz6uzPi0.js\":\"04d61a1d21709e80\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"6e976faf90a29496\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-CoD-1j3u.js\":\"884815b3e54e7e66\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-Ct6JHufH.js\":\"1efb3d674507f9ba\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-JuQjAHjg.js\":\"d3416366927a0f30\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-CVUAx_Ee.js\":\"dc73bbca02192754\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-CSe5H0G4.js\":\"fe43c4922e2257f6\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-CiJn3JlD.js\":\"186ed1719962341e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-Br1LU0uD.js\":\"d370c84ada1b6395\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-3NeIyZwI.js\":\"4fa1aaf209cd292a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-B4C5JoGW.js\":\"145137ec2f89c82e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BE6z8hhK.js\":\"cb235054c15de29e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-Bn5EQpjR.js\":\"6e6232534acad3b1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-ByeEyhem.js\":\"ee74158a2d1734ae\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-C0Zppa3Y.js\":\"db51f62c8757d3d1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CCgeFNMF.js\":\"a3df90d6f7b95bee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CrG40cA5.js\":\"8959a8fc9c5e7406\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DJ6g1M5E.js\":\"40d8bd0b46227965\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DVIttZzr.js\":\"2f2c1127f49d476d\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-T1vzstxB.js\":\"7451cc783cd4f08d\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-DiQyRDtA.js\":\"4b830819deea9064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-C3RuDm7f.js\":\"e4d477fab0831792\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-C8FEe17Y.js\":\"62256e7b486ec3b2\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-DibUuidK.js\":\"36a347a2dc34e2ab\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-C8BL8mFb.js\":\"29354bceaa8d9a79\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"4b9e878eca36249d\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"64c0c68357b893bd\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"2b78e30a58a219da\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"788fd29abeecb36f\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"133850a8360da3dd\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"197fd8b7aa1e9d88\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"2b7b72fb57f2140e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"ec10de181c46d63b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"8924783e593ef006\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"4a817b488fe5732e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"82891b387e3d5b43\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"9d03c7ea4e13c01b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"bfe27c9c5ca22e10\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"e4e812b9622bd776\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"4c32f2e5d06d9195\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"cb9ef7cff1425035\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"1edaa37620a3d230\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"ee489f4b9c84a9e2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"f29dbc86a009dc2a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"c06c4e274d96d764\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"094481f3719e68c6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"d249abfeccd46f58\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f774a186c2df3722\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f2bbe99ddbf3d1a0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"9dbe36cf053d06c7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"ba46baa4b6022944\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"f7858309440eb7b9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"192a6f8e38c76573\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"725932117126b02e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"d7ab374e689e096b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"e88a9e9a6cc85a16\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"0281f958bba961bd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"a2c10cb884d39dae\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"df609127cf283dd5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"402b027a0377f824\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"b16aa25a0f7a0a26\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"da1e563a1bf7384d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"4fcb95eb2556d896\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"b910655f97f62638\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"69722070b94dbef9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"a879bf0780831f36\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"3d078d1cd5f9f08f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"57ee2f55baf69a3b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"c7fa88766faa7f30\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"1661842adb496ed5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"d69fa8ceb17aca69\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"4d244d47814c2e6f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"1300c9db80229f46\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"1183f25e05137b58\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"267641e5288b39f8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"63a6d642974bedad\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"adf7dad8bf5ebb2c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"4f769457adc231cf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"36770951cc603936\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"4c3a350ba6ed624d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"94d39c4323ab7db8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"d2b5c3f9d6229886\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"7b7f1f830c8cb7e7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"d89e3ec5f8970b94\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"36d3dcfd3f7ef20d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"1aba26e4de5930be\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6ace462a1b3cbdac\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"d70f063434f5380b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"3aaa334365def006\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"31df5c882844535b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"906ea2e42736b0ff\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"ad49012c823c2768\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"28a86430e925e42d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"06e15d7a15a23dde\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"68bcb05d978be22a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"9f1a82113a4f3623\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"34394bba7aa524a7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"5f1b2d3c19c3308d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"fc079ef2eb1ea434\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"06a6df5f906617b4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"0e7e7e8c0a733649\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"a20efb00e0045fb0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"3a8491c9454e2d61\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"8beffd4dc33ea777\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"5cc1a8ce88f35fd7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"9d7e8f608fc36c0f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"5cbdb66cd5d13658\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"14ee29408bda07ce\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"0f728c143f0c9852\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"f5b336e123bd6a69\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"95b177249c16bf83\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"58c822e686aa1fa0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"a40c0c8fc7cfe085\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"a89ba2116937dd13\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"e74dc3c33b00ee1a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"3bdd363cea75a4d4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"899eed88eaced54b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"b873656d4ae8fa11\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"b3e2df600253f772\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"5f0915bb93ceb264\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"acb047006c5d4d4c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"9189b0e6af54ae56\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"54e90bb46af6f9e1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"18a4314e2d688ac7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"6d71e9c5b381b4dc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"2b2396852f795483\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"270a455a1d49799e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"d08cbd3ab4f41f56\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"672a55011a238b2f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"2a5108e73be39a24\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"8203327345c10ec1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"7513136192cd1ed0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"e7b66af2cfef0b52\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"16916e03294ce7e8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"d916fd94fc3499c2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1e42baf16a3f2cad\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"c186e885e9f8306b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"85527ae79a68dcc8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"4359ae2eefe8c714\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"edfa0b4cbe689e50\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"13d3f705df0c9718\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"878c264df96f090c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"cf8cd1fd3b2d707f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"736eab128ca8bb66\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"2a6b7ebe677458f5\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"bac0c2495975e5ed\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"62c5c5331f319620\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"0f17ef5f06caa0e5\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"effea5d22953cf17\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"cb0c0cfd4f800a56\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"f1c0300237799bc1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"e90f1d15ddb526ba\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"0ef8533083a18cd5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"114aae5e0fd9d60a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"3a50cd26fd0c944e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"f7ce09b73e339cbf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"349da905a4af07c6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"8856e26d14675dcd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"5395a93274598841\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"6475ccb1fb648b8e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"7a31eea85ffe37c9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"da254429d3d720e5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"b7f42e58b7862f7d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"3809966973fb64fc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"9708169c4ae66497\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"5395a93274598841\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"5395a93274598841\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"1713b4f79d5f4c3b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"193ae618f1aa409e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"573ad48785738748\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"4b3e3084fee7a59a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"4404c0d997c49c31\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"b0d94beb10c8b556\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"58c59ed3d4759072\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"82e5bc6693a343cd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"2bfe2f40161d8040\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"7c9bd0ef7b822341\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"777e7e2d0f5cf45a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"18d015d96c7c4217\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"24b86e5078721ef1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/childrenView.js\":\"7f9ad4eb91401827\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"f1ed2d1d578ce569\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"bd51d589fd1833de\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"06143e78d377a207\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"886c55075b2cd10e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"d32682a7eb6f9735\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"7822c2e810b857e0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"fbed9726f015b725\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"1ed91c6f3188f699\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"8fe84dfce781f4b5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"5903b14eb2af53b6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"283c3e5f65e1ea8c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"fa374b3bb99645ae\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"5df4635b5e2eac33\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"3fba1ba5c9c85b87\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"d084108fd508e58e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"b0843f0cffbd182d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"7cb9c55eb60d64d0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"5fb2884ec2702802\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"a872af5bef902ea2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"163f31f0062e97a6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"7b40c19d968fbc15\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"523b92746ef4187e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"39c1dd0cc95927ec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"523ff3784c5f79bf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"51bd0ea4b94ed7f6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"a7ac9fa43ff522f2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"a37fba98e4dd482d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"2f022cafc0a9fa27\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"b1950047f36a9bd1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"7735c0f87450cc87\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"f3cac2c6aeed67e0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"3e06580790bdfa4e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"787bffc8003d6f4f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"e006b9337952111d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"8bd6091e27103ba1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"570631677aa59405\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"9bf9b14e1a2d9b95\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"a1ec361ac360b75f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"9b79272563ae5fa3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"64185411668bc52f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"943d80e3d03a727a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"0cfc56f57e451a37\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"4edcedfd97d142fd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"ec16a74901eb7400\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3d5cf467d3ec7ff0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"a25e1d44cc484ed1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"96cfc26d7d4fb99d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"de970c9488321e51\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"297c62a6cd9bdb6d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"efb6c16352e34159\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"addf3f9084cc497d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"7fabff75b512b58b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"35ab37f0cedffa81\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"44f815ebd7fc528a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"600ffdc6b5d8c525\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"a504837392a4f15e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"a826879ca1d9dd6a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"5c0f386ade78ab91\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"8e2e328b70e00a71\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"02ffd8bce4aa898c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"0c1e437fb3f4c985\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"375b2f0416d56bb9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"bbfd78ed6071e498\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"36a77094efa7b729\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"11f33c3197241964\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"7d16bf126bd0fb3b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"86e1601b51d17cff\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"a7a98488d984414b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"c43bf3d5e4925bbe\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"6c42e68d2789a053\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"bce052dcba86d1fd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"c47e1a8798266b9d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"f0584100ac43c4cd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"8675ab70320ac047\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"252339d10e1c6736\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"e20e314f87cd644d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"6e4dcf142ecf99eb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"5d2bc2f1c4af53b8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"cd94dea649d0672f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"e43bcb872b1bf0e4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"f7a12c64c7eb07a6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"604608a2f8452e42\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"f2bdb3fec931528d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"14f321c917f51249\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"f15ac8683fc2e08f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"9980bc65c2cea487\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"01cb14a37ffdcf01\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"1ecdad9be7f7e598\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"2415c119a4e7ad00\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"674793039fc7349d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"d7fa4ea392d0078d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"7c5037203af9c385\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"8103cfc458cc605a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"658ee28b3b7076e8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"1f74a03db0a7e92d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"878a628a76988f5a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"3cfd47ca196d8f23\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"07051b5cec2b801c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"57c56a0a7e952717\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"2d461ae2989e2942\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"378e6055076154a4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"48f5692e162ba780\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"8c070600e0813b2b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"2b9dc26be94283ac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"d8f18690d7120f47\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"701f982b20a78e67\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"dc8e9d9cbee5c127\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"b6d3796d3b93ae7e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"cedaa5f8f11a3911\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"87b20d5958d3ee92\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"675100847f3e229f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"b5fb6fcc2d8b8905\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"25de266492bce4e3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"091fbb7fec848f16\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"112540eea7574555\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"c083f982ba86656a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"03bf1382754a0ed2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"d268f97cafb16606\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"925cb21e1b45f9f7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"bd5880ae2159515b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"4a7b903b24612e52\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"3d7b77630bd5b4ae\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"941425840cb22df5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"24c786f5851288a7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"60a0dddc76d1dfdf\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"255e3cd19d9261cb\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"e63c68e2164e32e2\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"1625d2c91e8c5f7b\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"6cf1dbdba32b18c1\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"e0249f1312248afe\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"1dfd178b2ecf8be7\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"d3e4d14be267cef1\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"9cf35c54b7b1c23e\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"d60ff6167a83927d\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"13e9dedb40514c08\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"2b61efa9a08da48b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"e3688842fc862910\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"cef3a598fa1b28ad\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"38875f05aa35427f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"12d46f1f96ea275c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"74fd6d4095227f41\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"4c56a19ac582a57b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"f6e473a869fa874e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"bef0eec698c3b99f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"059765692f1886e7\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"3a33f11c0ef41805\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"2800a02dbd8a77cd\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"2c2c0530dca2e224\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"2e0333d54b14f38e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"a0c62664141fefff\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"eb9615cbdbe1a9ba\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"563345ea50572833\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"87db72cc53a180a1\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"125ef74fcf45b0d0\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"3bd2ffe8881ead16\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"4531f47ee11ebe8a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"3528f235751a593c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"d8f64df8f1482e6b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"488cb15cf79f4543\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"bdb8be89a38bd620\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"87c6de33468ffe42\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"5fd7de17388e2df3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"ec673c01b542dcb2\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"4147a1354631f01c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"3f64b2a644365488\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"06116de074176f58\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"f04bc39578ed403e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"a9be45b61db436bc\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"19a9232b6e27efae\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"79e4042aeda29817\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"a043d127e9d6d542\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"bb1b6fda19accb49\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"aa73bfded02a3b62\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"6a62c107d32b1b2b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"0f32ae72dab89f0f\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"1fbe40b36b397618\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"4cb04acded16f2b5\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"ca8b83b3861ad2df\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"3ea94b82ea1bb51b\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"fbde5750a634213b\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"087eeb68322d1d80\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"f8566ac42d8020ea\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"5c1a1e1c6a8a47df\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"b050843961227684\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"4c8e560894d12c68\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"00c0e4c529b2a45c\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"e003cd78e03f2c02\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"4b853b05901bdfaf\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"876e708ee1079897\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"088ee05e35a6cf4c\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"e0012a02aa366402\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"9364ab39ba59e168\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"d5b1954893f46c7d\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"9e5bdf78ac97bbde\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"37f37c37ee5b669e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"75b82923490f337b\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"fc1f2593788bcd5a\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"8a71330c24e482d7\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"ed3f52e12a57cee7\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"9a5cf8237d9b65a1\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"cde0ad9494f4f480\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"ab77c5cfb0b7b5b3\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"b63873f92013fc43\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"589098107dc01eae\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"c316d09a98cdf2a7\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"99d5d8355274eaf4\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"d107269bc8a986e6\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"1ffb6f37a46bf428\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"11dc575ce9cdd614\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"3bc2b171aa81855b\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"c8863020833b3af5\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"dd09bb32d3f75f1c\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"cfc6ebeeaee9bf36\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"a243bbf2a0eef95c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"f338ebc469f054e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"eeaf9eb3021d499e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"41b655c29d38d9f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"7035436a0f544735\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"de8bc2c919394ad2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"fc09d66f18b24575\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"652b562487d15a64\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"26fb601b9b02774d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"db3405e02a273cb2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"5523a90c144d14f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"57ddebf6dd262baa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7589c593a0a59559\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"fd7ec835d793bda3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"282216e01f77bb68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"739c26f89a57cc54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"015b535547599ea8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b2fb6ef4a63d5adb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"80fbcc86f3bfdb84\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"5b2849e9c7cc2257\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"0419c0ad2f36235f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"52b0cd6765ced979\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"77c1bf0fe1cb1379\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"c60b30f9b76fa112\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"f63d8e659bd662aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ed47df19a8daa002\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"24c926ff91d0ffe1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"45edfa8bfebd4194\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"6ff68b65bb0e3b4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"e71ab7880fef88a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"f5b6bdd305eb907d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"fa163b8a1e27da38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"186bf099cb7fe984\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"a980c38e67bdc9c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"5c3f27836583f15a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"7c1891f5ebf7c589\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"e7da6b3332f1cf69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"ac2fbd49e963d845\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"815876397fde936d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"20c1bb1ef3e95888\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"112be032bb24e57c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"1c53c07adfecc649\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"36a8b90e917db8e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ae93bb5aa56765cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"41bcebd40578f725\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"8cd49b54f0f09bba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"642a12ea5efb8973\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"8fa3a811a917ccc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"5b11beed0e3b5a9b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"6d1ee111be4f8226\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"24bc68282b0600d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"0968749d3265d71c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"661b8086584e0c60\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"5acfcb6859f3db2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"a95dddd2a61f75fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"a49de4e0d2c6c4a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"dc40d8fd4ee355b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"fc9fbde69587840d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"a3c50c52eee3d1b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"7249f50f08b474c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"540f47f240e301a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"6d8d346112662ea2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"12fc86a857e83a00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"d586eeb47f2409f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"96c96a8c1f97c403\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"73c4e345b9dc797c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"1462679d5294cbc8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"f64615f5d3a18e82\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"650b66670ce64685\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"a3ed0a82684633f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"f8aac2d97481bd3b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"2c8bcd3684809b62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"129db9d51f56490c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"4b8293b839dd6013\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"f66a0319afa8eb2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"acf9cd8e5899741b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"e8c115416995a9fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"290802c984b480ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"2242a4d0bffd4e4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"7f8257e240d972a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"13bcbe28c6493379\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"705c606ae249a048\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"7467d20cb4de3089\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"3fcda8827c1809c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"854a120b36b9119b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"7426f006bc2bc7d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"af5166ccb0d6f5e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"cfe9f6e60140fe54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"2855070f37f422ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"8ad40edf1045b901\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"2e2e1b6c1f5c9fd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"9ecef5490f249a36\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"4d87440b21a90987\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"8ec53d28e31a38c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"79251a447b7fe381\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"660459a49eb8a023\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"6d1f7ff5933c2c5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"e505c1dd238d0429\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"2c3ef04470558a79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"ddb0ba70ac7daa70\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"dca2d99fb344916e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"c31537f4d998cb48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"0e0d98c31c95864f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"8d83e503c7729420\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"30b845e87d1a16b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"4032308b0205d6da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9e605acc81d72acc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"96a18bae76db59fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"0615309d5df57eeb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"567d83441e9e2d4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"7a5d1ed87a93e0ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"32d9c9bbb8eb42f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"76eff707ecf30127\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"479c50a10dd89a2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/browserMedia.js\":\"c63adbe217f5a3ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"900b10291ecb5e2f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"feb90f7dfbddf0d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"3c2cdf4a629c27a7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"cb25236fcf6937df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"85010a08b6ff6e72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"01d2717897efa99f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"eccd2ba7018acd52\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"44bffac2b4646b70\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"caa0d2c4c8e8594d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"afbc1da43ffa984e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"35cf27fb86881767\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"b9311b8ad9856cde\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"cb1a9ad177aa5263\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"6314b7c43874eeac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"3f751e6489b27226\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"7ae4575fd5f7178f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"e7ea6106fafec38c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"f9009f668ab6aadc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"4ef9a04a13aaa260\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"29239f3951a80f79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"d7282704b74a4811\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"afcdb74ad3c59123\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"1b31ac79609b3092\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"8eb0a01eb3817d57\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5834c8f4e606342f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bd13c4af300d2080\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"866f225763265001\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"339c4b8e7143190a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"5b7162d3746db601\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"803985d43644997a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"04817d06fb8fa48e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"546f7954c3cb02b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"6afd597ab1e2d63f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9689bf3d3f04db21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"3eb7bc88936f3020\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"0cb33817bade775a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"a682fd66b265d111\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"807906ad9ca963b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"f00980bdc4e5bbf2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"73e5e1119c826f9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"7e42de27da32db18\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"c6236e0c4aed87ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e0778da1a66f632f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"e6d0971de836f9e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"61a8e4a3b5bde347\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"dd29fa0462a51569\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"e73b6f9d2d20be3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"1da63eb80e2d3100\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"eda48d5b0bd3045e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"670cca0947fc79cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"f42776c124b47c86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"e1f4e52279a4cfef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"352707c5cbe42c08\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"36dd399977c934f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"f028f6bd2b454d17\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"c07bde67fff3bcaf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"9dc247e253d395f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"7fd6066feb9a22db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"b6d1f8adee2d3b31\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"3489ae5489bff853\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"5025b5d41542f50a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"bb1a91d31c08b8c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"5bfe5e14bed571c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"5af7c49c76fef3f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"a29a900f8bad5e9d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"54f4404f910484ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"dabafcb1da2a1a24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0d7dc7ba689ae70d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"1433530570735a43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"1894d703a43db6e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"4ec73e40693d52e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"73c6ea8adf7b4b72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"3bbe9e0009d45fad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"f199d140d3f0d46a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"0da1c960a672c747\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"bc87f003d7e13bcb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9c52fb3d77632229\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4abbade8c8ab942c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e06ae2d2f2301926\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2bb8b39de2600b75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"ed09615ff5f6e86e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"31f6d334d0caf036\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"52fc9357c2c6e7fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f699953c4e1ea88e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"8f7977d2967949c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"e071f9fc10c17147\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"cb0181ffcafd83a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"0eb838e56d90c93e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"4c7b0a1f2da20ca6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"46e3040955150a0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"4bce2be991c9dca5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"fbb3bcb183ca34c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"8fde82e8051bd6bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"056b4ba0307d1229\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"7f4ccb860c240629\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"0ff642c5d487953f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"29934262093d41b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"1d42392168b7cf77\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"69131fe19b9d6867\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"833f7d4196f0c375\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"88eb731ba4d25796\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"a6c2bb5da0390545\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"7a0757d4f23bb990\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"434df56ee7e80234\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"e2ef0e105ff22bfb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"948341b9ce500c73\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"a19c2fde2453db99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"8547ed4265708bc1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"168f4b28ed759629\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"ce77aaf428aacd00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"079050a8be535cf6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d5fc4f45c30bc364\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"b5609e9b27381ce7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"02ad2c716ba0300d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dc5fc66e61cd6237\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"ac52d91effa53b00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"acdb53ffb0aa1c3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"193aa31b2218ec24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"31c60a3c32d35e88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"b6587b8d7def92eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"0f170f7c9b171995\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"71309a4b19888189\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c9f0606f64118930\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"ccc5f43533ab1709\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"23fb377b40df1950\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"ed5df667a33f8705\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"af2fc79498ea4fcb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"95e26c3ae18a955a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"9c3b1e6d7c272025\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"1e309ccfde04fc6d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bdda371e96d62e5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2b7df6ac01bf28ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"12c1922071fc30c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"0e726623972a0656\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"fe2227dff8e1c496\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"a7f524d2894ad07c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"084a6d5ede0c9c11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"6d4be0ee41255ce7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"511419f07a110e2d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"159d1826cccc40e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"e43a3b8b2e44233c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"417567c4c61c9e2c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"4737f408091974a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bdc419088ae8d058\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7283391c2853b13a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"370e9f199bdcd37f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"8fa3a6c247b959ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"7e5da452816ff721\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"461ebee811b168a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"4e86f09bafc6050d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"5fbd010ea46fcbf1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6b1db0b525cc1bae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"2b59afae5670bd5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"d365584c8992bd2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"4877c5303884130d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"d4ba0f85a9a9e733\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"58ab8155b598b47f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"c9878cdf274df9ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"925fa5f6975e0bb4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8300c7a6289cfd9d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"e4c1af2758d91e04\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"06c8251b2b97c5b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"efb2d3bde687b7c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"4a616b81b55357a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"1724eccd21646e87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"79c89c007c670059\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"79a40c52272b0140\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"a10ebcf6b99da37a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"e6926bcfe8e583c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"d3d15d229363c4c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"cd60da759976b89d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"46fae4e80c5808b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"188baa06b844f49b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"eda630b6d664a526\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"7d9c187cb85fe753\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"b8655246daf1f497\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"1d7777ac06c9fc10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"dffc46291395e2d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"3a7892679923ca15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"dc789a699d1a899a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f9c5a081cd72ce68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"f0e0a6b2dba8d8e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"fc5f39a1059d1405\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"38f87f726cdb5425\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"45d348e1ef66d16e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"bdf7362698b3c62c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5dd8ad36cc100944\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"c0df28854e76f817\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"8bdada59d5ac158a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b2e134b7fa2a3236\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"a90f3d93cb314461\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"d201ee78284c2eb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"005b3b492fe4293f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"55277dfd522e9755\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"1fc6c6ed5e553a7c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"3f44ab9225877ae6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"6678e021d7040b5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"87cdd001ac62ff23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"9877bbd99e2f0231\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"6b3795a975cae834\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"e8cdc3d7ebc77734\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"6ccd48f52e24fc99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"c8065a4e3459d61c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"fa4ce257ffd67935\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"1e7b2f2dccb2d2be\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"6acd55a356231332\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"b9f7db36e3d03ef0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"f244ea09ee6d489d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"36f611a06d0840df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"d2629faddcfab902\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"46d1bdab1b743a7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"49c42330b59871ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"9644c16bb3e49f2f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"bc8feb8e290d4981\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"3a29a82891ae27e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"1020b5378879eb8f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"caf5fc64ea2fe7dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"59f3921a0ad9cd7e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"94db3afbfbbe5fd3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cacf7681e4ea86c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"fdbf8d9d1e94ec37\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"092ef107a657f130\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"d76a40d195cb5168\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"eb78a5d9a5819f30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"b633bd76fc998ca9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"dafde77b59d76b98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"632b775e34e82791\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"e77c0b319d3a0e99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"c17d1f5917869dd2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8480b975c5eaba3d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1514f18ae0c46e6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"2bba82838ad3bde9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"3ea6e77e31e29a4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"f8d4577bfb3a0547\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"ed273c55e2a36ad9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"d8bdf03cd794cfaf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"527ff2c2f4300d91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"338585f3855dc190\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"7b61af0fea44f910\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"4092a9b0d516672f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"7db05eb1f1922710\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"3713f7bd4f229eac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"28feea675410b876\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"1287c2a9169d4aaf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"a4d15fff174da4cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"e1cc87fb55dce46d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"569620b6eacf2386\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"f2afb11106fa1108\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"45f2b068d91de00b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"bddf45362d429346\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bb2bf4369d55b507\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"56d5ca53b47ba7da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"f6e7fe29d354507a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"fc4ff6bb12bf101b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"340a9f4cee67d13d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"1c9ba4013d868d09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"73b8a4d9cffb65f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"20ae4166758be7e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"7cd861edef5e39a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"1add4b901df8f670\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"ce40c67cdfc893ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"6fb9407c03aea17f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"906a05ee22c796de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"7bccb3178bee9711\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"1b9cd14597db083a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"37007cd27214815f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"395c2ef9e42cba86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"e3e0b93135007c98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"f13442a974369841\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"b7744ee0261b5037\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"6df13993289224ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"aac1941bf5068f68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"783eb21faa1226a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"61a08848ee943d59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"113e6a429c413a29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"3de34ca96828b299\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"300f79c0d832f98f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4e57e00a2da52566\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5bd8cd5475c81006\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"aad16075a4661788\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"9f8290b31b2ad0eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ae72616942ff167b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fd8b5df0a071354a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"8b34caff5fa0496b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"13c67f5277d0916e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"9aac563dc8c4d46c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"49e3e660271035ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"839b1b1681a43fe0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"e12463538730b46c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"b65e6c526ccc5354\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"cf2e03383a56a5b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"50608c0000bd61ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"8afc41337a06b946\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"2cebbf1a4d51f0e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"12e1df0835a4fcfb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"d73e9b0d77656458\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"4a6c3e637f48e4e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b20e2958f1fb1e34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"3c776153639e76b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"a7942f8aa79bc1d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"571323930f422cb2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"91d97f0da4df1d82\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"584cf50a0b031bc8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"c8e8e815fe15c7a7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"cf3b63514e0b59a7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"6420673bd59ccc64\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"f3dc151ef5a15e02\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"2579396ea4778d22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"d01794f2953e9764\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"9946d97408d198e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"7d0a4ddb1f7992c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3da77bfb4950220a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"1966a99fe5cb79b0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"733adac3591d85ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"2dc4786a6ede67c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"0e51f3ba649dd04c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"691e181c4f347dc2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"94b4ada82cc7344c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"d1eb1a5be8fd891b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"0a9383ab45855a42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"01777519e8eafb96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"e123e18bf0a23520\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"e0a382666ddd9422\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"6db223ce765f7883\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"34b23c97719d30d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"b607a0fe67778016\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"b9853d6a69606030\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"cdc41e5dd9a049fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"17b9a07e4af2bf64\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"80ecde9d622c6009\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"274d55f7bcf429b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"bed360a5052c8ac8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"2fc648dcb5c5b5e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"b24a5cfb0838f3e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"ec72c94511eb964e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"4d24f523fc033cf2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"7052873813981467\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8f3ad3e88e58ac3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"a3cfca520f24f7ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"882bcc1674d79ea2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"21571501c52e9680\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"814d0ec6eebb6904\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"afe39114ebfc7019\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"9f60e543371b5b7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"174f3983baedad17\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0ec29824af8d1893\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"c451d9ac8f3fef88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"64340fed819662a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"257a3c9ea5e5d814\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"fc4416db2ae38eb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"fdfe88ea02eec104\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"32fdddfec1cbe04a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"867750a6bbb47644\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a265547def7861f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"29031eff78386d15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"70c0da75b2286beb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fdbdcec1b4bc3da3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"fc9c77ed29e4c462\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"3b16dce943d8a8e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"838425f5949c9889\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"8ea0772e0c90cb79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"01000022c7dea902\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"b6ddaa0179279c8c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"dc6a4ffa08a5370b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"7f004607487b7df1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"275327493a93d17f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"bb882e3313cfdb57\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"ca8a201ac91ed8ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"2a35616f71fd99ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"f12e71434079f55e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"e950375b025c019c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"6701618b1e105155\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"1c163e93d145c254\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"e068e951a45c7c52\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"61e1128d392ec6c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"9c724477bacb3b42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"9bc8e31b041c497c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"7a3343b1b0104b54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"26a7ed3af2331b96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"da40f6a1fca9e570\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"3c202870fd7c3509\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"f1a2cc1a530f4802\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"ca0deda0c9fb2682\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"8904b11fa0cf26a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"8495c370840b7c97\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"eed1d15840a85bc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"252010e54f87cb28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"ac2dab526d8f2e0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"0b6b03bbf0b86d30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"8e932cf91465686d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"893b71a6d7eb9b83\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"02a47350b30b6a56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"414f10cb63b5e3b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"d236cb341635c4d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"2c03c1ae1ebcdec7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"d3608a91e0fb4938\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e3d7ccac1ea5aa73\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"f6ce9a5d956e4a24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"155788d15db60bc2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f2ca9ae5c5b8472c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"3200ced18a4ed945\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"9ddf4f2c21df8fc1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"45e641fcb2b5ae9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"eff003048ca7b438\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"76da962971bdd268\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"545250c001c569eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"88954afe9de45cdf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"50b4133d70606ab7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"f343fc3e8083f403\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a4193f488a7bdcf8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"86da5cd57aca4630\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"c48c7853dd4528e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"17da052f6cc27c34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"e72a0e7c78fc4f75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0274b00f73470626\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6d78883e9f533289\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"e5caab0da1e944e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"bbf172fa3f18de3b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9f8b7618bb9a4e9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"887e097bab3c254e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"c8927d2c05f81854\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"2a70be7038d346e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"12dcf7f803a66b12\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"e9751e234a6b645c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"33376535400a74d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"1617177146389941\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"d300e31b89584acd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"8e716f1edcb7f469\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"1f4fb6b8cceb0f7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"c9ce594ec418353a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"2495a670d5cd433f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"3148b1d20ccfe45c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"b169bf5d6aea9189\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"9d90f7443fdaf5b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"1655f803cb3d87f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"c4cac69eb6357675\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"9b7bc048f3751dec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"2a2593a3bf901839\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"05f977298ad97f46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"78a0a354a078cfce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"58343feb84b9f595\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9da78e94b4b76da9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"9e058b1c275949eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"ef3106fba12661ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"3e0b34b85ef63ff8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"873985ebc639d72a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"a7d3e347012e9fc9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e2e2866f6866ddcc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"5ea562962d79ae63\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"fd6e608bc4c1c8c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"1d83b73478a07de7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"adc9e61a0c3b350d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8a7e0eb439c74f4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"9969fca0a5c2f15e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"387b94b1451a54fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"3cc90195033e8690\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"5e946c9ceb7c9226\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"d8e8eb36f51b1884\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"2eb29b83fc67b053\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"31bf1e2823f09ae3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"32d9b6bc5ee53276\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"60c0d119957b0ec1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"222ba77521aa6b33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"a1d4d64ade76b3b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"4f59afea38335c08\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"f77b5c617c2597c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"72b46470de70c0cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"b17c81ef096ac0ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"70dfa296fbcbd906\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"bd13631bafb5b2e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"769130486849ec0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/navigation.js\":\"57467c9bb98ee487\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"e9c30f78a0d3aeb0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"dddf8d010587ec55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"094f5b3ee428a9b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"a0fe496e88fae8df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"946385aade29cd9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"8bf3d67c931e27e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"c53278378ac7aaf6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"a52eeb62019c5d20\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"9540807bac258ed6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"04bda9365979d36b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"d11f16b082559039\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"55208f9ece53f2e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"9198850771bf5bd0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"615776c4c1c51c70\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"d61aefc130c262ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"d5b1db034f18fc4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"140f2a8bc82eea16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"7eb1d8f110a43f5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7592e2a114c6f306\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"d0bd9210a3ad7c9b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"d3dd261e2f22e6e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"bf5aceab5457fd39\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"31eb7d5b3b1abd35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"bf5403692490058c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"7a775e63b00e9156\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"4755f2637ba77728\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"cd304fda17238e4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"eccc03ea81222a0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"11bd3e60b4f507de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"17c54ed0d50cd2fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"776b76b3aa49ccd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"cc046d325b6b460c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"3b667eb94fb2288c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"ff04e565d02ea726\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"b80e2fd1262669cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"722f20362a2ffc66\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"f46570dc7406a0e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"c40d18ede97e9ed7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"e2155d92dbdfc424\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"9c1803edc83617a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"1c832df52282ae87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"30f52db5545f9803\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"bec72449fb0f3f09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"78f314808ce52c95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"edfbd2238486106a\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"22657420f717f898\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"51f8125fba4f4e4f\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"ab9817a1ffc58a8c\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"9818d2c24327122e\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"32eb23066004dc22\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"e9e632d2b4cc6e35\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"431cfb739f1c0ffe\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"695e803f720da687\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"367dbba0292906e0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"e4aeb096243f158d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"105d494046ded575\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"a7f6fae9b326db2f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"e08f2262d18e7ee4\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"48045dc8d2026217\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"c74ee0faa4ad790a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"5ce48cfb2fa2b235\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"a3ad4003c2433e60\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"027d888574aacec5\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"f9f246578af15a1a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"7b6e059b7e081d5f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"a40e2c055ee0673e\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"6df3d681d154892f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"4acb05525e711d6d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"30b5898807d0fed0\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"b5ec0be2b47954e9\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"d4295f59b78c2cbe\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"6196a291499a68be\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"bd4d9d6560d309e2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"f44f97822e08904a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"a966578efeb9fca1\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"1b5877863c2241ce\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"4247815377ada6dd\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"a1743405e3ba996f\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"30c5d60b22403018\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"61179330cf665e1f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"425df816feb08f5a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"a87e72076ffb69c0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"78b250533a5996ac\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"7ddef40f361cd214\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"bd76127602c95521\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"c75f1304dcc07c9a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"9c90b18dd4d9c307\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"17eb4f395dc06946\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"7f02062cd905b057\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"5d22498591bc886b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"8344b8f0e242da57\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"a773c4a5cb1e7d20\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"6ab2f6f8c7ff6eb9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"b873a0f112728637\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"a21456658c50b28f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"d28ba413abdae187\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"db2dd9edc4700d25\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"f2b83c5833596ea0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"82f692aad9adc3d0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"5204d7938780bc21\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"8037ca686995208d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"ec6efced7bd2f3bf\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"64ca7c6d3bb9ee5d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"528b85ed0927f211\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"a0f7cec8aa2a3fe6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"28c457e30f0d6bf0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"fc3c824ca278b0b6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"ea71be0e60a204f3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"d59d7e6e75a5254d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"3904c1aeb948ee8e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"f621462a4e737168\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"330989f8db157a48\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"dd3baf2b73bf4520\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"413d5f131fa90934\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"fa9b0c654435609c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"54a9883a4e44928f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"854bc11363c8a6e3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"01942dffc7b2269e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"17b2d12b7b5dcef0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2dfe1f84c54d43c3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"8ae7fa6af4d85920\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"9de509807a62b754\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"47f37a1ae6c4e6df\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"a4ddf14aad3f0125\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"0150f8b9a96dae43\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"6a22bfa77afcaa17\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"5e97b2b28dbb42a2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"2e2c76bd7d80624d\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"b5333459ed86e79f\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"631aee24f327cce3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"40c1a48065ae8bd6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"5dc32c840bd10fc7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"0cfd68c9398c1ba2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"6416b9a6c816bdd4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"2e04a127180b2a4e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"e947d004fb7b84b8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"ca35ea87d0903c76\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"3e72b85eed6a6dea\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"7284e7cf8a524c2d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"25a7331038bbd833\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"f57b07a01eb49c8d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"78f7d0d59643cc3d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"60c32b76a672fefd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"f2c2a8d190173856\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"f22f4c49f3f030d0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"58a946251523e76b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"ec412a10b89af5c4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"9671ac0dc200a097\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"939d376d0c7990d8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"135e4d0240a539df\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"a9d6f0a856c5876f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"1245ac18b08716cb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"77e0966760a365ff\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"3a5aae27d5507972\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"bda99abddb952634\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"6e3d01cac8c98233\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"21da32ae66042879\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"0fc13d1ceac3aba6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"702c50f1bff36c09\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"862bafbbd9373d1d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"e576fc3fb887871e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"50d16cf24153238a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"b19f50fdf7e2980d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"34e5adbd2481984f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"143c82c2a6a64890\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"209bdd75448e969b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"cbaf1c1429017393\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"e62bcb6f2ae43c5d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"c9fe5c8a04273b68\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"156c97a6ca6df78b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"7094adcbcfc7993d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"ddb9e60664ec4512\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"6b67f75c59932e60\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"37765e894f155b81\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"07983c2ccc17ce5d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"c6199db3c8afc23a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"5827ad601098d64c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"708ae03037e620e8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"2cb9398caade4c8e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"9e89ee2e88e94eac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"c32da9ff38b37f6d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"7b7bbe1ecb283d64\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"f526457ea46dda5a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"842cae1247e4d3f3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"b412d9edec2148cd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"1b857dd16b5d6295\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"422d25e2ae468d11\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"919ca9d5823e24b7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"864b1217aa668c03\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"2e1559f2659384bc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"4b9696dcfb14fa0a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"6eac5e00f9db165c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"03db5d0335c0cd05\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"e8e59354df5ffa05\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"66d299e1eaee547e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"8142fd139e3c144b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"b71b2a70da4b0a41\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"37f1943a6d098a0a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"46a0991eca1599ee\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"c8a10b2c628186a1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"4e2a8d569003a3f9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"5f34551b4f285fcd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"5e618b0d769fdd3b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"6421f42d4a0698dd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"56da4142c7ced9c5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"ac859c930fd6c1fb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"674a2e91970b2119\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"36c22965eb70d5c7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"cd1997e51872081c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"82f78c128f0bf919\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"95f09f26df1bfc14\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"5f219e83a3a9188c\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"30a4eeebc76b4839\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"c0f673031cc78815\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"c6bcc873c40a9638\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"42c7d5d9c0fdb302\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"9485fedde15c9701\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"3d0ba64d5e7f6dc6\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"05098cbcf32a1180\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"7ea715e551000032\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
