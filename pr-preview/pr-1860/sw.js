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
		buildId: "65865af69cbc-5bc9bad2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"81530869245d3b41\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"81530869245d3b41\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-DpwOBDSC.js\":\"cc11a81265208657\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"8032542938bdb892\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-aXDj2y0Y.js\":\"9194874513963478\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-DNR3sqJ0.js\":\"d053bf6be42a8146\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-BC5QYvGa.js\":\"3fc2b5e993bda759\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-CQhr0Rae.js\":\"135ce8c0a7006dc8\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-BUjT6ddh.js\":\"ac37901d90126229\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-BlJvWE-5.js\":\"1154f6f577582a6a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-B_3LtoqO.js\":\"73c2224ef78536ce\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-D0PaPY-h.js\":\"5e1ef3bbcfbb23d6\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-Cc-S8pzF.js\":\"8941d37928957c39\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-B2Dd2iI9.js\":\"e71cf2b4f4a8a8af\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BXhMG0u9.js\":\"ff0816aa9453e514\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BtMZ_wns.js\":\"a295ca58a6b78c09\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-C-y7P7zH.js\":\"02aa23207520ebab\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CMo7-nIt.js\":\"68e40bc9a50fb00b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DS6Lytt3.js\":\"e4df2c8d7dcb67e8\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DffBTfiC.js\":\"f55a074b99626502\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-S9awKipF.js\":\"c03f1ec8e5c02bd4\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-j4fgu0SN.js\":\"985fcdff43c61b36\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-EOyob6C0.js\":\"618c0df4da874d4a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-DjjM2Ex8.js\":\"c3ba3ccd85d52582\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-DBFp1szy.js\":\"e1cf949b950b20cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-DIa3Srcn.js\":\"6837d5b0cb6b1d09\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-DNgXnfBe.js\":\"124db51235daba98\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"cca7e7fac373bf59\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"05bbd9ed18680ee4\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"4a73aab451d0512c\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"def9a2305655a268\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"e23046d42feca8b8\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"6b62c56746359454\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"1c0e398a6938e671\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"7a363285888a8d50\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"e4718e19a256ae66\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"974bdc554df88341\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"d5ec6dc621259ca1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"642417174241c154\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"b91a2034ca4db066\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"065a61be946af5df\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"62834818cbbc1439\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"8cccc882b027e726\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"90f7e118714988aa\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"50040374f73c1bca\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"3101a91dfedbc09f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"29267230b0a69b23\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"76197b2c47383844\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"4632da85859b3c9d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"59cb5a3ef568d7e8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6aaa99b3e0a4ed7a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"9368eecd7f14c823\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"9ce7367bc397cad0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"1f8f4d36acd45719\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"b8af174133c5adf4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"7569445d4265ec0e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"f2642f29b706d2a8\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"f7ea23d002e00f78\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"63fce1db5c507e2e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"0d8ac7cd4f3fe31d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"5065f2676fa933e3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"0ad36ce4156eed65\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"941b15915419ed7b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"e010aeb7bcb5c54e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"b8fb027929513367\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"00cefdc5c2455373\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"c98e02fcc2fafa99\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"2f56188d5611baab\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"8051610d0281f4c6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"abdd643d43f97f1d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"88370c0f4d03e99d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"c5c658103a48e267\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"d54cf69f94c5d7b3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"eae5d4d90b9e66fa\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"c44a36e26f65a82f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/CompactReferenceLink.js\":\"f4c65a4a953eee30\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"541b997766b3d90e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"f37bb788f94e0649\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"2889d0e066996266\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"0c3ec61251a4a431\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"4e04b45b5bfbc075\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"6d8df1ff8471e6b0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"ce1cdc0959308e5a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"5b4bc0ba3e2d4498\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockReadText.js\":\"7cc57590f05cd6e0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"7593cd34630ba35b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"0f3a8cbe51f7c677\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"e1ffaed3bfadbdd4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"efcc588bd6a5cfb0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"153393f744810bb4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"66fd6170012c1c51\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"4f66c32fab832959\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"b18d0fb59094eccb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"aed532c81ecaf7e5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"cd93972185a5564a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"c55367066921b376\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"47e704a647117eb6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"cdfb30c5aebfc742\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"a1560356ceb17b21\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"221b4bf43a22aa8e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"b740b325c63775ed\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"7cc6666abb55ffb5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"a45ea9e8671c7d02\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"738e0c9ad28accd0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"86c2e5b868774a54\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"d2a0e18e43d46ddf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"ec059ddcd7b231ad\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"54f255187180fec9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"976745a239cf4db0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"a061e0aa87d513b9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"4ac2e6a29ad7e57b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"dcfae622406beb5d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"db76c2e5550adb58\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"1c00236bb3b7fcc1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"41ed1685e7a14371\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"70b737382f11125f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"2dea98fa0b12c8bb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"0ad914c7524d9c47\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"d7e35b50bae92444\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"f37abcfe7c02ba25\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"6571a3f50889523d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"1a2f545624146851\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"5e84cc5706138b38\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"4eba289b16f4811c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"ca6ddb189232e0f4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"0b289bf779d3849a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"220acda44cf1b859\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"d840c25b24b44f3d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"7d5d2b3312cde5d1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"bf0132baf89c9171\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"598310b3aa790e50\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"b5c54e73032cad84\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"9fa03428a1eaaa30\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"fb86ad87a39d76ba\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"fec978c230a0c4d3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"c2e6a64946df439c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"12914b52e72dd780\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"71e88f98987d0286\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"d632d0b6243dca41\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8af236190be7cd6e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"c2c896bb3cb02c1a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"82021b89fbad87ff\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"222e1161b7501b57\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"4040eed7686c6ab0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"b8cc03654952e748\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"fffc20183f38d69d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"c6e7fb5d261b6357\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"eef4838c6f507fca\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"292b63de6bff5a42\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"c5bdfb0be35c2028\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"89cf23c145d3a46a\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"3c69f5ac2750f138\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"99c628a53d13851d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"101e21986eeeebed\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"a86cfd371d88d83c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"d23cf926f39091b6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"3803fbf1c1860efe\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"60ac464828a0652b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"c76fb37f63678fab\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"892ac841051e5dea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"fd8abc376658f659\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"0e8383f16e0cd84f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"2e2bc08b30dc4eaf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"bf381155222bc607\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"5473a566e3d7c367\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"aacd59f080b1d7bf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"0d0a4426bada2d6d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"322818b39489fdc4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"fd7e615fcba621ae\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"2e2bc08b30dc4eaf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"2e2bc08b30dc4eaf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"99609b7289c3443a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"7367dc7c1e8f05fc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"98a1d2fda6957d30\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"2a320e42042e6722\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"d685c0adb390239d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"57bb89ca24db0dc9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"e5983916713fc320\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"3d093ae5e937d5b8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"d632d589b0413cbe\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"911b0c14cde259ea\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"8e4c9556890ef745\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"bec60df402e6ce18\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"b83cf883fe661fe4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/childrenView.js\":\"b490e2f5f529ceb6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"e1ab5057397a4e32\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"8f456c2d558af8b3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"a11c489a494f7ac9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"35704ddc4fe8932d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"d7dd5229f12a8bd2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"9ef86c8f3c196c90\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"b92195cc3c779ff1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"11b331e1e6b95a8c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"3287bf30f0d252db\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"52453bbab0d57841\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"fa7c0e107e0da897\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"a39eeabc127b3432\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"4ec4cf391447ab99\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"4652e1f4c460e62e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"0ec99032e361f70c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"be1e65e61b0d3b19\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"feab42e2a474c6ac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"a1f21c989d3e43e7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"f8ea22ac3fd6af2e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"1e82b812366a36e5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"8e0ad22995b637e5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"f6cbc67f3e2304ac\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"df4f7afb63ee6258\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"0d4ecb10781a3784\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"afb74cb8e983cf5c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"595ff631e5a63e44\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"7a82ba5a23526526\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"f35960840d92729b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"e57932dcf906609a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"e5504702255f02de\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"28266a06da5a6f91\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"81be7961c645d314\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3f437586f09e0cdc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"cd040c526643fce8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"bf9a78ae734e87ab\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"8caf008458c7f568\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"3b505fe9eccd5874\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"268638d5284784a0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"8659b026947bbf7b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"7a99861428f234e2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"f48958892dd42136\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"9a6712386df518c5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"c887d44fd09b440c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"be690a9bd8359410\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4b044c02ee3a1096\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"97e601a042fb9632\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"f120b93241998963\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"63e21aba60532a39\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"c4b97d8c15afc8ca\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"b50fa14ae0072472\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"4693ef79a69e01f7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"c9e9e87b4e77d80b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"a12d8d5b50a50946\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"7b2c12e110132a2a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"137e03991163df23\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"b0f11fbd3ed998a7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"004ecf2a3cbbe4ca\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"57a094f77e2f7698\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"8c6c21b307dd8f30\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"20c84bc419ec6d7b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"cb539e18e717126e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"b3f28ddb2306d8cb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"e45945df19270a19\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"47fa84c72fd34a58\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"b6a0239bf2c0e9c0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"17fb7abc4c227425\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"5a449b9037f861dc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"62c6621f97e0b8fb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"c5fa2e5cde1d495a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"c10490c28d78ae50\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"bf7168407edb8731\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"6ef03de490101430\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"e0a1e49adf43a99e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"defa7b4635f64741\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"ac20abf45d3c8403\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"22838edaea1b5963\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"2b74cecc9e304965\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"980d5e617fd1a93e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"35318785fb511b5d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"453988dce8f43612\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"4beff709d6258d55\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"1dc8ee02cefd4388\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"79a8f188ccfcc596\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"ee9e69ef8e98a5a6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"bdcc458e1c0e362f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"65c1597e9e15a986\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"da80aa29e0366ee8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"79cd226a56a77a58\",\"/knowledge-medium/pr-preview/pr-1860/src/data/refTargetComparableProperty.js\":\"0b4f640eed0748e8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"465a825706009a38\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"de633b07ea2ec3ce\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"a9f62032b7698a3c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"80e6b9a6ba69d270\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"6eeb9cc786748a40\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"5ec121b93464bf68\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"3b3ea82a3cf8fe00\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"77cbd1fdef3aad21\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"af3e802c494e3578\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"712f463ee20529f1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralInsert.js\":\"30af73735362fd1a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"832d715ed8335b02\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"fd7287a1c7e9d3db\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"9f4684013b85345e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"7a714c01c8236d5e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"7110b993e3033b16\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"2e981761de01ae2d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"b3b13a12ecc66678\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"ea1ad422941b4f13\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"3f7f296675d0e732\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"3933e621282faeb0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"55f6bfcef6110b1a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"5c5d458fcfcf8ce5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"60f79f62ea76e12b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"8fb3234852580e62\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"789475243432f5e9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"f42b5feb224abe44\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"00ea27f98699da6e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"bdcd8ceb3488dcb4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"10ebc5da0b180875\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"30b581e2945ca2d3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"d5b9659a995baf24\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"cbe1d5372b5a6631\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"4602e7c7dc63c4ed\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"38e63ec772bc8fc8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"b57bc40f8ab8ef5d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"0577cb448facaadd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"d79a0561eaad8cba\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"ff2acf97641ba8bc\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"862d3803b3f630b8\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"c1a6c788c42e533f\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"22ef17959026d21c\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"644c6b77d7915a48\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"bc0c8888dba1dccb\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"9bcdc2a831aa40fb\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"f14ea5105bf9b0d4\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"e62b75b928a2c814\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"54b1965b9a5c1d9e\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"bd4629b758d2f47b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"374ff50deb2e0ea6\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"a86c9ed13f4ac814\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"6fc91f85a80ea108\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"a94f8bb22865adfd\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"1b3c22b1f924defd\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"3b2b7fafa0828a02\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"9646b6f09e26894f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"3e4ce149c8c7e1df\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"14ed781537937434\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"913e90c19f42b09e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"6fc6dffd341bbf88\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"8113ddf49edd4fc9\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"0eb20669602f308f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"281851229688110e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"6c94bfb25938f55c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"2db6832d026dd981\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"0a7c08c8af21e13a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"13abc0abed90b95f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"e7ded9fa495f5297\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"3b417e8a760a3a73\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"3f0eff0defffdd2e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"8a78335c53f3ba29\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"994047f4dcdd0e2d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"8cd90aeb9ff76d8e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"e8ddf834b556886e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"e1607d8358f681ac\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"c3aaf8dc33e569ae\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"480c64142f63a865\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"c37849d65fe712f3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"93baa9291a1c5eac\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"500018e903b9caab\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"d9bc19d6add5425a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"13410428cace9e37\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"db7d5219ac37d5a5\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"2d5c5f50d8edb945\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"039124c19127dca1\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"56dac810d71ed405\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"89f6948dff8283a0\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"43af996db645a185\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"e72e33c87c1b4e0d\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"881d0f86c376b2c6\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"c98280fae21898cf\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"5b295f32a2cc22ba\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"94474b69c4fad359\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"4b1718537dff0a64\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"bc8f94530ace1222\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"3a9decd4237b347f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"97a415a10db9b333\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"6f0a99f62986f189\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"0af7a4dbd680491a\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"c518ba0d7c0da276\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"0dc411168559b815\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"12133aa18dbc8937\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"6d13ea7cff4c090c\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useFacetValue.js\":\"bfbb1950b5760643\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"6e10561c10803ffb\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"ca5e41d2bd6bf422\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"a16a015b58252ca3\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"f76ee77f72719301\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"a39b3ecff4df2ffd\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"68e98ff5368b0abe\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"64b39100b0f020c3\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"38af24e49529d6a8\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"c092c825f8b9eb45\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"76ac8dbb440eb64b\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"2e4bf8f8abe411f3\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"737520eed8e983e0\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"a5f35c68b6b5c31f\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"8e99b31f5114f43a\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"2df1bc9704afbfa7\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"a33f357c6f0ea68f\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"d6d4f1fc5218001b\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"23db26aa9863e1a3\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"683fd570aba9dbb7\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"9012405b09dbf52b\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"45488d8c1d1c7358\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"29091974a0edaf08\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"7606fc1c7799b004\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"55f072caac0fa103\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"16951c88f855d106\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"716ec7b2536604b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"42cee0986b3f34c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"f973d57784a534fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0f0059d2688302c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"ed672b01ff794239\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9dd2679241ca3f44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"cafb0e384bd93367\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"55e2401b090faea3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"ccdeac4cfb7c5c9f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ebd20f321882e420\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7e4f93b84fa2b1fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"3ef761ca2bc23962\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"37edcd18ea47b36d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"d80d785a02ff705a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"e59b46209d08f510\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5df3327933922632\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"3e0f2682bec11282\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"effb43ae49aad8a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"2508353764985b38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"97c5d42fe02f9085\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c585eb8cee77fdd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"77594fdfdc94f319\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"5c18c778e1838c84\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"55d53d60f14dc03f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"090ad0a46c45cc5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"56da1c276c32aa98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"ed12565d251fa5ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"77f5fbc945268770\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"4c97def730088c45\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"67108d00ee5a8081\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"fb5b8bb61607467e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"bb8d2ba3915ee872\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"31428cad51d3afa4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"252f06cda0b942aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"ed398f84bbccbabe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7db16dcb87c85eaa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"625e33f5de651a1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"b83bd217d2ef324f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"5d75d49b60630c8e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"89a50a062384c31e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"c8b0dcc867e83f6e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"99ce1cbffe1f4a47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"568b673185c6c5f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"22e92b58211040c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"890815a98dd963e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"9b4a18085252c259\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"b48f0fd0ad8bc5f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"90c2021a4202f26e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"4a21475cd2b0a2f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"d9b9831c159d4ab1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"14f7af31952576fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"a13fae4b0c7a2fde\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"661ac5180503306a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"af3cf0db9793afb6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"514cea2c9a42dc0a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"cda26a9a1ab211bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"ddfc99cba21c5a6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"ec6795dc8a56b6fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"28b729cf03d5fee0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"0e91261779643a1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"f3acfe1fd716ce81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"21510bd33bf86545\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"352b8e511d6d7ad0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"212239097fe371fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"47402224da3b4742\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"bd5264a69164d7cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"7290bcb605480b05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"ac55791a20c76261\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"2199de82c0055a8b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"ef40f91c8abe7017\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"6b4adae89f4e551c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"99d985b332fae200\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"9638d92eb3de704d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginAnchorLinks.js\":\"39d95c30a33deee6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"ab0ab1f82e7a9619\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"9e7042bfe83b7304\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"a6d6a50e5acbbc80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"ba54c5280ed5dd4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"72b249834033da20\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"93bcf37f3cd46a9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"189d7a3a57dde099\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"fa97bf0f386e1476\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"dff29855dc2b51df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"60fa218a668ed1fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"77ee9d840caf4fe9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"7df6a82d9c794c4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"a470d23e11a9e1c7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"793065e0044938dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"90f9c9f38e071bb0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"d466b0dd6ee1c99e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"9836f96d59b638dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"5109b71fd0bdc39a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"413ff3ed78f3b8b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"a6dd1406e701eed8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"0066085f11aca124\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"05ee6b28e6022f47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"1c00641915adc3d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"6bc40d23650f3f98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"fa62c39dbba31994\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"d902296cb078b995\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"924ca2c1e71bb8f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"9fa1f151d1eca19f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"eccdc782b2574b0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"a69201144f79bf74\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e96bb6f06bdb9bbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"aaeb3b5f3ca86920\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8183f817b2d74fd6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"e780e25fdf03c6e5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"11bf7c2a5aa114af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"e20fb991acc24292\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"fe5ab81ab6bd3dd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"feb10f1595365915\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"601c345be6bd11b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"41092b7365654d24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/browserMedia.js\":\"277c316f512acb9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"4c1d7c3120d0b847\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"acf025ff04ce6b03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"5203b78ec35b46ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"ffc59489bbef4a91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"55094a6bb097ad55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"d3df0f6960cd8762\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"ddfb7c7caf5bb9ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"9722fc963af903b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"4c4b99e9c1582c0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"756aed9662655295\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"5d557da88a4738c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"bd1ab9301a6ca067\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"bebce5dc879dc0dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"bb2db89c056c6866\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"25c2dd148876779b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"aaf3f5056470d0cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"f69d7f2380beb223\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"e3cf642400b076df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"8a0d0289bc60a41b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"fc48adedbd28de0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"0d1b2f45fef1458b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"0021f6f04f5b92d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"1fb9fb0fe7d9ca2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"7a3b0b6991081df5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9e77ef63561b40e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"066c9418ce1e782b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"4eb4c4b7c6741b58\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"a180c6f34e45171b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"975d89aa330cbaba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"19f5361dfb6cbf43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3a4419d69a3c261f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"3eeae30c70c6c151\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"a69e9bc47ab73bd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c757da358ca377c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"2954c3d822f2b2b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"50a9d4b61166ca5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"6d1e3debd2d7487a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"3758be862625bd5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"50148d003bd2b6ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9dc452447078329b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"cf4e8241efc85980\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"e3f47c8c71554995\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3116182b56bfc5e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"1eded0778601e1a7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"09ee21443f0fd2e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"59911f42c87c31ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"ce7a6c8fe39a82fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"66a855b7af23a609\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"f7b325d9efaff454\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"366b83d5c36c51a7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"5ae3c76312ad0250\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"7a0f3efb626b454a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"29ca20491e43e4b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c4769d1cfd7c0179\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"ba359578a49197cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"011cc1b653878b3e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"61b00c3f162079da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"593cd2c888a42e00\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"6bf666c2ef2e9e86\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"3fc3bb8084672a4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"940de07a60a0d14a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"21b499f8af659cff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"2dce9aef61bbf76e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"b808f85b40adb1b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"700e394ec0c93cf0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"ef0e3e672c7dd731\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"8bb9f9a857617895\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"38cf2ca6f372f8bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"eb58202234ae68d2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"6a1fbcbddc928f56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"49f18d2266dc00bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"f117a754b6ba95c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"526bb0676d675dd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"14a5a1cef2e71971\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"cddb8a61926b9c0b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9fbc57e5ab5440b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"93d830ce42e848e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e1fe6cc82709747c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"32cc1dae93aabe3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"86cfa7be9664ed98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"027fb8bbeb88f3d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a64c0ed1de9a2dea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"af5264ab9b1a1493\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"dc3744d91ea6b9e6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"96a505ff3cb414d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"b61d56c7d80cdc6a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"d93843a995c74f7a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"538fc0314abaaf6e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"3985e21f13ec37aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"155f3e07ab582fe0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"fd5f6e8c45a88d35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/subtree.js\":\"b8768563238b78a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"c837250bcecad2c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"21475b2cf07ddc2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"71e977b941b3449b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"7ffc0a08f138186a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"1d86502a5f44f8a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"b72fea674797ce64\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"9e2d71866c97777d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"1729a091ebd3cfa8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"3439b77ed6ed58eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"73e871145f2c9e78\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"4f4e33a816f64470\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"7e62b5fee2935106\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"d6059b916390a1b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"3345fc1b6f49b126\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"8cc4400e73c0897f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"fce7985e01fc8362\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"17f38a8d19484882\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"00f153a4a1c868f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"d0e0f3a977a2ba90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f1645f7b632a36c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"23e9a9efdba9a782\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"91e5491d0827ae34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0ff2450f7e8809d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e2237b23d08e8fc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"4386090ae8d336ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"b393d059f9d823a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4f8430fedc25476a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"bd08029b236756d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"7f796ce8706cd7e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DayPropertyControl.js\":\"74623f87c2916ffc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DayValueReferenceControl.js\":\"ecd9f049d8c0142a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"8c5f48b628cc2d28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"072d9be99350a0c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5ecd75d8a57bf9f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"6c5d17f1a5febdb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"be6bed36038f0d5b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"61fb6f20bbdf76cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"fe33a2904abd11c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"ca3ac51b0ad3f3f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"95c16d15408f5635\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"69f19df3a1bfacc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8d2a7ac34b5c63aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"de89c963637e913b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dayProperty.js\":\"6ad220acb6915c30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"090c30098ac10968\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"b952d391a174c977\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"a125970c9337b5db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"f38ed8ca00afc248\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"cb4c364bc38398c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"f5f9d90550c6b057\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"5bfe70fbf691d7cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"ffb1a216217ef620\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"9260be5f87e45a0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"d839da94286a84bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"70b6f5248ff30d06\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"ce35cf360e2d8c8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cee9f442dd94d729\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"476493cf4eceae55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"1c10a17b9b105fbf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"4f92456002f14d8f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"e72fe32a964825eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"a1580fec92d42bf8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"6d73ca50ac7ca14a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"09a8b6181efcacc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"99e73711dd1a3982\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"569ea6a4de94a405\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"5004adb1053b8a0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"a613c147ba2d4b3d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"27bb50ea99e51d05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"cc1dc14521742f05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"aa4c50d28487387a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"85f4329cdec810b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c7e9d87ffacf377b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"4bf634331f7e6896\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"7d2b4c8892bb662b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"df52f6ab7c506d1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"0c81e90c45d564e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"43fa2fa4c7a6fa9d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"084934efc41cf24b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"38c3595229c8b260\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"f75892eec96ac37e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"0875266938bb8910\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"505ffbb28cedefb2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"c1e332b929c6667c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"04fe117107f1a2d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"22c77c035677a78c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"a91624a2c9045ca0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"0d76ca28806780de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"8feee28e69ec6fad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"7b863511f5533fec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"8f313ddcab30af55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"50fcdb467d008f60\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bf6bce99d70337a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a3426541e70b5cb3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"778520fd1fcbb6d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"cbbeeb297b5d8ea6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"62ef1d8235fddfae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"458a9cd883b5f3e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"a957bc3dd37b34a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"51510d5ddef23258\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"681f0e16bf7773fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"4bc46e948f00a0dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"49cd87390d85996a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"2cff9807363e808c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"5b6c5f73a5594379\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"b3e4e1bebe0bff8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"372f7270dd95a215\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"75bff619f8f339d1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"2d8870de2c1b2b38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"63659b954241b9e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"874c0fd661371204\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"6179176dd0daaa40\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"ac8c1e3cc1b12f32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"62ff0ddedd2a630f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"e323ce4258cb56df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"69cd1dc937027b79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"25e974a69821026d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"b97560cca10e592b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"ae7d7a19d2c9d127\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"9c9afd5d046591a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"f75411ad8fc34855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"b38122950c639bab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"80f2c4bcb1e11321\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"350fe4b57f4e47b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"c962644a30715035\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"60ba8668fb075962\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"45af0ffd46f0a57d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"523a598925c3301b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"35cdb25fab75fc42\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"d228385cd6bc7e66\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"55ac9a905675ffe3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f25081d4c0bc59eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"aa70952c2f6a5098\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1e215ac5c4529af9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"0bd58d5468ba220c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"d98073a938946903\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"f7288250b0340099\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"158e6f6fe7d8f3b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"20ddc68f9f676d08\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"be8f59d933bb39db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"11c229afd7185cbd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"87227cf09aa6d163\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1998687797155904\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"068733bdb4a00836\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"b07a4ae6fdf110a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"dc32100e3d9857e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"76be8f4eb8d9f6c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"5bcdd7bd23679734\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"4e1c00a9c9e35230\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"b0b8ceafc142a6d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"80884e680d345e98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"697739f2881b0c2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"eaf2003221598694\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"ed3e95bea352be9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"05d192bdfc9c9058\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"a0192cb9ae5751b0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"bd3b70dd900161a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"3acdf2a4f07d89be\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"0e17ae0253124d4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"a3d89bfbdfe46dd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"54e985f0383d046b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"fe6754531efc74c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"d94faaf6b1991256\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6792c63985e3291e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b421e74834132efe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"34834cfef81b3a46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"e0c057a192690ca3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"9c852e0bb97df8a1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"8bcd09ac842a3d16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"ed68a2cc572e8f5f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"3077321ddf158521\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"2dca3bbf328de1c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c56fdb104f89d20a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"a49f37c5c35ed0d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"21e4c069f86cdbb6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"d9e9911a35fedc48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"f8b48b5a1e6808c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"c9e699e31b1011d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"ac914fbad5aa0975\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"ee4889fbb64cf8db\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"dc94aedd099b3f30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"b94833175a4d3d05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"cf0989814e4759ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"6fcbfc738381930a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"bd8bbdde4eddc1ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6ba5d281cd9e8880\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f68d0c4637ad7ecb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"35f3c3f37502cc92\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"4e7aed0775ff05c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b912235df1b6d560\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"03e1be08e734678c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c84bc97ccefc260f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4a481db8ee6b7966\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"9e33a63196b4309c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"67f4abe9736a92b0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8e0bd75d738b5ae1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"057febb95faacb2c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"f42fad154a7f71f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"7fa1142c36045835\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"aa923843ff88cb6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"62b347bbf3f3e471\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"a048bc0520fa4f97\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"9a79f5fc1af60839\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"71efe18c1b9e5cfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"ade01283de99f2ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"eba4b592623d9e3e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"b1fd400c4f931a6e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"688225a6d9466822\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"b31dc6144c0cdae3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"0e42820bebd4388c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d7901e0547f42a21\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"2813d66edb872ad5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"72014020fd0284f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"c27cb097481a9d35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"a5e7cc9b1309c386\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"493defbb902172b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"08c80f3c33fdefb4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"20d779d6e8b29f1e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"6d93bbaaf9a2253a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"137bf95078a80a75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"b20af6a5afd60ab6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"c951dd88f470bf16\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"22a290b526b7d751\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"cf59035c5f54ea58\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ad2dfd582d7c9190\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"8a18b51940e2e310\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"ab83db3f38ca1c4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"3c15ded4f1c8a580\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"bf3521940911b9d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"b26ff929364b0d4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"4fcf83b25962c1bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"9b4c74efc9f1f013\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"d3c58bcf2e18da9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"11bb2e5de6790b91\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"2c723d68b77472e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"3e52bd767952e0b0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"b153ca452e4d3fbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"181cba7ae33c5623\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"c95aceddde7302f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"8a3e7698cc624bcc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"84689fc42aee0d89\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"aac4625c42e4dec4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"918799d9b61a8887\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"509f4b885c9dc521\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"4a322a349a6517ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"9c7c1a440b857434\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"987b9cf97b86d9e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"b4abbc631ccbaeb9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"4b6c55bf9516eeb0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"5be434a618cbe2c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"76ac2930f69e3cf5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"19e84ac915024c5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"fde2dd084bf1db29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"b2175cee0869709f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"ac282ae1ef2b8053\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"0c820dd889d7e974\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"079df76951e896aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"05a0d2193f5e5faa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3e891038c6484667\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"a9b515cbf5c1912c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"fab65b4ce7119590\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"7005d5c822a46423\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d0efc898c2aae4e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"66c9afd26be4b6b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"e4cf96a603f377f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"35392ccd5e9c96a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b205ca886e93e2e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"c928489c383396f1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"69b8ebced364961a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2f92cb05fb84dccb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"2bac5f76f5b1cd3c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"23e2789f24a88893\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"245b6775c0a7ce59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"4ebab3ec84eba140\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"2891daaaa16e0d25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"29173b937603768f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"36df81727d200a5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"7f8ef900bb0877cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"b6ad44fc680ecdcb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ec6906b91461057b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"4bf96182669e1687\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"f6d9c5225bdea370\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"42e8605edac0c418\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"7de5d6719f848d85\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"b56db2ac00842f35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"8fd58b56855286ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"ca8b6410b91d653d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"31c5492688f24519\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"571c82a779d7907c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"acd5755de7d1372e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"d9051fb8137c8d7c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"ef1461ceaec42140\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"146269809a4286b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"eabcd03fda0a87e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"8388cdcc3277e005\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"e8aa10ccad81019d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"0fb054ef0b2d28ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"950f3587c9161c1c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"a1f9d92f7564bc4b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"cf5de2422e530fa8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"302a201de433e11d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"7d2170a58bb11e19\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"2d8ce861f64a338b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"114269c56e489e44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a3cf7c402a48591c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"43ad6687fc4d414a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"08f3588c26479d8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"4c0ef135a0ed4977\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"c3c82b6de0b45e32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0b63925092448a27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"a3425958b5dc5262\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"5616dc662f90c892\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ae3220bdfbf0bbd8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"22d8429f4f1814a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"815fb0ac7a6fc1c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"f678a62f71a6c20f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"cff8d34fc0b104f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ca660044de02dcc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"3ba46ac3b2887cfa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"4b840e9ca4485666\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"a8cc631fe5acb5fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"2697c24a88e73ff1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"04388c74f70ed34b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"19904b06bf17e5c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"d52e0fc590ce96b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2afe87e76920ac30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"e63dae4beaf71f2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"24691c763d8cb94c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8c244daa59f0ec2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"52a66f9d4db79f6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"89d545809df219df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"23311f05d0f762b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"f0933030df9c48b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"3a07987153b3c10b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"60dbc6a557fd16b0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"abe74a4ff07f85cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"a2c6b5b5b4602aca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"663459d1dc63b44c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"ff5adc1f1d65bb87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"d30f20c829573086\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"8eebed29cac08df4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"b4c31ece2776440f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"21b4e58367516fbb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"9e2586fef0e745c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"94272dd9064bfc4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"878b989d3e01805d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"3721af20410e427b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"e7934fdffe5b952f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"53b2646f83149b80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"1f63ab487b445bbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"952d3e30ec64a5bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"4a487ffdbc0fa62a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"3d4ae76f7b15ecfa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"bee75d03e1873bc1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9f6fd9b233f44296\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"8295a3bf7bfc63fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"b8d66fc96024017e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"884a7e2a33bd430c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"7cb0b89fba0562de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"5fe4ea0f6eed076e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0cb8f5be5c94134f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"7a7896126972bb51\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"1c375122a6decab1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"44063b16cd46878b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"7fb6d38693f0ee2a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8e023a9c8beb6a24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"2372321e1c14199b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"9a61337f63757084\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"abf5fe3213a47b35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"1d294491c336483b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"45567b1110aa4d3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"d6de4869f8fe3e55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"dc422b2fc8004241\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"17dcfae54cd5bc7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"f283c0bfccb0dace\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"c814848129cb6f7e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"cb75492d90932862\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/childrenViews.js\":\"c462542b05c5badf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"8cc73150c9ceebec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"90152d1dd520a6ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"395440a0a3d4b0c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"5803be46190378a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"d5457b76d9a37091\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"c0a02e2f77c0ba0f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"32c0c29b78043ae5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/QueryText.js\":\"ce6c17473b4005ea\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"036e3bae234b2742\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"9ece0d6bdd24ce5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"66ea22babe09fd03\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"f25b4e1a0a0c3618\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"016df52cfa114f25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/registrations.js\":\"0667dea2dfc8007a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"25e643859fefdb94\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"f6d5aee677e4bccb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"b13b62468c0aa341\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"558e9568c79bdb15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"12cbc27813ae0665\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"2f31c45d801477a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"ee9037f3f1c8264f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"beb59d0720870741\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"c545845ed1533d38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"9c84866a0e4f7898\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"337c51cc24558e7b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"2585c84f42546831\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"e4b590eacc4ad0c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"39ed164de4c41194\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"4bb5116496865c6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"545fb54527a3ffc6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"18de3b47b75185ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"db46c9cfdbfccf60\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"bd40a92208d0db35\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"71d10d2777f7e0f4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"3061526b658016a3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"ade02ba80f15239c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"068d9ea862654fdd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"4bcd83537d006a5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"98daa7b3b02f3e71\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"984f9986de8cb575\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"92a6136208d847e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"076b43e03c9d1c2f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"82f01d1adebdcbdf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"bf57570dcd111fdd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"0fb9e87aea15501a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"9e1b977cdc738a85\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"51a569d35bc02dd6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"45022d948bacb0ef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"71bd703bb1f9da6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"788eca153ec1c2ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"ccb88355119975b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"d67c8e730a162955\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"34c3a230f835a922\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"24e52f1adcf3e353\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"ccc5c2b396e90a56\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"e2127222c77f8719\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"37edf796f5b27814\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"b5cf706f55af4c4f\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"9fcaa8663a7ea61b\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"07c3b0ffaa493504\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"5b9e8e9aba7e37cf\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"d8a857b72b40e10c\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"ce6fb23d05759f18\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"3f236f9d2462a87f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"f74dc50d41073588\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"7264c3e34d16730b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"91acbb5a05d0dfce\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"a123b663f4a0bfc9\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"d8552e25900f8cdb\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"3cb5e811d9315b63\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"908e873a97b0a98e\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"98ec4dda96f82ba1\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"fb37ad907be0995b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"998fd0d00678ab55\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"32df83fcdce46f90\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"56900975646d119d\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"e082e6e8a4f07322\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"a447b6f7376497af\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"6f5ee9af1b07d68f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"911ace68a1864e56\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"6d401918027e6ab1\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"f740fafb159034f2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"5a72c2cbbeeb728e\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"dd9f5b8a9af37820\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"8e39d80073fd2d86\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"68ef49c28d58652d\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"f596a8a5bb1999ea\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"27d17fcfeacc70d8\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"cce7c2c70d48d2e5\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"39e5245c4610e41b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"42f163b5e611fa8c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"0a4319445f61d3b6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"707a9e8a726c0eb2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"db84b828a5fa6bfd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"b456ae97ed4d5254\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"8fdae6d2d17e63a0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"01c560b04d561335\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"37e92a4276bc59a0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"c2a7c9173efdcbee\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"32d411b16d649793\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"4a7d994ce7a33935\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"e8aecc724476ec44\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"41c984ee75eb808e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"8f9381811abeb68f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"ddc6c2c3f2b02f9a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"3f2773ba9dd5de3f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"a06268dae8b14976\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"d025b871036028db\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"ad20987575aa5075\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"34f280aa5aa7adbd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"b335b6052d3dd5fc\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"365210d36bcf146a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"6976291fb63198d9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"6de3b82bd3d716cd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"350845dda2206522\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"6c2d2acbc4e4ad97\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"7414066888f576a4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"ab0504c086ebf02d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"4bf68ab9eaa36a97\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"37f1f822825ef9d7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"8ef6fa166eb86197\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"9cdff8c9d393d257\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"fae1886d90c70aef\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"18bf803f0f0d2c2e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"2027e6636de31635\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"606594f3e154ce53\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"fd28a87618ebf967\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a63f5c1af7d2b3d9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"77d7e37ef3f289fd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"b4aca4765bcba6e3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"d3c5b2b12e26f5e7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"66e168e939e82362\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"5287faf884624f7d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"b1324c414184d277\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"4e8445a9ff6d1c21\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"3711bb0ed40e5770\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"e6fdc84253855aac\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"05efd2649c522d3c\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"c1916349ef568804\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"36ecc381cd368d0e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"da1cf0ac27a9ca02\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"33602d7934f5a215\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"7e6fe5debe9bdf11\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"5a59c80c49bea834\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"c09763434060072e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"0320a9d7587c3756\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"64e29f29487e1afd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"0b3703fe12a83925\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"3860a2a0b0c3ed1a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"a7cc7d2eb38dc283\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"e3b4034dc2581347\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"a16cb0bf38ef4ea7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"d07597140bf7f7f9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"b39bea79a71e1ffc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"0de229cbbc180db3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"4432926fc3385723\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"8dc069ec2627ddb7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"4c4f469c5f6d06f4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/drawnWalk.js\":\"f44bdc8a988a55fa\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"bb332180a31ce538\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"e75f8471f48b92fc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"2eb4e0a5699c0303\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"ab110608c57ef352\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"2ada63ad8b1af1dd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"856df70ca6814445\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"697a106f346d0330\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"a2fcc02feeccf58b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"f23ac450fce42584\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"b29fe4a6378e82a9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"7bb7e2ec976a1f9a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"6225f0ac1fb4ad40\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"bb99b2c88be92dfe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"5618c151472ec3ce\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"0aa3c96822f07b8e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"d949cf1b878dc0cb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"234e8063d249fc79\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"e59b3637384749da\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"c18bf3e37aa25b8c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"c8bb995c3358d023\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"9090ae7088b24939\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"1b0fdc25a6bc9671\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"8d40178bf8bd7566\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"02d61973d4fbfab8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"6fbd2a4ac92dbee5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"31c9978972b8c3bb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"6d992cf1fcfdf48c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"97ebdf0468448f84\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"e78f0fca9b3fbf7c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"a53741346e205a39\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"dd66e4d48de6effe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"e4b16678e5391d12\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"daffa6f88d7db068\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"5fca747c937c5aa5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"ca563db5cc1ad7f0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"c48c633d3f3fb25e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"5672d0290612087d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"8ffaffbd7704948a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"6d934a04013449e9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"977591bb8d39f609\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"81b5231fc5b86bec\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"43d501668861d41b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"1a7e5bc457b65597\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"12b1ec2741a73503\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"b4bc313a79eb8ff7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"7d8b8acfb521f15f\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"a5e3527510529207\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"d43fafa4aa666d8e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"b02c5bc60dbc53da\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"de462b030c65d8da\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"145ad170eee7ae2a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"73b7adb11fea99b7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"a029b118fa47da18\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"8b8f78293d0e2d5d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"0a447589b272ee5c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"66b8d34e348d50a7\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"4375ff256f9abefe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"501743ad686c1068\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"e3e501a401e01818\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"a4c09626a3a344e3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"475c557362b5ff46\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"53e073139f8afc6e\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"b7d65fc0ca2c2aef\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"c648577f17e15de2\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"c10acb71e6a462a7\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"1b515a565a53d196\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"5c997fe57a3cb89c\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"4482d9dda1bce15b\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"a51e46bf88499fb3\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"b42f39ffdd1f366c\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"ce160ce2e218e326\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
