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
		buildId: "248275ee5887-b421e130",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"47267f5ca1698dbd\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"47267f5ca1698dbd\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-BXAQw1vl.js\":\"5360c5603284628e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"9a461d770142c89b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-BITHAGfW.js\":\"80149ec95dc045fc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-DVtdzHCf.js\":\"45504686f7ac02f6\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-bU0s9KoX.js\":\"2cb309143ec10bbf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-BZyC9PLR.js\":\"1ec891048ad384c1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-CTrs48wb.js\":\"eb2d9d79eb05eb36\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-BS92Anqg.js\":\"f736ab9f3f371f9c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-qfC4osXW.js\":\"72579c2718016ca2\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-CP0V9eek.js\":\"db899d00782e6b0b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BIu8WjMU.js\":\"9dcfc648dde690c1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CRqVs73Z.js\":\"569cc69823a062e1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CgPkYrzq.js\":\"a8eaab803ce54c1d\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-Ch-w-jRy.js\":\"5fa783b556c58374\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-D4afpGC0.js\":\"3958c438e150fbac\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-Dq44VQ5Z.js\":\"aa49b9296dddd00f\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-DGQVheLF.js\":\"64ef88a486349957\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-Dg95iuBc.js\":\"88a0574f30b24ab7\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-i29RHTSQ.js\":\"febb04e945809827\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-iHFomu8S.js\":\"73a1832a2b8ac678\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-mcQRjgo2.js\":\"bb6cdd27cbaefebe\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-zz9MIG9T.js\":\"9aaf9a1bc5fd208e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-ByVSMzO-.js\":\"3f0abb3fb91a9221\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-Dtq_66Gc.js\":\"38ef306c42eb9c0a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-8d-HWg9c.js\":\"1c87e3fffa2e1a80\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"7ac474c1fa47fed5\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"bc7c3e6058a49360\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"d698364262653d64\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"8732481dadd869f6\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"9b9a571df28051a4\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"5453c2658f790efc\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"b6cb224695671d6a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"895174a0a85a4ed0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"82c71bf5e5fecb3f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"927d7c6d9ce7394c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"92991384989d6642\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"fec274635eca904f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"c5abcd9ed18c088a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"4b850f3e2e8bab9e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"541b87e5997a59ef\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"4823e52d51d42e4d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"3bd32214d85092da\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"ceeb3178f42d403d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"9cef7c33b97cc687\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"326a7077391e017c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"7ece200db0329981\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"41b91047f1608f61\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"94d2a5b4e655035f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8e7ba200f7fc4371\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"e573a2aed26a7914\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"50e95c648363ed07\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"3376691c31d1884a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"a7e9cc60cd2f8801\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"2987a5ba2f330cfc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"1b3c1b99e50084df\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"9393df2f8d40b09d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"f5fc4e24809c701a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"f2b61a56a1da9bcc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"6da6d645ae96ec0c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"1598eaac6ecbc3ac\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"17ada133b895701e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"e63274ec6980cd41\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"f79164300fd80116\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"30d57cc66fbae2a3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"58e705d5fd2b3b4e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"822796fab7d8e8ce\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"fcdabb81d61f6791\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5a8e7e712f061ef8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"473f8909da855f6d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"ad322910c02fd1ae\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"18912f5334aa30de\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"c21c19c151dda15c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"92e949f6ed4dcef9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"d9903c5d7292f371\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"4f882ea6d05b8707\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"031e219712bbbbcf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"38552c7bafd22fcd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"9bcdd184f37acffe\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"7c1f85b2b1ec0452\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"54690fcc9bca4404\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"314982621df60f77\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"bc7c5eed9fa2b0cf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"bcfdac187a2cfced\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"2ce842e02f2e030b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"39ebfc9b50cc4317\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"68602e6464c4ab0e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"62347a5b43e86958\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"f9e1f5a215b7f291\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"bc1ee20759f32973\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"8639768bacaca254\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"cde0cbcf8aaf3e14\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"ff7bc53bab00ae55\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d9ca377cc64dd28e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"95268728b59f7e18\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"442e9bebdc59539a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"ee815a79aab1daf4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"4b2ed665d9a7d0d8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"d9c975aac6ac888c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"06f3a07903ececfd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"4ef548fce3d94923\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"beddd56c14918ee1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"ffe122bd78d09b2c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"edfa266b66d0980c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"efedaabbd44c8286\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"d115e40824edaa59\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"0ecdf46535867757\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"b4b5e0e4b9bf2c13\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"2354b0e9539016cc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"f27703f3c4960de2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"f61e84e028a9ee75\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"3b6e30e1f30b4e87\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"9bc01e9787220e98\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"68f96d56d463e9e0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"bce45ab8eece503f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"b542cc09921b7f5e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"386eb3ce60fc7d04\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"d14e842ecd1138ec\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"df09fdbd36431b46\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"d0a9fe47abc111e1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"233f89cd474e8298\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"67104519d4026501\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"5374288d6ee889db\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"cd63dc2566685369\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"f0edbfb1d2ad22d1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"d379b03bbe459a2b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"5a6d055ac585e360\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"1011dfd41272f071\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"94e57f442bc752b4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"8b8f00ef79048721\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"0f36d16616b26254\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"1c8ce61ae02c2d4e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"7fc9a1fb3c0b9a0a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"aeb3337f4190402e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"5dabf056c90cca24\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"f828f100203d5196\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2d0b07da88e4fc7a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"14a0a182e56cfea1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"321d5fdec3b8b8eb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"9f460e262484f764\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"37cd1891198a7be6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"6fd78622cb8557d4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"8adb9fb7933d7f10\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"c34706fd9116246e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"fa95416454976227\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"44b1c093e5985697\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"8e96600cbf32e328\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"3db0928003a49ccf\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"58ff0b3f9da1b88c\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"b568bae9ccc309d7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"a9d94954032c35c1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"8b9f52bc005c4a94\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"dcc24fbefbe3df06\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"c954bf260e8f4b78\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"9d2367e539ea46ec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"28f3b03c0f8b44c7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"2e0b7e28090bd62a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"ff1d125974797e50\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"ef4a6d6f6c4b8003\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"9e703d400d6691f4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"9f306199bbd54c26\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"0fe0e0d5e309efa5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"e94520637fdf6ea7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"ffe34dc1ce672daa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"2110fa50cb810e2b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"772ab6e5bbd156c6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"9e703d400d6691f4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"9e703d400d6691f4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"538ea237390b796b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"af9d4a64d9b9700d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"e68040d088c32bb4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"51f8bdf4e10b12d0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"67acae33c3e52c53\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"f7a1a2954bf513f8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"8c6200b592fe5ccb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"e087efde7449e09f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"9497115315df0214\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"8465b67e67136e3d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"ae11e59ae1e07b30\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"f3293ace9f3a5abb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"1a740130e9ee0680\",\"/knowledge-medium/pr-preview/pr-1860/src/data/childrenView.js\":\"5f79fc1e2ff6ee75\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"5232974f8915a246\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"6fd7c72ce0038b92\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"572fa4db999ec5f7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"34da4343e06f3406\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"92f0c7c8c0f70316\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"6762efcb064c45ae\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"03acd33418f46bf2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"af9d609349621256\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"5d0941b4ef0020bf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"ee0457b486bbe06d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"b5b3b6efc9f4d018\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"f1cc7bab02a29bf1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"34a59df96311357a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"83a7841aa2020009\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"74e5085822f86c57\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"1679b8d8bde2101c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"2d6b834991c67b7f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"97dd74bf4d12613e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"c3df9c86885083d7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"896273aee9158069\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"008f9bd69b5730d1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"b8c7fff78ccd617e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"649a7b175f71a329\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"a26031434d7c0009\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"594581130fc94fd0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"b6a08984eb596cdd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"c8bd51fe740b2d61\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"68e07d57589bd26c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"bc2d8b0daf0d10c5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"df42741bfe8f51ee\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"31a09cb26374dac2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"0fc370082991e169\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3e7be9ce7367247b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"719b1a93a344452f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"c5fb93255e36e7e1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"93b615b33b1a178c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"b76344ce91432960\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"e4f0385d5f52affa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"ac4815923381f84a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"a5a34dc602422a74\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"c9cbb2c78c838023\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"69a2f0ee6f0b1e1d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"c0670b3adfaa6c25\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"0aa413af94070c61\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e8121b6716a65171\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"3eaf04d46cd0ae91\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"794d674f3eab7a4c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"8342cc0c9ddb63e2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"2dbcd18decdc68e9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"8d30ee1e9b83984c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"ce7ee91edd17e7a8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"0a707d983c4d41fc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"15562bfc7d18cb5f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"83c622686b7021ef\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"a804f68482aa0cb8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"c054dca2c4041e54\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"b06650655ab988ec\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"19a4ad4facd815ed\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"4bbd73433e9b0a19\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"5015002aec1ff0bb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"92d9373d125e244d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"f533d876b9983e23\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"a886e8cc175c4e57\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"9bf6aabf0ac9ad7f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"b2c3a9fc851ec9ea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"887fd307c76c1937\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"eb2c4e8183daa978\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"feef019bb0ce4d0a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"e521e2c52b7a4f00\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"10468cbc2cdafc92\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"3411e4b4eab28fc1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"5301be0216948441\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"59156be1cb564c90\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"b3c05f70e9eba3ba\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"7c51859d045cc406\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"5dd2a6cc8a67613c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"16f9eac73b7a4560\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"a16c46e4f1f09154\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"f0455d3c5c9f0ee3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"cdff162de109bb71\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"b9f462d3321be429\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"6bba6df7ae73ecdf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"c220c95331fc06a7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"0c426314832d5fb3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"8ae226268a5af2ff\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"c4dd0983cb18e474\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"5783e3d88674d2c4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"cb0a642a20be7545\",\"/knowledge-medium/pr-preview/pr-1860/src/data/refTargetComparableProperty.js\":\"bf6395b0d542a21f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"fb639fe317dba353\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"5ee8a02547643d5d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"201b68d4bb30a64f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"a52f6e1f03e3b31a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"6491fe1942bd346e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"edf4d0a60aeaf7b1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"f7bfad4039ff71ad\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"d2dec171ee36d25b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"e7b55a0efb534e4c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"598960b494062f7a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralInsert.js\":\"979e51b60c754243\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"39fc4eb63050479c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"f1e92dd07227383f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"753578323df8faea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"69d3cd4cc0218369\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"d1849c427585b690\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"fcade81f5ce56247\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"bfa815fc55170f27\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"30c83eaa2d102110\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"4aa5e8909d498665\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"1df0e13bd73895aa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"374e8a56776d8819\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"5b373e71fa30dcc8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"be94f1057d0dd657\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"9e7843f2ade4451f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"266f9532e5c32a88\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"657722db33accfe1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"00c132b48b68a484\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"63a9cbdcc83aab43\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"040119ecbdd4875d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"85e877c3785125a7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"02d40e788c30dc49\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"fb86df99bf42b043\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"115b59b8613a0d70\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"86376c3ec281745d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"5b0cf586ae865d7b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"03043ea315f8b3ee\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"3c7f2c70355b5a79\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"e2e46a08ecfb211a\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"8564c341c578a322\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"7cc3cb401efb0450\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"e3de7d7f2b8ae0ba\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"5441b437fae63d08\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"a9bed6818625d593\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"76e4c8bbc214f46e\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"c158f7cf14e62cbf\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"ad68c5f665ae5abe\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"f830ddc7506c29e7\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"808f30c4b73e7c7e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"377e4be1576d027c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"454bf7acb4e72477\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"31b28ec1d0ca1cb3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"0c16e8c3278bb709\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"341263e39a7c75dc\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"c3914190213eab24\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"cac883a9a28ae4b5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"14d5ec68670544ae\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"38ee6dc72f1648a2\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"7eee8ee19dced108\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"7fb05e0f1f29907f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"c34c243769baf1c8\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"cd907f36d5b3c673\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"650278660fbeca9c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"fd35398a9721fda5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"193d9feaaa2199d4\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"f3da22d766794ff8\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"988351c3ee0127ac\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"f40deb2f4ec1c9f4\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"46dd1e2228c29675\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"25c2fa3610503c6c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"dac0b6e08a6d4b5d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"d6f77ce7adfdfcb4\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"d854aa0d5f49a01f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"3a60aa061b896996\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"baff70fa0c777c26\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"4e23744f641531d7\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"0219897b44cb3878\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"76c741d3e9b98e82\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"291a8621ef553109\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"d6ab6d057830ff91\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"63247dd0d9243363\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"ce4fc51c9a33cddc\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"ace97d61945c5024\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"31db2d46f011dc25\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"111a7197ada879f9\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"42e402119fdcd1d3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"6e3d2a522a40ca1d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"fed3fb96ffb7b0f7\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"4f8f6e65469b1f4a\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"ed87661fc7ad9f3f\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"540ca0b499343f92\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"ee50232a438f9e59\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"e7e365aec51f2986\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"42b912b910e55280\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"9cd476d4b79df790\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"389c0cef17e5cd3a\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"8a1d9776c569a7e2\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"8fee4d3de6993269\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"f7796a6bdaf97634\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"70d780409a30420f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"4a638bd3b33c0a1b\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"5e8e5f00b9399dba\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"7ee077dff363e007\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useFacetValue.js\":\"e743674ba943070f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"d220d5914cbf3adb\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"2515c2700b2cfd80\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"c504743050aaf89e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"49bae060de9eb363\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"3bad9b2a37673459\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"c1bd13e44a9724af\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"268ed7a38e9d3183\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"748d2b2264591201\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"671b39b00c7b88de\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"5d46ab07fb52a7c0\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"48f1533e57b82789\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"cee82d92a772bc29\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"8e39815cec17a905\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"48c474d0108dea40\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"b63070d9a0936878\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"d2576d725e787494\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"18696e269b100d62\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"ff3e0fc77a5f9233\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"f4bfdfbdfb298f93\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"0da8dd75e82431db\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"ca3790845cb11407\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"1c9053cc218f8ef2\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"be6cc31df9362d4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"b6098afb8caf3049\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"f0bea15e89814b1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ec7c7c4570ed02e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"65f317c39dd93c5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"455c0c47c6149142\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d7379d3671cb6b25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"808d06f2c69fc557\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8e158c455c289e17\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"ba37469b8b6d48f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"26d36e6567a8c324\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"73927fe85cb1054f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1ed26d3f82ddba56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8afce5d8085524ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"408d94044b497dc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"83f963503e63dca4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"487913f085e1f19d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"009b78ef5f1cffbd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a0d0c4101f7dfa0b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"780af44412b37fd0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"d1da1454d8569bb3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"f5b76bd35d7386a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"8b5dff310246ba67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d33e89252794264c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"03a683621d1601e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"67d8228d06948a05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9e1b82bf3488eee2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"198064da3c424488\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"0e72f106d6ccdc7d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"c4fa0fbae16f74b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"90686961fb054c10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"f550d0aa332025da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"0c8da0448b5e9321\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"18f882be5193a77e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"951af0c12faad93d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"c1780bae4672d2e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"3724e281d8998312\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"03797de73cfb43da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dayPropertyInputs.js\":\"b934fc3366ace50f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"dc4bb06c328fa110\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"25e424870e881919\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"ba476ee285408d8c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"e1b3d90d07fdd672\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"447b9d4969530c02\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"38836d9ecf901521\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"519adfb1bbbd6628\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"30d48d6df96bdab2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"8cb0dc49dd9a2fe6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"c7da9339a11a3b2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"d9f124d3d2abc532\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"49e6053c7fa7ccac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"59723191cca16191\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"293bf2bc428b25f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"542a602ea79355a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"c564f165578ec084\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"dc8dc48caeed8cf6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"8b6a5881f2b0b509\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"caf0e911894197f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"986874670c48b2fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"4414e24c91d70495\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"e67fb0c9e1960e52\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"9aa1dd2745a24a95\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"02b3d344296b0938\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"9276bdd6095999e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"925d0a7052a34ae1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"49d11f013485ee50\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"644333dd33b067ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"fede57bad80be63d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"fe80326e575b7752\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"e7343db9971f278d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"8f1c5a58e0ff9ec0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"67e0c19e2aabb626\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"b66b5f669ee74fc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"ae498894625e09a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"7cbc3dd413ddd94f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"f166dd6a7cc0ef34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginAnchorLinks.js\":\"49808d693301cdda\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"0cf453cea9731a79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"0cfa53555c801ca9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"5e7a2bdf8891c0b0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"49868a8f2800d5a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"4c6d33688196e0dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"49b22e4bfb250106\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"d603f63a658e5bef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"464cca233b1b02f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"7b3d72b97a72d832\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"fd3ccc3499d5a4a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"3c4a488e866488c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"954610a1cfbbb340\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"6426fc5a14522307\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"746b5e0843f41510\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"caa7a8922bbe42a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"a2aa1408353efefc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"b800e74bf62bd92d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"c06260378dc6b232\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"ebf6721e4dd32c16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"49cd91fd4dd5cb6a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"792fc06c9fd9aa2c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"a61c8ec17e3b866e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"03f795d3ed55a113\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"af203880ec2a63cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"79603ac1642ff0c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"5d5e5be963eae89c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"38e2e8e5a026371b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"a946c430b500da52\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"1e62c375a07a4465\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"e5687cc27ad58724\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f4e9cd6d9b4adaac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"2d5de399d480f5e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5a5fd018531910ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"680c36bd0c5538c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"c1ffa3f30a07bb9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"99ef9b39d617f85f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"1123a1dc68cee470\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"45d37e49fa8bf900\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e1350a9148517c3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"9682576b1cecb37f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/browserMedia.js\":\"d49cc27c4a25689e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"652d1a723b1068f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"e9b51981c0936ffd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"0610da9d1a146ea3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"cca1fb246c973e35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"1fbed77e72cdd567\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"4d80ff3b34db8855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"f76cdc13f674c4df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"b610ddc1720c9b49\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"1d9372166d88f601\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"532627f0cb3c35b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"6d5b53a6defb9b9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"dde951094d99f0fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"ed7d54a4312cfb6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"3041c2b538f05884\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"4213c69fb35b7bfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"562344023b623da5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"96d3b1ff21d05409\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"d949d831ded84b3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"29a09ac15c5bc3b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"8d31d19a16ac6b44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"95152f01eb828274\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"9db745e104ccae74\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"17d9ac734a35e828\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"2f795ca599ef593e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d170687aa8c1bdf1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2cc975a4edd890f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"92bfd11238d8c33a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"b1ae0aeceaf344f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"d49cccc2fb87679a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"77029a9ad53a21e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2aa4db26ac453081\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"656a887eec5cbbde\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"03646532de4728a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"76d6811103aa263b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"5742757001e278bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"e70ef14e45ba2e5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"ef466e7554a70599\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"60130fb9a1bbd8f6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"9828fd740004585d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d564cc7e984c12b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"e901ef23e34845e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"36597149770a9240\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"218376729afbf452\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"2e2c0d421c89ed97\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7dbb8251e88b991a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"51176850de58d375\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"df304988661adb6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"fd9faf1f8543c959\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"217332541ee06925\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"7d9cf8745ac0b0e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"63422d92e1e9ff14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"184afe286fa4afbb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"9172184e6236982a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"19f25e027f588782\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"8aad0634ff52034c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"21d1dfafe057b754\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"97e20ed6b2e2764a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"798c2f13acee603e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"d1fb683abe3b8c4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"b7f366e174cbd189\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"7399bf37850e6083\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"570aa8298bef93b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"ac40edf6c41658f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"cdaed8f8b6e7fecd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"332552ecc51e0fa6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"3121b0613664a2e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"061cda1d88a263b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c116f11582236d21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"38169e0fc25f4186\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"44ba3920d48504ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"8a758defc8d1b0d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"6b51d02e4a3e800f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"566c31e3e0336571\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"a52cd31ae7c0036c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"b476bfb97a322928\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0c3665f3d891d190\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1bafe1ce5743749b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b3d0652a0f08247c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"535f762a0302e6a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f363acd7786987ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"76ba869cb77a2de0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"78883c0d546f2ad9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"bbc34fa67bcce370\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1410102dd0a53578\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"390a8daac2c63b79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"606b9450b2885a70\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"e6ebedf76b0d8fbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"cc5ce3f00ffad6c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"d5a858f70fe55d8b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"79da176c0d203e9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"c2ea170c827e95fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"5a83656dfc69bf93\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"43743c59306f43df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"e03dfe405d2d4f6a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"9e025675663dceb5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"6cd259592f75f971\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"925a475b01c11aa0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"3ea3e87600db819a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"1d8dc65bf6e55970\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"5e0d7a06fd36cb4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"2ccc520ba32086aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"dab0761183e1e748\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"222a3dc38c616a63\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"1f8aa140c8aeced6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"b5ea804a9df4ae7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"98f42f712cb5cc9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"9e5eaf2b067c09aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"d0c1f8bc5a94277a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"ca8f38b80b86bbf2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"0d757ac53031bdff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7ff4d676c7b5d862\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6bce5715191d62e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"55f85a7335812a00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0f7a16a4fa631918\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"401be535638dc6f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"897353318a0bd1f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"989ff9f43de4a5a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a246b915e717479c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"9fcf348a48a778ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"8736737d85401c50\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DayPropertyEditor.js\":\"cf2866c5cc74b2da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"a52f7f22542d5ab7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"62185458c0ce9138\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1e211df69f95ae54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"3a266b16ae17151c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"a505dcc72bd8efd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"85fb4f3cf9d89d17\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"dcb67be635e20a22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"ea849aacb64cafb2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"b4f35b14911ab631\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"9fac6dcca1afd18e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f92a4ea122882bfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4aef46dc64901045\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dayProperty.js\":\"d4ced527e2045898\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"0418d2f0e6139261\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"749f1aa7c8c1a61d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"6ba51b83cd43f0c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"201f79224f8a7ebc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"1c61c36ce31a8073\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"4f11fa7a07c698ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"44611c23f38a789e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"5f86772c92608220\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"e8541529b0eef794\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"fad736bbe0de9a68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"6285b20fb397ffc0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"917aeb46db61d30c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c107486f2044e92a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"4f5ec801175d0a11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"df83a69d4dcd92bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"7213f8bc83c5b212\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"7ef4081aa124bfc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"a78aefa2e0e68657\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"a77c1faba7e2e033\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f9054bbab67a2734\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"cb5d22a26c9a9804\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"f0158732428f6e74\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"4d86c3edce1f4e35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"4e3da46dced38eea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"5782669e5b2b907d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"57e32c73966136c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"14b2a2c9375ff364\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0ccfe27a5d69209d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"60071debcd2af474\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"a55811c1774b16af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"82d3ca93c719651c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"e99172d0b37770e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"6be358878251c29d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"b8e55d0ece35f624\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"a98300829e5955e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"baa0a72464d33021\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"b6befa7e70a36a11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"fb6d6ff53666d884\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"262e2cddca72f24e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"0e4cf341f4dc39e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"7132e52412856cec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"87247dd170b2287e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"2c6bb51a781525ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"511b5f318630942b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"3b161413ade5ef76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"1d0bb720c72ae1f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"b8febfc18215b178\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"10bbdfd26a1d73b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c22445912cbb9d86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"91522fc29705f4d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"e545e0ac27b49146\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"95ec3dad0386e9b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"ea87b3fd195158ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"9c97afdb42894260\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5a47aa59f04e63a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"0d4bf31d51434665\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"ba11eb074d56ea03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a5e8d8d60ed09e2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"6018167ac2c2c8be\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"c72f93a7030a591f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"14e36deafbc5a821\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"0961afa16be8f4a5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"75f1563131260699\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"b184457a5fdf785f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"b4ae470d622a4eed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"8bf757e7b6b33f20\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"fbbe3e7c205477c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"e975aaddb7a359a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"4b557a8a3dd306af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"bb538d2962b91c5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"1edbe3ba68fae421\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"a877edbef5302e96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"44690bce9d7a7286\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"e4c8a41c9d55a58e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"89f2d230e803197d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"24347df5c36d9031\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"b1b2b872e64063ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"66cd52f5f2f913d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"d054e7743cf435c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"f2ebbefc54fa02f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"508c19deae4d3c61\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"5b4164cb9d8a8bc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"f838095167491a4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"7f58e2001ef3f4c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"f8c695dfcb6544d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"9c3397ae0addc97f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"769dee99c2a38910\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d3f915a0f1787fe6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"32cec753481897a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"f34e655e3501a2fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"e735ddbde214c76a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"bcef00bf443e7b1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"aa1024931ade0621\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"33a24444fdc3f447\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"398aba85ecf98f06\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"53e9ff7188c7f4d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"7b63e8ff83f38852\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e481cffc20a78977\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e28996c1627755ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"a50cf405ab935fdf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"642ed84875c21c25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"76a976e98c222e0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"17721a135a476ec4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"65adad7b1b7a7a9b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"e1f75217449316cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"58a536aa2d0892c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"5ce6366f67a4528d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"86b1f1eaec921033\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"f39f28b6c53d3c21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"6451706a28bd8af1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"463ae3968335a45a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"9da448673b2b1164\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"ed4f750c5521f552\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"3caf2d104d2d8161\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"e6db53586c215c2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"044d3cefbb08b9df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"1dda340056a3b37a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"f2273f75e2e33a6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"677ac986762ead48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"644b37007ba4d584\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"3859d325dee11bec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"92a3a7c24e65eabb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"94a6832f26af48bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"7d3ea502118d0499\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"f18387f92961c711\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"a8d3c63c3cbc4efb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"e15aba7aad9a49dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8bdd3fc9d81b9fa5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"6eb9a31d9ca07c0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"9cdcf0974985281e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"ef53daee9e9c7722\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"00c38da57035ede9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"1ea8ff6dc93010d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"d9f5b26bee81fa2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"1cc712a328d924db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"e2d24656499316ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"16e6e0d34ca2e133\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"e3f52d681c8fbf30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"f9f225da0203eb75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"82bba89c892b4cc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"432e3f8879e0d6b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3fe69d3c57916fbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"426fd9f1740757d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"4b8f7a744266c74d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ad59a0ce9066d4f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"66b5b329a8374057\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3826d82bf96e9090\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9a1738ac7ff0b8a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"8c8c340eceb05efd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"26b4bb69566dbacc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"901b87fe152a7df6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"599482e2e9c3856c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"0ac4b06c19f9dc32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"5f115f92400e40b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"bebd2909a6a88069\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"d3fce1baf9f93ad9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"ad81ff0332b751b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"222f2ebf28d3ef86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"0bec78eece4f1b6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"5afa05ab5efd7715\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"6e35509c6c64d85a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"3fdd5839ef004b81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"79688cce26b88f99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"1c4934a9e7e4fd0b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"8cb2ab621c6d4f6a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"75c323dd78cd7268\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"b37e713ca90f83c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"6b610f20b9589eae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"2189182000df1e86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"fdf00adea2d3447b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"1e48df64020d4c8d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"a6f350ef58de9e03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"7fc1a42e2ee026b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"c35d669a4eee7408\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"92b9223de0c29313\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"f621000495fed72c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"9f7b8eb64c08e5ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"ba92878e3e9841e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"e61366f527ab791c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"170f4afecd9d2550\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"753dba0e350eb07d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"6f605e45b99bb1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"c295db8c041ec7cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"af7d60ec6ecc371a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"541598db25213c7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"dd50176823cfea96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"3be0550bb0afdfea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"357c77dda2093342\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"717f0976424532c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"6ea9552586ebaad4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"1b4c66cba56b25bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"39d94b2ccae809cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"abe7c927b73e6015\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"81e45ff79c83758d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"377cee448d34c181\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"57569f8c1b93bd37\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"32a6d80e192b07d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"08c774cc110c9e1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"9240c691e8c3aad1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"8f989fa9227b4899\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"b88d71dcfc3e91c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"db8b2bd82be8de86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"8aa94b9d0419805f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"e54109f666241f59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"f9f9010d6d5f6b8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a6cfbb5bdc18ed83\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"e30ea70915a64220\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"62e47256fe7c62e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"01614de494dc0133\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"d6f6c860d7fdc144\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"7af9d1afaa2ae5dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"7ac8d49f8111ba01\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"92296c29135dd1cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ac2cca20cb33949a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"1621dc8b42634c32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"f35f974afb778e5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"f104b9fc7dadc5d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"85a4958a803e0a8b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"8d94a939f11c2eaa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"944bd4adf54fd7c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ec6d86b2700daf03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"84324f1024f91969\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"c1133f1881be052d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2d24920171913f4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"79962a0edea710de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"290acb02b950b0f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"5918f25e80ee00b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"87ca061582b03597\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"ebda911843b277ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"b61c7922a87e3f0a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"96f628d7dcb4386e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"a0e5cb15ffb520e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"4bef82763f256f1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"cec0507dde55a967\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0cd7472d4ee5b803\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"4ec360735b54430d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"ce1c4cb1d5d61725\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"f32649ad2fd17388\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"2df42301a6d3b497\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"bfe616054728d2d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"ace6300443aa4a65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"f5034ae546b3795d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"920d9b61d0b2e958\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"658cdfae0619aef8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"1806f9f9f2c92e65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"d2b199e209432928\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"4a1a14ded2618dbc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"647feec5ab07e5fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"1a602fd97a3d3edc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"1406c357f3171f27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"a1451a463498f9b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"a5f2ae6e26d60331\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"1a68efca0485b724\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"6a19a1bc7a2dd640\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"6d5930b1c42d71da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"d58485e2cb3b983a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"f544677a251f28e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"3e1dafb8b1277be9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"8d06d642d5a36631\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0f10673f34547714\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"63be4b66e94a615b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"bdf599f056cf1698\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"10ee435f5e437036\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"b27cad4b4f4bdb65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ae5cbcb0e98ebbad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"ab7b9c82d88c940d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"5070c621fefd150e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ab8ac15917d67b7c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"0504d8d1bab96368\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"832a5145d8323533\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"cdff71e5b0145c8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"c9f9e35738f79d5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"51c800fc71b6fce2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"6e7c70299f27fb5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"838c46ad4157d465\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"590736aa7df81b43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"d2ac9c219234b997\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6982edcdef2c53b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"3578028728d7e81e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"09c029390b3a4581\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"77b5ac5fd371b4e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"22a349e7b701b30a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3fdd25d9ba829c13\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3f9b11cfa1ede4d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"18e4d116edb4ea69\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"23e93a69df1d87e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"da542d5d2f5007bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"13cd784b4805d5d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"9c00dbfa6b727f15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"356f1226375cea26\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"c4bb70e3d8ad7623\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"60d2a67f155b07d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"535402cedcdd08e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"041541378aee5dee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"046cd42fd33dab67\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"3c54f9d072d70c9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"8d3d412c2c4e8ef6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"dc7f21a990c8ba27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"1e08f7bca759d887\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"07575c94c188984f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"a8f22edbcc61a742\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"a97a9adb1d215166\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"1447c1d90e47fc9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"5965f2b8661c8df0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"0e7f17aafc5d541a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"e7caebb0a5525e10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"59d19b275f33894e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"27303adf0f3ff1cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"0da58aba2e88d7cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"34d9319e7117d104\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"25635ee854f7fbc8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"0edf2cdc7d60f153\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"f3192b8b92662c5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"c2856f1038e06d33\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"96095bcd9369b383\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"47848836f981c7b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"8a8a9a775e4760cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"a2a6698afc773cc0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"aca3df6126e433d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"48afe42372f837b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4ba14b8cbe87cee8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"2b22e09e2af098db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"02bb3926f3e598bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"c99704197d06c9e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"cb06a00b7d354c31\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"79822fc808c26252\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"a6fcf854f07e2d80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"27d58d6de8845ce5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"6038d0749a3083ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"82339a5d055329c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"8a77af9142ab0b84\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"0685731d57775848\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/childrenViews.js\":\"9b370a448fe74aa2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"1fe191be6ee5e336\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"395fe6af9606d3a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"6bf40893be903783\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"376d19dcee5ec5a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"01b0b842f81007c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"dae0464715b06247\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"e02c7a29284c660a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"b577175b827b773f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"0a87b4c8852248f6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"fc98a3e1982b42ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"30e6264a0ad52132\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"d94635343eed068f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/registrations.js\":\"165e514fc900f5b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"7b452e24feb1b5b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"2168a56fbca8868f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"ce5eba93f6b264c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"94e62e0940e154f6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"4ff01a7e21bea8ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"166be607596863c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"c36e13fb4ac13295\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"b491946cdac26c54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"adc6e4715f1927fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"b24a35c774419352\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"1c4fb4e9bfddee23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"2b20d602c2b3033f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"5bc8fb8c10e862ad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5a423d0d87ee3dbb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"048cdbfe87cb6efc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"2814b377364daa11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"da2cc759cab4a351\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"73e7d71b89cad6d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"528bbd52ca62a79a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"b7b0017970d4be78\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"d20ba503b0a86738\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"29882478e1d124c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"b57e61d1d0ff8fa1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"18db836865d31d49\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"7868b3efea754b92\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"94d3350ba6bfe4e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"c5ac4e8705820bd7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"6c624b059b5959ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"583137168a3727ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"1ebbc45ac1fe0694\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"89e0d8bca8e17f0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"8cb41f5a162455c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"42d8a4a71b49b680\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"050645840f367bec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"b793e9396b58fd4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"db0752b8219a8880\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"2d921db92d4eab21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"b74abf9fb9c36523\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"b4dfc5520a2de7bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"b31b2071e54ae9b2\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"e56ed16a34fa5a32\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"db8abc7dddec060e\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"e8e2f570b552b268\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"c62e1c4074c15a9e\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"8fb3bca0b3db960f\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"94457e3050bac7d9\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"67bbe4ec59cd2436\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"2f89242c6e9fe3b4\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"24f543a2879af70c\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"2b4b88cedef8b24c\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"5c84bceafd23d9e1\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"be3b8eddde432325\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"ef524f49b3493631\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"f43bb4ee98e3eaf7\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"5ef4152e17480839\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"4aec2c8a4cda3132\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"216a6e6ca91178fb\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"862712ae3d0957af\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"b3324241e96614ef\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"b9dffcbd11cf3b4e\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"4a160d7bbb59139a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"bc7ceb7ff2468b35\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"097eb3006a792ae6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"31f1177c7faceb78\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"6896c260bdf3931d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"03aa896898b9c6e3\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"7a96225608f221f5\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"bfeaf9de42c6dc17\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"d0aca71d7603269c\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"56564e9062d05a20\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"c3d37c75089478a2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"7f514690db043236\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"8285d05873222927\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"38a10b411cbedcce\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"87031bd879dd1290\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"287750984ff3a9f2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"c68510bc4ce7cf98\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"f4215c0d9fa327d2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"81325f366d201502\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"156eef47c8a3a3da\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"f3f26c7359611656\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"828cf7c2ec629d29\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"3a337ad5aabb1211\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"ade77b36e536d37a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"8c2e9bea2aca4ee4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"2d0a348c40abf9e7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"533b765dd3fba025\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"a1821d0b54dc03c6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"40c9cee992040b8a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"4e999c54daeff0dc\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"ac74d1503850a625\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"4a107fa5d2e09f7f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"a7ed1fb06e97d26a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"f8d395eab0133d7e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"558daf7d0044e251\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"2680403af373e66f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"1c00f79b5fe9378f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"5a0e024933069462\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"de5fff0ab7cfabec\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"ad3c775b3adbdd1d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"b422621b694c3d44\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"9107b2d5967dbc4d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"b7a1389bd7eac183\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"a544853a966e9758\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"fab7c48b553a082b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"ae9718f8f430a8c4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"8eae89d614da4907\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"e7d2ab1b39845f83\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"f60946518be4086c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"9e760a63852f333d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"7312451369f4d847\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"174c40e29d3d62ca\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"509a5d391f714b6d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bc1e69308888f206\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"91d091b843edb888\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"368ec1ceca431dfa\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"b4b323c2ea45f6fb\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"4117a90cbb2a96bb\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"20c016e31dc8a6d6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"37d4166f86d2b0be\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"1d502f60ba961a04\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"656d421827e7af9e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"24b4db1179ea4777\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"fdc4de3d706763ef\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"5494d020f43e1cde\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"587e1b1b6124e039\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"bc5ec2458858c833\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"f167ab84fca7257b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"9efabdedd5435cd2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"c3bc581c0baa1226\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"127b35b7b77f09ec\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"2e963f047158e288\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"757c159c8129df71\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"2376449b6b051995\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"9ae1b2506419a84b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"3f0ff6c4022d8acc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"a10ed79ca523c5cd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"37e22b2229256703\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"ce17d0d5dde64df3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"b2377b15fd37736d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"d78396fbe06c6da5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"e9fcedd54a5102d1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"bfc19cdb281f6a26\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"348e78085d810d3c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/drawnWalk.js\":\"419f1c88b9dc33e4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"d3ed6fc48851413f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"e470e8d635ff3f51\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"ee8f488d035c6d35\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"469482795e896af9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"80f1ce96faf630cd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"7722801bbc83e89c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"3837605aa471aefc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"e65e83aaffbeba52\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"c5487d1ca21d5bc9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"8de0901136f1a965\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"d981f4899a1f2b91\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"daa4b177a3a3d001\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"a3331ea26d75213c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"26dfd11b76bcab5a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"eaa34cada9594649\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"de003a317f3de30e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"0f2c6f28b2aa9466\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"ed361ae9c6c6535a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"ef872a972cf2b261\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"be3d68944613f56f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"fbdca8a6b9b8683b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"7488f5c61b027dc1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"0459112285791e26\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"c3d207f872e6eba5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"56abb76b8abfce2a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"7464b9252b4eec60\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"5331aba10dbcbfb1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"eb82f5fb961f0718\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"ffcaab5246d71b7a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"7b92b4ea496c1442\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"0cc4b8c95832083e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"f422c754b4bac95b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"1abeb0421c755f87\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"43a97cbb163a6c51\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"0eb007e403c5eb8e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"71623ad4e8e95c5d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"cf9880eac6d62d1d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"ccc037f8e393e3a3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"818d428bef44c7f9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"3751063120fa2973\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"7aa8b0946f180dd9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"e57a4896a071c329\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"3dbeaa386115c2e2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"08689d62ec8853a3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"803f3f5e66ab9e62\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"5a62d97561b3a18c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"51b86044e2c37cad\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"53fec81d3259339d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"c724fa4c666561a3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"2df9426d846a7ee2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"a0b05355026553bf\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"a06c53bdee168464\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"a49dc0781d612df0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"e7b6b9b1a3e90cdc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"70aff2da9f4095e1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"c494bfd723c935eb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"5cad064e10695b9c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"8382a54e21e9005e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"d0bf2b830552d5ce\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"eb6f2c5bcd390342\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"4942d9f1054e98e1\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"2ee56cbf003d4d99\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"f27f35bdb281b20a\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"37e495c8137723af\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"a34b909c8ef84477\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"04b0738dfb3b27cc\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"3230a77a11aee4b5\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"3e6fb836d5268f6b\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"413dfe46db0cc2ed\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"299176bc8ec72512\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"ad3432e4cf14d1ea\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
