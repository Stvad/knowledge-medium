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
		buildId: "4e1be10f04b5-e164ddcc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/\":\"1400744290360fa8\",\"/knowledge-medium/pr-preview/pr-1860/index.html\":\"1400744290360fa8\",\"/knowledge-medium/pr-preview/pr-1860/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1860/assets/FacadeVFS-DWHcayor.js\":\"ef2f52c4f1a2c4d9\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSCoopSyncVFS-CBUAc9Wt.js\":\"a01e55e22adb55d0\",\"/knowledge-medium/pr-preview/pr-1860/assets/OPFSWriteAheadVFS-B0F6uJPs.js\":\"48898a8fc4e8e9a3\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-CxZlpvue.js\":\"aa887e20018a95f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/assets/wa-sqlite-async-cEbJZnb-.js\":\"c2be54fda588e645\",\"/knowledge-medium/pr-preview/pr-1860/assets/worker-BPkiy0ND.js\":\"45f16768936db262\",\"/knowledge-medium/pr-preview/pr-1860/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1860/chunks/app-Cak92owk.js\":\"c52a6a1fe33804d8\",\"/knowledge-medium/pr-preview/pr-1860/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1860/index.js\":\"8365311528f99d4c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1860/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1860/assets/AccessHandlePoolVFS-B5ryzn2o.js\":\"e6bc6c784004d6d4\",\"/knowledge-medium/pr-preview/pr-1860/assets/IDBBatchAtomicVFS-DMJqHiJC.js\":\"d0b7788509710535\",\"/knowledge-medium/pr-preview/pr-1860/assets/MemoryVFS-CecHM1xk.js\":\"163b684785c16f63\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cako7G0i.js\":\"58685c754d750adf\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-CliXmlpc.js\":\"c35e8538066bea0f\",\"/knowledge-medium/pr-preview/pr-1860/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1860/chunks/AccessHandlePoolVFS-BXiZJezI.js\":\"a0773420144f9394\",\"/knowledge-medium/pr-preview/pr-1860/chunks/FacadeVFS-B5QGP8cw.js\":\"d79a903f72865159\",\"/knowledge-medium/pr-preview/pr-1860/chunks/IDBBatchAtomicVFS-Bs6uNfSM.js\":\"89b6c10aed3533a9\",\"/knowledge-medium/pr-preview/pr-1860/chunks/MemoryVFS-CoDv8fkZ.js\":\"c1ce28d864d1468c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSCoopSyncVFS-CmORW-Hd.js\":\"5e3aee77114c1cf5\",\"/knowledge-medium/pr-preview/pr-1860/chunks/OPFSWriteAheadVFS-CICWaZ5Z.js\":\"00a0bddbe8fbd976\",\"/knowledge-medium/pr-preview/pr-1860/chunks/Preview-DE2dvCqF.js\":\"37618cc7e37f8a1a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/card-CJq0QJUx.js\":\"73fcd8e8198b3c8c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/dist-CPGyUWZJ.js\":\"ef024b67f957372e\",\"/knowledge-medium/pr-preview/pr-1860/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-async-B6gUeFnZ.js\":\"58020dfcd21ce9cf\",\"/knowledge-medium/pr-preview/pr-1860/chunks/mc-wa-sqlite-iDx1Go--.js\":\"0418413290fc1f44\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react--mVBlUM3.js\":\"b2a80aa943de7548\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-B88toCUC.js\":\"169897c16cd3d88c\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BDAhsD39.js\":\"23f380e94f42a3e4\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BRG1GevX.js\":\"ca31f0295a13ff46\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-BeMHNFPx.js\":\"e50c295f87308b20\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-CqcrzJvD.js\":\"53a0f74d17f76749\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DRKfDCNU.js\":\"0a025c0b5f7a3bb0\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-DyeXyCLv.js\":\"1ded19e47ca1fbcc\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server-legacy.browser.production-BLviY19k.js\":\"ac1905153a8ba588\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.browser.production-BBKUEloq.js\":\"a9cf2891e6c3881b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/react-dom-server.edge.production-DT9WDXXl.js\":\"ee04e89870ab7d64\",\"/knowledge-medium/pr-preview/pr-1860/chunks/server.browser-D5B6Ou-S.js\":\"0e103ef50f7876d6\",\"/knowledge-medium/pr-preview/pr-1860/chunks/textarea-Bd0qO5Ut.js\":\"b5c2979f3864888a\",\"/knowledge-medium/pr-preview/pr-1860/chunks/ui-B7Kz1l_u.js\":\"5fcc11ddfcb8d9a1\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-Dld-EJ3c.js\":\"f1ea31aa1eb6aa9b\",\"/knowledge-medium/pr-preview/pr-1860/chunks/wa-sqlite-async-DWHx9TN8.js\":\"b22847775f715c90\",\"/knowledge-medium/pr-preview/pr-1860/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1860/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1860/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1860/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1860/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1860/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1860/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1860/src/App.js\":\"e2144eea0fdb5731\",\"/knowledge-medium/pr-preview/pr-1860/src/appUpdate.js\":\"49fa2eed5905425e\",\"/knowledge-medium/pr-preview/pr-1860/src/appVersion.js\":\"0d7ae36fee79d6fe\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/initialLayout.js\":\"588a57d6215fdd2f\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/openWorkspaceData.js\":\"86bfa87b92cea625\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/resolveWorkspace.js\":\"52d974d575cf3fc5\",\"/knowledge-medium/pr-preview/pr-1860/src/bootstrap/workspaceBootstrap.js\":\"6bfca72cb38b23cd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockComponent.js\":\"063ee44591c47723\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockCrumbs.js\":\"bf5ed49cf5735665\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockEditor.js\":\"26ee9da5c1176c6e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockLoadingPlaceholder.js\":\"3106e9ecf84e0b23\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockProperties.js\":\"cfe3e0b384c2de51\",\"/knowledge-medium/pr-preview/pr-1860/src/components/BlockSearchPicker.js\":\"d42ec77c9e996bec\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ConfirmBulkDeleteDialog.js\":\"1b43a7db6c398612\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DividerHandle.js\":\"df6eb04a447fd459\",\"/knowledge-medium/pr-preview/pr-1860/src/components/DraftEditor.js\":\"3e85be96bb3470c2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/GutterPill.js\":\"bc662c3b53ac0fd2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Header.js\":\"e461748a35c80826\",\"/knowledge-medium/pr-preview/pr-1860/src/components/LazyBlockComponent.js\":\"e38ae9c1b47b27d1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/Login.js\":\"38629f58383497a1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ZoomableSurface.js\":\"312d287312e4fe38\",\"/knowledge-medium/pr-preview/pr-1860/src/components/editModeKeepalive.js\":\"07b796bccfe318f2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyDisplay/PropertyDisplayScope.js\":\"35b260ed1617150f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1d21d8d11f5148ae\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefPropertyEditor.js\":\"3848fda4f29225f1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/RefTargetTypePicker.js\":\"cb1d0a35cf284d8d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/SelectPropertyEditor.js\":\"2e20448b130b0b71\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/TypesPropertyEditor.js\":\"9c4841ae5e8d20c7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/defaults.js\":\"b2422f38b7341afc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/kernelValuePresets.js\":\"f074e569c4d93647\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/selectablePresets.js\":\"4ae18f70b630843f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyEditors/typesPropertyUi.js\":\"6c2f722087c04a62\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/AddPropertyForm.js\":\"1431c278d0816434\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyPicker.js\":\"8252770023fc4c3a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/PropertyRow.js\":\"825aeba18ad6335d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/Rows.js\":\"94df1aadd9614409\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/actions.js\":\"860ac921ede52ee2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/declarationOnly.js\":\"c2df41a321aca760\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/layout.js\":\"af016b9f98c984f3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/model.js\":\"5e9d0e12670c3628\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapeUi.js\":\"cdf626ec4848fd55\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/shapes.js\":\"ae4a8697e65e243b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/usePropertyEditingActivation.js\":\"52e01b204a26779b\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanel/visibility.js\":\"3bbef48debf1faa7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/propertyPanelSections.js\":\"ea9a1c9bc50fbb74\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockEmbed.js\":\"b671ecbe30c996c1\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockLink.js\":\"fab857971ecd94ad\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/BlockRef.js\":\"150e45745840dff9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/ReferenceLink.js\":\"d7769b878ba30b5d\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuard.js\":\"6f695f9b2e7e95c7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/cycleGuardContext.js\":\"2373c7c9ca5b5ef2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/linkInteraction.js\":\"e6fcf3177cbaf897\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/referenceLayout.js\":\"b8f0c0b92716c931\",\"/knowledge-medium/pr-preview/pr-1860/src/components/references/useBlockRefAncestors.js\":\"5fabd9fe55e7f5f2\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockGutter.js\":\"131e4aa8abcc6453\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockInfoDialog.js\":\"8c98e68cf0e575c9\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BlockTypeBlockRenderer.js\":\"86c1b8cc0428f155\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/BulletHoverCard.js\":\"958759e9dc100b51\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorContentRenderer.js\":\"68587fd9b01e13a3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b121422e4ddeedd4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ColumnResizeHandles.js\":\"cd25627ea6916dee\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f2780641f0273162\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/DefaultBlockRenderer.js\":\"317acd7009b11df4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/LayoutRenderer.js\":\"d1d198d1972ce257\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MarkdownContentRenderer.js\":\"660b70d85e7e723f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/MissingDataRenderer.js\":\"855260e9a3b61673\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PanelRenderer.js\":\"1e91c35c588291a5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/PropertySchemaBlockRenderer.js\":\"efe7153dd32edbdc\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/TopLevelRenderer.js\":\"619e14e206686c87\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockGutterMode.js\":\"f7b57910a9eb06ee\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/blockTitleText.js\":\"e2a7adb129d39ccf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/fieldCreationKeydown.js\":\"b342dbef5f57cb31\",\"/knowledge-medium/pr-preview/pr-1860/src/components/renderer/layoutRootContext.js\":\"86a6601f5f8dca88\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/TypeChip.js\":\"90227160a1d78d5f\",\"/knowledge-medium/pr-preview/pr-1860/src/components/typeChip/chipStyle.js\":\"f0b836228cf72dcb\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/anchored-floating.js\":\"19a18105cbce4d26\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/button.js\":\"b65c54d91d7913e7\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/card.js\":\"29abe78989b335b6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/checkbox.js\":\"bb9e6ff2f4b66146\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/collapsible.js\":\"39adb316e7b9ef65\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/command.js\":\"04b2cff1718c5a23\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/context-menu.js\":\"8ecd92784ec711fd\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dialog.js\":\"d7d02994b4fa4335\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/dropdown-menu.js\":\"41fc5dd2112e5faa\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/floating-listbox.js\":\"1b7ffa389d00cd27\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/index.js\":\"7534aff1a17d4320\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/input.js\":\"e9900ff2e4f2d066\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/kbd.js\":\"170dd531d007c8a3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/label.js\":\"5fae2419cd6ca355\",\"/knowledge-medium/pr-preview/pr-1860/src/components/ui/textarea.js\":\"4eeb2c14f6acc1b6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/useEditModeYieldKeepalive.js\":\"573c5935d5e085cf\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/BootFallback.js\":\"d759284a0f3484ee\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/FocusedRowLazyMount.js\":\"b420ddeecf5d38aa\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LazyViewportMount.js\":\"b6491008acbb49f6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/LocalDbCorruptionFallback.js\":\"818697156ad0c985\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/error.js\":\"2196dfaacb271ba0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/lazyMountRegistry.js\":\"a771bf8d2852ede3\",\"/knowledge-medium/pr-preview/pr-1860/src/components/util/suspense.js\":\"a3b07cd5f3684253\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/CreateWorkspaceDialog.js\":\"69bf2a92de55aa53\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/PendingInvitations.js\":\"58bd34ec470e2a2c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/SyncProgress.js\":\"74b01aff4333f7b6\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/UnlockProgress.js\":\"db10666719d497ff\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceKeyGate.js\":\"05cf43cb27772d54\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSettingsDialog.js\":\"16dce6055b630180\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSwitcher.js\":\"3000ead5802e3c3a\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/WorkspaceSyncGate.js\":\"60e19b0070d8ff45\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlow.js\":\"6adfda39f4850b0e\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/ConversionFlowHost.js\":\"89d3a948a397d3a4\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/EncryptionSection.js\":\"9759af8efa2417d0\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/attachmentPrompts.js\":\"976c12fa7857f478\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f6ac9fbc10ced381\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowDeps.js\":\"534bf262940b0411\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/conversionFlowStore.js\":\"c5c2fbba9d8a8b8c\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/flowUi.js\":\"71c9f0ff2d8687ae\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/conversion/useConversionRun.js\":\"bc24d38f0a0678b5\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/keyUi.js\":\"8d7181ac5043fb44\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnKeyLoss.js\":\"e43e2b85f18c6915\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/useCloseOnServerE2ee.js\":\"888cfa454da39291\",\"/knowledge-medium/pr-preview/pr-1860/src/components/workspace/workspaceUnlocked.js\":\"8ca791dcda393d1e\",\"/knowledge-medium/pr-preview/pr-1860/src/context/backgroundSubtree.js\":\"565d1ec9fd2068c6\",\"/knowledge-medium/pr-preview/pr-1860/src/context/block.js\":\"696bf20d4087960d\",\"/knowledge-medium/pr-preview/pr-1860/src/context/layoutWsContext.js\":\"1c062d7681a951e6\",\"/knowledge-medium/pr-preview/pr-1860/src/context/propertyDisplay.js\":\"fb60171f2230aac2\",\"/knowledge-medium/pr-preview/pr-1860/src/context/repo.js\":\"294ca6acac5e9731\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasClaim.js\":\"81aa16bfb8adac78\",\"/knowledge-medium/pr-preview/pr-1860/src/data/aliasSeatNamespace.js\":\"db731bceba2d72ab\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockData.js\":\"d5d095db827aa1fc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/blockType.js\":\"4e39533893b54b6f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/changeScope.js\":\"148b0855c23cebc8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/codecs.js\":\"13e4f8fcfa4a92d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/derivedData.js\":\"0886144f5dca87d4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/errors.js\":\"a953f84116d075bb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/events.js\":\"05ec088bf1ffde5c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/handle.js\":\"251117508820b835\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/index.js\":\"6b4e27e9d2154d7c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/mutator.js\":\"cbeff338a5c6bb76\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/processor.js\":\"303fc6bd1ce34b7d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/propertySchema.js\":\"4415232f2289abab\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/query.js\":\"a19e9a9604cc8903\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/sameTxProcessor.js\":\"a588f679a8358333\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/schema.js\":\"251117508820b835\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/tx.js\":\"251117508820b835\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/typedBlockQuery.js\":\"146abc8d4cdd92e9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/user.js\":\"da1c1ac448a3103e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresetCore.js\":\"ee97e6d546e09854\",\"/knowledge-medium/pr-preview/pr-1860/src/data/api/valuePresets.js\":\"b5fb3d90a36485dc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/attachmentCleanerIOVerb.js\":\"78c7cc78a0b9e6e0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/block.js\":\"5e1eef483f9c5c36\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockCache.js\":\"0aaf11f3f45a6e1e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockId.js\":\"3d9059815bbcf71f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockLiveness.js\":\"7aec76afb0debdd1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockMerge.js\":\"52c0d5b8aae86250\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockSchema.js\":\"2406649f6d0e648b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypeLookup.js\":\"4535f0a4091716c4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/blockTypes.js\":\"1e15c35140b77be0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/childrenView.js\":\"34c8a92e018e3509\",\"/knowledge-medium/pr-preview/pr-1860/src/data/clientContext.js\":\"6fdf936f9e087d33\",\"/knowledge-medium/pr-preview/pr-1860/src/data/dbFileSiblings.js\":\"86f658625ef51cfa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/definitionSeeds.js\":\"78d8fcf2827cbd52\",\"/knowledge-medium/pr-preview/pr-1860/src/data/derivedIds.js\":\"0fa785c7f31cf4c2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/drawnSubtree.js\":\"f7e95620aaa1f042\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facetBridge.js\":\"0fe53396a03f71f5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/facets.js\":\"42aafeab70f29c3e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/globalState.js\":\"d1a37ccf84949298\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/aliasClaimRederiveProcessor.js\":\"78d667ec006e5bc5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/ancestorBatch.js\":\"cb0d440979128b31\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/blockTypeTypeifyProcessor.js\":\"5ef0dca49d76c901\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/clientSchema.js\":\"ab2e9960cc0a0c7f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/commitPipeline.js\":\"8d49ca38ad8f31a5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/devAssertions.js\":\"3aa856b725c1fb2a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/firstSync.js\":\"39e83d245247c3a7\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/freshInitialLoad.js\":\"576186e599ae17e1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/graphBackfillClaim.js\":\"119b6f2c241ed855\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/handleStore.js\":\"dc22371ba516a3af\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/idleMarkerJobs.js\":\"31aff84e23893d4a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initialDownload.js\":\"dfa02b86c3f2f8e9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/initializeClientDatabase.js\":\"1a4530890279aa98\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/jsonCanonical.js\":\"c00c9bc14b7e50dd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelInvalidation.js\":\"f693187827d2c1f8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelProcessors.js\":\"cef93954da9e282e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/kernelQueries.js\":\"a83998b1f8758b7d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/mergeTypeMembershipProcessor.js\":\"2a090ee0927a298a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/normalizeReferencesProcessor.js\":\"d1c068ae6980b9b5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/poolInstrumentation.js\":\"84a694cc6b846cbc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/processorRunner.js\":\"89845ae518273905\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyCellBackfill.js\":\"fa9e6cb97c922c06\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildMint.js\":\"6d61e5dd7b3657f5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyChildrenProcessor.js\":\"28647a513a5759bf\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f30addaae6c54794\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyDefinitionSynthesis.js\":\"b5066f791840cb03\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyKeyScan.js\":\"b6c47d2367cd925e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertySchemaResolution.js\":\"fd0254b7ef85ca3a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/propertyValueEdits.js\":\"df5531a1b1f6ece5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/raiseProtocol.js\":\"0ef6f4cc51062b70\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/readBatch.js\":\"04175112f5d696f1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/refProjection.js\":\"da929362f3e313de\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetLookups.js\":\"76e66fd0ba125b58\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/referenceTargetProcessor.js\":\"7b4d9ff89697147c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/replayMerge.js\":\"ec6f033e058135ca\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/sqlBinds.js\":\"5c8c1fdef34bede1\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"895001b225732208\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/arrivalProcessors.js\":\"9950dabc65de8a42\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/invalidate.js\":\"e75d281c77b3f1dc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/materialize.js\":\"24feac499d7e4bd2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/observer.js\":\"469860df15d2060c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/syncObserver/reconcile.js\":\"ee4c9be2a63fdd6e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/timingMetrics.js\":\"b343c424d4ec84e8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/treeQueries.js\":\"950e0d40e64d271d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txEngine.js\":\"5b6e90c64fe2fbb2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/txSnapshots.js\":\"d5c4f016b1627ad3\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/typedBlockQuery.js\":\"71c31e0510842eb4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/internals/undoManager.js\":\"24654410dc254137\",\"/knowledge-medium/pr-preview/pr-1860/src/data/invalidation.js\":\"ba970ec764acfcb2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelDataExtension.js\":\"0f4733c99edca8ed\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelPage.js\":\"366b871b0d2158d2\",\"/knowledge-medium/pr-preview/pr-1860/src/data/kernelValuePresetCores.js\":\"9e93b45eaaf96005\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbCorruptionSignal.js\":\"775b3fce80fed392\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbStorage.js\":\"b7c0f42a3eec981b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localDbVfs.js\":\"3cbd258541286d25\",\"/knowledge-medium/pr-preview/pr-1860/src/data/localSchema.js\":\"d06a18cd7596f6c4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/maintenance.js\":\"da8e0a69ab7fb402\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mergeProperties.js\":\"4a93cddde43f85af\",\"/knowledge-medium/pr-preview/pr-1860/src/data/metricsConsoleHook.js\":\"48dbd499abe17abd\",\"/knowledge-medium/pr-preview/pr-1860/src/data/migrationsPage.js\":\"4fdbdbc2c9d11c36\",\"/knowledge-medium/pr-preview/pr-1860/src/data/mutators.js\":\"02b9288e820f2fa8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKey.js\":\"53d5d4121ebcf3c4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/orderKeyPlacement.js\":\"10884481e76969c8\",\"/knowledge-medium/pr-preview/pr-1860/src/data/outlineSurface.js\":\"9031e7244610c357\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingEditorContent.js\":\"aac640ce4ed3832a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pendingUploadsSql.js\":\"7e4d805282d36031\",\"/knowledge-medium/pr-preview/pr-1860/src/data/pluginStateExtensions.js\":\"cb1e4a7b501a2e9c\",\"/knowledge-medium/pr-preview/pr-1860/src/data/powerSyncLogger.js\":\"49e6bd167a492bc4\",\"/knowledge-medium/pr-preview/pr-1860/src/data/projectorRuntime.js\":\"dbdb2c4c1c748f66\",\"/knowledge-medium/pr-preview/pr-1860/src/data/properties.js\":\"7c61a1fdf650bc4f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertiesPage.js\":\"ecab6239d70fda84\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyChildren.js\":\"2caef28b0e20e482\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionFanout.js\":\"8f3bd6f72fc6c9dc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionMetadata.js\":\"b8bd3de07bff9865\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDefinitionRegistry.js\":\"1439036545024d1a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyDisplayMode.js\":\"4b16c4c06679c627\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertyRowCreation.js\":\"a5361763910069cb\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySchemaCreation.js\":\"2daaa31299f381aa\",\"/knowledge-medium/pr-preview/pr-1860/src/data/propertySeeds.js\":\"034dc0b1af4b8128\",\"/knowledge-medium/pr-preview/pr-1860/src/data/recentsPage.js\":\"fde9190cfd8e897b\",\"/knowledge-medium/pr-preview/pr-1860/src/data/referenceBlock.js\":\"a74d4bc09e0bcbdc\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rejectedUploads.js\":\"fa74dad8af530805\",\"/knowledge-medium/pr-preview/pr-1860/src/data/releasePowerSyncConnection.js\":\"3a3c3d7b856b24be\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repo.js\":\"b968fa41377db536\",\"/knowledge-medium/pr-preview/pr-1860/src/data/repoProvider.js\":\"68f5dacd05a82a76\",\"/knowledge-medium/pr-preview/pr-1860/src/data/rowProperty.js\":\"23f94b46e7dea850\",\"/knowledge-medium/pr-preview/pr-1860/src/data/searchFilter.js\":\"4eeebe3790d3d747\",\"/knowledge-medium/pr-preview/pr-1860/src/data/seedIdentityLedger.js\":\"22a7d0f0132d377e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/stateBlocks.js\":\"38d04c6128ba770f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/structuralEditPolicy.js\":\"93df4e08e1bb6405\",\"/knowledge-medium/pr-preview/pr-1860/src/data/subtreeDelete.js\":\"f1bc938140794669\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncStreamLock.js\":\"8b0cba2ef8666438\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableSqlRecognizer.js\":\"a0a731178434bf31\",\"/knowledge-medium/pr-preview/pr-1860/src/data/syncedTableWriteGuard.js\":\"5a370a3d76daaf23\",\"/knowledge-medium/pr-preview/pr-1860/src/data/targets.js\":\"26fc05fef6b5e3b0\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeColors.js\":\"506040f86894c737\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionMetadata.js\":\"958342b910ec35ad\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeDefinitionRegistry.js\":\"58ba0d92f9f7139d\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeExtraction.js\":\"8193c1a6b1964f96\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeInitialValues.js\":\"27b020d930695e6f\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typePropertyGroups.js\":\"bc7166bc11957d96\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeSeeds.js\":\"b71533ed6f04c45a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typeTagger.js\":\"091a40a4fc875eab\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typedRecords.js\":\"d09b6c69c5ff115e\",\"/knowledge-medium/pr-preview/pr-1860/src/data/typesPage.js\":\"1b0f9a16c0b605d5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userPrefs.js\":\"2a99bc88c9a455f9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userSchemasService.js\":\"a9f7375185e80b07\",\"/knowledge-medium/pr-preview/pr-1860/src/data/userTypesService.js\":\"52120b2701ba8b14\",\"/knowledge-medium/pr-preview/pr-1860/src/data/valuePresetRegistry.js\":\"7790e0dfd4936791\",\"/knowledge-medium/pr-preview/pr-1860/src/data/visibleChildren.js\":\"721e3871d251e9d6\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceConversion.js\":\"78de1c164e8f8564\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceFirstSync.js\":\"bf2de5061d1a7fd5\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceIdNamespace.js\":\"43c0aba2cb2e917a\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaceSchema.js\":\"f2486f58c89b9d70\",\"/knowledge-medium/pr-preview/pr-1860/src/data/workspaces.js\":\"0921a9ab81c9f1a9\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadLog.js\":\"57cf1cb2a8d6dd82\",\"/knowledge-medium/pr-preview/pr-1860/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/BlockPasteShellDecorator.js\":\"13d8f305580b5e7d\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/atTrigger.js\":\"bdc59becec7b82dc\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/autocomplete.js\":\"b58c71f65f481964\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/codeMirrorExtensions.js\":\"eeba34c58c4bd487\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/contentFlush.js\":\"09fe6c7bc4dcf7b3\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/defaultInteractions.js\":\"7095789dfaf461c8\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/editSettleSignal.js\":\"7b6c2733071ed6fd\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/insertImage.js\":\"a627f4868ab7d308\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceCompletionRange.js\":\"42d471d68a885570\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/referenceTargetTypes.js\":\"dbbea06acefb6447\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/syntaxContext.js\":\"7906be2d19af9329\",\"/knowledge-medium/pr-preview/pr-1860/src/editor/triggerMatch.js\":\"a04e93fffd7cab3f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/AppRuntimeProvider.js\":\"fade09f3ad5559be\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/BlockFocusShellDecorator.js\":\"570fcfe478f8e531\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/ExtensionRenderBoundary.js\":\"d45876bc6b091273\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/PanelContentRecovery.js\":\"c752c7b77250bc27\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/apiCatalog.js\":\"3f2682078b0e3265\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/approveExtensionHere.js\":\"18406db6b282f136\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/armedCutAppMount.js\":\"a6cd59d64fb253b4\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/batchableKeyedStore.js\":\"0420b4f4825b7cb8\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockInteraction.js\":\"30b24c073d290c3e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/blockSelectionAction.js\":\"8dcd4f48619ed498\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compileExtensionModule.js\":\"44ed26ece04b0fde\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/compiledModuleCache.js\":\"4ef9eb6ad0873ac6\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/continuousGestures.js\":\"b068b28df71d0a6d\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/core.js\":\"3b0a3942913bf435\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/defaultRenderers.js\":\"74406f8138356531\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/definitionFanoutAppMount.js\":\"8cd4d7237462b0eb\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dialogAppMount.js\":\"85c9906a2dd9d19b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensionSeeds.js\":\"a4d37fb454ebc335\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/dynamicExtensions.js\":\"292359a0ac4d95ce\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/exampleExtensions.js\":\"e1a6b207c01593e8\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionApprovalStatus.js\":\"406500ab43735d4e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrorToast.js\":\"79e674b2f5918b78\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLoadErrors.js\":\"2bf4eae48242eefa\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionLookup.js\":\"704f528ebee29847\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionToggles.js\":\"0f73ad285038c69f\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/extensionUtilitiesCss.js\":\"5fa77f7aaea3c6a3\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/kernelPageDeletionGuard.js\":\"0f18db8029d87d6a\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/liveRuntime.js\":\"9eab53d2c0074880\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/openExtensionsSettings.js\":\"5b4dad9299c980ca\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/overridesCache.js\":\"001c7e2a60836fa8\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/pluginIds.js\":\"46bdf4df5d24ca18\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/processorRejectionToast.js\":\"f07ab85fa2086087\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeActions.js\":\"bfc033f74707a49c\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/runtimeContext.js\":\"2b271fab69285ddc\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticAppExtensions.js\":\"8056ebad2d60321b\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/staticDataExtensions.js\":\"f1366af376144213\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/toastAppMount.js\":\"8cd15340dacf6f8e\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useOverrides.js\":\"e712a14e25e4a112\",\"/knowledge-medium/pr-preview/pr-1860/src/extensions/useShortcutSurfaceActivations.js\":\"576e8fa1d90cb720\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/discoverToggleTree.js\":\"192aa28c875dcf04\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/facet.js\":\"ef199216feecc1fb\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/resolveAppRuntime.js\":\"6ed534a62ed01fcb\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/runtimeEvents.js\":\"5158eee546b17f28\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/togglable.js\":\"7c51bf5ef783b1ee\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/variantFacet.js\":\"85c0a41c88569e3b\",\"/knowledge-medium/pr-preview/pr-1860/src/facets/verbFacet.js\":\"f4c3bcbe99b8b06e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/block.js\":\"d05d45cf00e252d9\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/focusedChild.js\":\"8e43923c562bddf5\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/propertySchemas.js\":\"95cece76498a456e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/typeRegistry.js\":\"a4bd5a9a95d11289\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAncestorCrumbs.js\":\"60912b5a09c74f87\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useAutocompleteListbox.js\":\"33583c2c3af262d7\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedSearch.js\":\"0c5b46661dac6c58\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useDebouncedValue.js\":\"1b195a0942ec25b2\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsFocalRender.js\":\"169d89646c632e70\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useIsReadOnly.js\":\"ddc543f776d6fad3\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMaterializeBacklog.js\":\"c5c07baa2c93ad75\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useMinuteClock.js\":\"866e4f8f42297f38\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePanelLayoutProjection.js\":\"5fc3ada3364e7b43\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/usePendingInvitations.js\":\"4158300c5266df3e\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRendererRegistry.js\":\"752388ff8a9aad9f\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useRetainedFieldRows.js\":\"468c2085a38c5193\",\"/knowledge-medium/pr-preview/pr-1860/src/hooks/useWorkspaces.js\":\"ceb4928202091bbc\",\"/knowledge-medium/pr-preview/pr-1860/src/lib/utils.js\":\"79bc82b40c48b588\",\"/knowledge-medium/pr-preview/pr-1860/src/main.js\":\"184064007d1b60f7\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/MarkdownImage.js\":\"689298641a36553d\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/blockSeparators.js\":\"761b32865da83d98\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/context.js\":\"91ef6c8b0cd497a8\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/defaultMarkdownExtension.js\":\"b120ebbd9e7f8cb2\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/extensions.js\":\"8f664c564371bc12\",\"/knowledge-medium/pr-preview/pr-1860/src/markdown/renderMarkdownHtml.js\":\"ca2398025e69d84e\",\"/knowledge-medium/pr-preview/pr-1860/src/minimal-editor.js\":\"46a4b555793fb6eb\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/armedCut.js\":\"c18e2fadb8c0d498\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/captureMediaVerb.js\":\"366475d3834a6595\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/clipboard.js\":\"327ee8caf96daffa\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/decision.js\":\"b45df9854c300eb7\",\"/knowledge-medium/pr-preview/pr-1860/src/paste/operations.js\":\"0966a14ea31e3bd1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/AccountHeaderItem.js\":\"fbee793620f9e887\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/account-header/index.js\":\"9bb36a70468a124d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ff14ae2a8212b901\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askAgent.js\":\"b50de78ad003d2d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/askedStore.js\":\"d2a6a2dd1160d2ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fe082d17a177363f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/chipState.js\":\"f2fa99805ab013fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/dataExtension.js\":\"f886bc1882de7490\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/index.js\":\"02d790ff08b8bd30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a33de46e69585f27\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-dispatch-companion/schema.js\":\"6d6aa1d2d81803c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e02a730ec7cab59b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0ff7fc50aaee8818\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/addMedia.js\":\"77369dad3b76615c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6815a9e996ab1f48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/block.js\":\"b563da71667a482f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/context.js\":\"219874fdd2604e10\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/displayIds.js\":\"99bfebd9958a2a52\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/index.js\":\"4baae849bf333a2d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/outline.js\":\"5622ce19afd815a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/properties.js\":\"909336dc7990d220\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/refs.js\":\"ba05781afd4b32b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"dba5a78257e8765b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/search.js\":\"4f5eb0e2cd0cea74\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/shared.js\":\"534233d71d32f7c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3be0013cef41409e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentViews/text.js\":\"af27da422defcea1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/agentWrites.js\":\"e56613dba60a23f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/authoringCatalog.js\":\"33a60c3418e3312d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/blockRefTargets.js\":\"a31a4023c9620a34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridge.js\":\"d9ccf7122504dec3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/bridgeLoop.js\":\"69b2a14ce547a7e7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/changeHistory.js\":\"da552c1490bddc7b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commands.js\":\"8c418de3eb809713\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/commentsCommands.js\":\"16c1900b31714c79\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataExtension.js\":\"2d7c274066e126bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/dataModelGuide.js\":\"1d8744a7652c17aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/describeRuntime.js\":\"82b239498428bee5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/extensionLint.js\":\"55d73a3136c070f0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/grainAudit.js\":\"180f29b3ba6be2a0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/healthCommand.js\":\"b944e7b302066c5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/index.js\":\"c49eac74030357aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/presetIdentity.js\":\"e3672acfa5892a38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b3bdf5324008a024\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/readMedia.js\":\"33a90562ce09ab5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/schema.js\":\"39e32889ae603e28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/serialization.js\":\"56fd6ad6dd88117b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/targets.js\":\"82a1ab0810173df1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/tokens.js\":\"b0b6b6c71bba684b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/watchEvents.js\":\"b9e105a383eaf027\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/workspaceGuard.js\":\"6b631fde71561790\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/agent-runtime/writeCommands.js\":\"385d28fd2b4cfbe3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/AliasCollisionToast.js\":\"c92115a9ade96248\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/DuplicateNameBanner.js\":\"583fb594f8deadb9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/collisionMerge.js\":\"cc3a66ca06010ce0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/dataExtension.js\":\"b85e5f28003c7ce5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/index.js\":\"90a2153e83b435b6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/mergeCollisionAction.js\":\"36227e0723b9c04f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/pageStyling.js\":\"63eaf842a657ba0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/rejectionToast.js\":\"c78bc219001b0060\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/alias/syncProcessor.js\":\"6e9bc78a40982de4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/actions.js\":\"00c719231b14293e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/addComment.js\":\"3389e22a7db18e9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchor.js\":\"1d0f48928125a7e0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/anchorState.js\":\"1cad9857c90fe6df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/commentLinks.js\":\"80e75305cb4a1b80\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/confirmThreadDeletion.js\":\"c2ac504d36442cba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/container.js\":\"6ff94d90d6a2a5d5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/dataExtension.js\":\"35a633b5ae0b9cfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/deleteComment.js\":\"5b95d71723e6564f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/highlights.js\":\"ef090a2db6bb869a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/index.js\":\"3fd9a543bcb6dc73\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/linkedCommentsPill.js\":\"15c6eaf78df87ad9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/margin.js\":\"feb0e0f8d974f199\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/marginSchema.js\":\"b080ce599c43cb7f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/newComment.js\":\"1da3c1582931a2e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ownThreadPicker.js\":\"738322f3c3ff04ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/placement.js\":\"5830f079b3012694\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/queries.js\":\"68590d268c1f6307\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotePosition.js\":\"5e772bfce82d0aed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedIn.js\":\"a074fbd5cfb7b8c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/quotedRange.js\":\"91341f8cc0b49a50\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/rangeRefs.js\":\"262727e04dd4e66c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readHighlights.js\":\"7c33524b11416db5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelection.js\":\"701725f61a327c43\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/readSelectionUi.js\":\"abc22acd8d5bc40b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/reanchor.js\":\"7a50d39209df2531\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/schema.js\":\"035bb9df3fc61e82\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scope.js\":\"634ea37f077c2519\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/scopeThreads.js\":\"237dcbdccf6f9a96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/splitRetarget.js\":\"2cdba0c45f74aad9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestionCard.js\":\"28af26aeddf859d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/suggestions.js\":\"985263098827a7ce\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaries.js\":\"614d153d783b9cae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/summaryBatch.js\":\"989efda1907b3cbe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/surface.js\":\"9a233d5896752c2b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threadNavigation.js\":\"fc829e3fc19090aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/threads.js\":\"fdf2e3854961c810\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/ui.js\":\"5e00d51359729af3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/annotations/uiStore.js\":\"42e2ed6e48f09c47\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/appIntents.js\":\"7c1f0c3cbcfaf31e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-intents/index.js\":\"b237400e6982c8c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/index.js\":\"b73bf5cd8c0d36c0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/app-update-prompt/status.js\":\"26adf2b4a7f7a0d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a44d274c20264d28\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaBlockRenderer.js\":\"0f1aa0d848dad9d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1c7a6b7b1a9b5060\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/MediaUploadReconciler.js\":\"688f92758290b7ae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetDownLane.js\":\"325a976f068bf510\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetResolver.js\":\"d16c1b4ac7a775d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/assetUpload.js\":\"cf694c66c4297f4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/attachmentCleanerIO.js\":\"3d37e9c59c1d78b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2eff83d1a670e577\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/blobStore.js\":\"ca06f0110ddfb9ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/browserMedia.js\":\"65e5234a25f3d3e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/byteStore.js\":\"5b4e4125fc80715b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanerIO.js\":\"63130c8e51a556f6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/cleanupAttachments.js\":\"c78d8df93d622a72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/dataExtension.js\":\"db899be2c1b5f9e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/downLane.js\":\"934f1b4ae10a76c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/index.js\":\"0edce79ed2e7af82\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/insertImageContribution.js\":\"fcb9eae57d142a61\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneArming.js\":\"49cb943aba3c2eb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/laneLock.js\":\"c07a9e7e48e3e546\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaBlock.js\":\"538f8915bf22eb25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaCapture.js\":\"2affc45a77b8a7e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaLanes.js\":\"e5841a6dd853eeae\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewers.js\":\"9a2816dcdd727ec3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/mediaViewersFacet.js\":\"e7dfa280a341b15d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/pasteCapture.js\":\"3e67190bae4d18ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/resolver.js\":\"2b98e926e0df2b44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/retryUploadsAction.js\":\"ac7f64271dfebb6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/storagePaths.js\":\"fb3473d0de54e71e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadDrain.js\":\"2619b5d5376d7f93\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadLaneStatus.js\":\"044bcb9de74a459a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadReconcile.js\":\"3a3dd14a0c736973\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadRecovery.js\":\"bc900e44d37814e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/uploadStore.js\":\"a6bd822c23baf825\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/attachments/useAssetObjectUrl.js\":\"a7d0f4a34fb1887d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"78068854ca87f2ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/BacklinksViewSection.js\":\"73ff021a3d8eae68\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/facet.js\":\"ad9cce41fd46afa3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/index.js\":\"141bbcc5222a3f4a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks-view/prop.js\":\"001e718a450900cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinkFilters.js\":\"e2a09ca5a60c5a88\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"64c405b01759828b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/BlockEntry.js\":\"c6c459842c88f8fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/LinkedReferences.js\":\"cafbdb65c18333f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9dcb79333dec23ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dailyNoteDefaults.js\":\"12991082fbc26544\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/dataExtension.js\":\"2816c2c04fe93c8e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/edgeExclusions.js\":\"8368a0d04b9d2911\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/filterProperty.js\":\"1c3a6bc999ac24eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/index.js\":\"08a7742f06d52228\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5045fe775867f892\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/applies.js\":\"4a6733401aeabdcc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/countQuery.js\":\"d4835f0e12b5c901\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f69d6755f57ee9a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/index.js\":\"ce2f96562ca944c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f33f7bea241971af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/presentationInvalidation.js\":\"93217ae455977727\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyEditorOverride.js\":\"32d2e68e43ba5711\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/propertyFilter.js\":\"52fc289ac539d351\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/query.js\":\"6d18f8124b2e4f6f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/resolveFilter.js\":\"8db3f50c386bb9b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sourceBatch.js\":\"94582f0bdb672ce1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/sources.js\":\"53f5a430ba9d4050\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useBacklinks.js\":\"034f00088f7e3235\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"283334e538263bab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayCelebration.js\":\"4ee1aefda4af7b5d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/BirthdayOverlay.js\":\"8157581aca48508d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/gate.js\":\"7538b7c5e7797ff8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/index.js\":\"07042063e39851d3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/birthday/wolfTheme.js\":\"942462a3236424dc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/BlockDragLayer.js\":\"ce4c3770f1e0633e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dragController.js\":\"28ff74af720b4321\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/dropTarget.js\":\"25f4d76be1d3f480\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/index.js\":\"8d0b1d363637d049\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-drag/projection.js\":\"b9f4cbc63848f8a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/BlockMetaCard.js\":\"3e326fe559377399\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-info/index.js\":\"ca2a304d570e0aef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/AddTagDialog.js\":\"382c541db990bf17\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"756958aa516c3633\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/TagNameIssueHint.js\":\"71a7949cf1047572\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/addTagAction.js\":\"9ce43e065516eaa3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/appendTag.js\":\"3dd8144354468967\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/config.js\":\"4547d04813d2daf9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/dataExtension.js\":\"b8874dfc087bf87b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/index.js\":\"70ec57d83a7a6e72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/block-tagging/propertyEditorOverride.js\":\"2caf7ad2fdb1a4ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ec299b71cbd00b83\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6c8fd20322a5040c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/Breadcrumbs.js\":\"adf6206148dc05e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7ab06d74bfc0bfe6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"96cb38528c421ef9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/index.js\":\"8649a58b1f54f744\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c1e44a95c44063b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/CharacterCountItem.js\":\"b23cff46e62a4fc3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c03325c9ab359397\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/actions.js\":\"64bb0d5144832abb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/blockType.js\":\"b56d29096fc66814\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/charCount.js\":\"9f4788142a075f6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/dataExtension.js\":\"3e3e15141b33111a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/index.js\":\"c414b7aee146e868\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/profiles.js\":\"468087c002cb4435\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/properties.js\":\"09189fa48f90725a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/character-counter/textCounts.js\":\"de27ed880d31ca9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/colemak-keybindings/index.js\":\"50f5afa9d488a6ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/CommandPalette.js\":\"f4fb9e66a48fbad6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/HeaderItem.js\":\"7b37af95468b48bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/context.js\":\"236228457e5f2555\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/index.js\":\"ba65a57f365bddd4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/selection.js\":\"cfb93cbde004310d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/toggleStore.js\":\"05a33b5d2bc87585\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/command-palette/useCommandPaletteActions.js\":\"117b5cc6e1ca4c89\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/ContributorBadges.js\":\"83594d9200fda2f8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/author.js\":\"ee5c1d567c93fcb6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/codeMirrorExtensions.js\":\"c0fd73d146e33c81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/dataExtension.js\":\"cf06701c7ab233d0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/index.js\":\"e982f2722229e360\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/mentionAutocomplete.js\":\"f5fd5994cfc33ecb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/processor.js\":\"3cb6453882013624\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/profiles.js\":\"cf122504f740bee3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/queries.js\":\"71a56d391264e368\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/contributors/schema.js\":\"46834e76c353adbd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"995ad6ae3c18338e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e03b65443ef27597\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/index.js\":\"4bf8518fdae7cebf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b996dccf1d8f82b1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"ae59a233ed2dbf2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/CalendarGrid.js\":\"ca9e58e84f576b09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DailyNotePicker.js\":\"b60aa5cb5b22d762\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e0a38f7c5349e9a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateNavDecorator.js\":\"61fd34c0e2af000e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/DateScrubOverlay.js\":\"90dc688e1de4338b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/HeaderItem.js\":\"6c6219da5f015ab5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/ReschedulePicker.js\":\"9a18d4f4d7043298\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cdfce77b996fde4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/actions.js\":\"b4d34c435eb08988\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/blockDateAdapter.js\":\"c3e34f3719f420a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/calendar.js\":\"39957f18c81bec23\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dailyNotes.js\":\"43ee3979b182fa63\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dataExtension.js\":\"7f1ebee743171645\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubActions.js\":\"06350bb7ba52aec5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGesture.js\":\"66b0fd94bc58c06a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubGestureActions.js\":\"cb23308ad4572559\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b02d470068edb7ac\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/deletionGuard.js\":\"2e38e58aedb257c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/dueQuery.js\":\"fee458aac9ff83c4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/index.js\":\"b0ef17c01bf45511\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/landing.js\":\"b1ecb7e36f9fddc9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/localSchema.js\":\"002a30bff2585543\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/referenceDateAdapter.js\":\"1ef57116894bcc56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/rescheduleAction.js\":\"3dda49615166c673\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/schema.js\":\"3e3db567a9a74472\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadBlockDates.js\":\"70bd120ecc282886\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/spreadDatesAction.js\":\"594b48b25adee5e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/today.js\":\"ddaa7bb95ba750b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"85b056f7aba0f4ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9d827668f47a35a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/audit.js\":\"526d370607a04892\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditAction.js\":\"8af5be807f3b0d85\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/auditRanges.js\":\"f1a91eab1671f67c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/diagnosticsSource.js\":\"d233b87aa3c5950b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/divergenceScan.js\":\"cf23bba822dbbb0e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/index.js\":\"a8b650340059bd9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b2fd79d832dd3915\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/referencesMirror.js\":\"8b2030cc59bd947f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/rowJson.js\":\"33ee3b3c3fa4191b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/schedule.js\":\"259c5708bb5946a6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/data-integrity/store.js\":\"ca40605b082ab223\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/action.js\":\"783ecd96b56d1d0c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/index.js\":\"2199a25383deecf5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-maintenance/plugin.js\":\"434edbc4f1f515eb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"21bd9125a7d4ef36\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/actions.js\":\"8b4499eee2d2587f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/changeMarker.js\":\"afc7ece5ed9e1bb6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/diagnostics.js\":\"623fb72694477eec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/fileSystemAccess.js\":\"b16753d4ac488bbc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/filenames.js\":\"eae788ae2e6310e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/index.js\":\"34dbcfb8aa20ef89\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/mirror.js\":\"6f093ef41147ff1c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runLock.js\":\"1c102dda81fea169\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/runtimeHealth.js\":\"00589de2632ed43c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/schedule.js\":\"5efdde95527514df\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/db-mirror/store.js\":\"d79b2afe63bbe297\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/index.js\":\"480597ba83722d45\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/default-themes/themes.js\":\"21e9ebfee65e95de\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/facet.js\":\"27799e6ea190d973\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/diagnostics/useDiagnostics.js\":\"ef70b0e31a3ef78d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/dismissals.js\":\"74654ca0ddedcacd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/index.js\":\"266f08a05de63c59\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/status.js\":\"4486ce87ced2cca2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extension-prompts/store.js\":\"ac89158a65907f9d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a368bc3cc7ace9fa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4f60745d76287bb3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/actions.js\":\"1ef6f5f826b83e19\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/config.js\":\"7db45896d032de38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/dataExtension.js\":\"73fed3d7b0d4fc2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/effect.js\":\"5095a6868881b389\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/index.js\":\"435054e3959b62f5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/propertyEditorOverride.js\":\"87ef6ca1c266b586\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extensions-settings/useToggleTree.js\":\"10fdfa34e586f11f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/ExtractTypeDialog.js\":\"e819f1675fc60a36\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"72508ecb91691776\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/PropertyShapePicker.js\":\"ce413ad600b5ebab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/action.js\":\"ce89d3e2e2bae394\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/extract-type/index.js\":\"25d8eed8d287642d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/FindReplaceDialog.js\":\"6ecf9864246ca63c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/HeaderItem.js\":\"86ba02ca32f55e29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/dataExtension.js\":\"b5193dd5483b3e54\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/index.js\":\"8c57499c33da451a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/search.js\":\"9d020b2f0b85ec40\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/toggleStore.js\":\"9207a687e9e78bc5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/LocationPropertyEditor.js\":\"b9f9c743e7a8dfef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/MapView.js\":\"f6169c3102abafd1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/blockTypes.js\":\"fb3face3d8eac1f9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/codeMirrorExtensions.js\":\"6086b0d77a199c34\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/createOrFindPlace.js\":\"c3c7cb3fb58a90ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/currentLocation.js\":\"6bd117a1b1c569e4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/dataExtension.js\":\"b8dbfc554fcba294\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/geoContentDecorator.js\":\"f63858b8e9ff4610\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/googlePlacesClient.js\":\"e44651ee9129ccef\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/index.js\":\"6ad5ce530d844f1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/locationsPage.js\":\"b7216a50ebf6e5b3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/mapViewport.js\":\"541b2a41962f23d8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/pickCurrentLocation.js\":\"43f4d93ed89a3778\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeAutocomplete.js\":\"ecde77819c2b3689\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/placeNameCollision.js\":\"9051bacec5b8a39d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/properties.js\":\"5acdbf1c4d1904c6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/propertyEditorOverrides.js\":\"ea9eaf24134a70bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/query.js\":\"78f57c9cfddc0490\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/geo/usePlaceSearch.js\":\"ecb4ea541c680922\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f5c6e85e627b61ee\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d07225fe046c6c4f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2e89a0f3db93b41b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/config.js\":\"eb5cf0c4d2e0581c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/dataExtension.js\":\"f1233f162423bdfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/facet.js\":\"11b79d2e7ac9cd32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/grouping.js\":\"aba1bea4a7dc1a87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/index.js\":\"6ff4e55a150d576b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f21444c0f07a3c90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/query.js\":\"7875800d113d7dd9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/resolveConfig.js\":\"d1e413b4e178872c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"045a7bb22165fc38\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9ae87d0a64c3c0a2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlDocumentContent.js\":\"294644c277fbc952\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/HtmlFrame.js\":\"9279f68f07076b56\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/actions.js\":\"6cfbcda98fe2d213\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/blockType.js\":\"ced37ec315b3de6a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/confirmRunScripts.js\":\"9ae645b836096c22\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/dataExtension.js\":\"278faeed852443c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameAnnotations.js\":\"c4356014dd1800b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameDocument.js\":\"c84adfa27c61d121\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/frameTheme.js\":\"cd1dff682c6ed837\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/index.js\":\"5a5ac921dac62e9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/scriptConsent.js\":\"46c4c26ad0cd4769\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/sourceMap.js\":\"9f32874d21f5794f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/html-document/useDocumentScripts.js\":\"d47a00b722a05701\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/index.js\":\"9cf7c2e1c9f3f8a4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/record.js\":\"6437a22bc0946b48\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/recordStore.js\":\"4e370ced079fd42e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/responsiveness.js\":\"0f1e81fc35596f70\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/schedule.js\":\"2ee9c9d88e092b99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/interaction-metrics/sessionContext.js\":\"d7af41650d4296cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"18e11bfa9c93b6a8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2c83cd24b51b457a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/actions.js\":\"4d80313a37dbb658\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/config.js\":\"47e78b6d1ba44d5e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/dataExtension.js\":\"7f108a7bf6ebe0d4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/effect.js\":\"97fbdd94a8ccb29d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/index.js\":\"b558e4e4b067d927\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/keyCapture.js\":\"a9c35c54b52f56c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/overrideStore.js\":\"08683783f6cfefba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3984a60a48721723\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/HeaderItem.js\":\"43d545f301564d53\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/LeftSidebar.js\":\"a8e81822a71cecc4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/actions.js\":\"52acb583027c8817\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/facet.js\":\"cabe86df8519eec7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/index.js\":\"97fbe4d2991f61aa\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/shortcuts.js\":\"b8e81d9eb6d8c1ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/left-sidebar/toggleStore.js\":\"04a66b0d5e380115\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/MergePicker.js\":\"646410df1c323179\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/index.js\":\"fac2cdf9d1dc6ce4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/mergeAction.js\":\"8ae5b86d56566ea4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/merge-blocks/strategy.js\":\"001d99af0f9684fe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/Button.js\":\"b5da90afc5dfa344\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b81d5f88665369ec\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/defaultItems.js\":\"39fb4997f6370e05\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/facet.js\":\"a8a4eb03c18fe272\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-bottom-nav/index.js\":\"b80a5e5aab64603b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cb390d56468593e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/actions.js\":\"06a4d3718c002835\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7331b8ccf18d72e9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2bb3d01396b0d2c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/mobile-keyboard-toolbar/index.js\":\"225d8bae4af577b9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4160ce290fc3ceb5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0bfc82823ef37796\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/contextMenuItem.js\":\"2f432c5b858b100c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/index.js\":\"742d2a4cea8f4182\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveAction.js\":\"987903ef2737a242\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/moveBlocks.js\":\"d30f23fd1a7cfe9d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/move-blocks/selectionAfterMove.js\":\"b91f84981358ccc8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/TutorialBanner.js\":\"b0ede76d48ae4804\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/action.js\":\"a48dc2ed89981a32\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/bannerDismissal.js\":\"75237f4b10c213f3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/documents/cheatSheet.js\":\"28b3ee3a1c634492\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/index.js\":\"e789e21a7ad1b1fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/keys.js\":\"c4375a961151fbb6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/landing.js\":\"c89c98f2b6f717a9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/outline.js\":\"7ce639740ea4d3c3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/onboarding/seed.js\":\"a88e07f39cda9be1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4f6b999db9ccfc6c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/analyze.js\":\"cab9bf83f6e37887\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/diagnosticsSource.js\":\"a971f0d2e7268be9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/index.js\":\"5980ff87805ba7d7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/load.js\":\"abb89c2d7a5fa26b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/monitorRun.js\":\"b93af709028dc80f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/schedule.js\":\"720ecb925e34973f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/series.js\":\"7a0ebb37a860e57a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/store.js\":\"debb0bb64581bd9c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/trendAction.js\":\"51456553baf6897a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/perf-monitor/verdict.js\":\"ea0e9e18564bd84c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/clickToEditAction.js\":\"377c51a64fefecf6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/index.js\":\"4269dae98d3f6cd5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/plain-outliner/interactions.js\":\"c909ba88174b7b24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c84cee67625845c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGate.js\":\"1226d1907d50c617\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/MigrationGateDialog.js\":\"a02effc586083486\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/action.js\":\"881070b3efd20d3f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/index.js\":\"fdc5c4bee05f5a06\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/localRunMessage.js\":\"acb3a89423d41ce2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/plugin.js\":\"fc05755624807e61\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/progressReport.js\":\"3895a878ee0fd569\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/properties-migration/sweepProgress.js\":\"832034e53f7acb11\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/FieldRowRenderer.js\":\"87ed555be6d10f75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/ValueRowRenderer.js\":\"f471d4917bc0252c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/actions.js\":\"3f1b07197fcebfbf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/autocomplete.js\":\"b6f75b0ca9b0ad2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/fieldRow.js\":\"78e1b56b631a8536\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/index.js\":\"a82f4b6b3d2b905f\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/referenceWarning.js\":\"651c19aeab89bf1d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueAutocomplete.js\":\"a0b1b9638c5b6978\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/property-rows/valueSchema.js\":\"f400202f25fcd056\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/HeaderItem.js\":\"0d88623b535dc2e2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/QuickFind.js\":\"53575179b3e7a62c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/index.js\":\"bb833bc94040611d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/recents.js\":\"9f952b94e3eda214\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/resultItems.js\":\"3ee99f4a4671fbda\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/selection.js\":\"059e291e3ab5b8c9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/quick-find/toggleStore.js\":\"f0833ef2ac19da40\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/HeaderItem.js\":\"a157edf2db941cad\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/RecentsPageBlockRenderer.js\":\"97f2bf9db691c51d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/grouping.js\":\"74a65ac2ae936df5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/index.js\":\"10b9f2a56e97a792\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/recents/target.js\":\"f90301956fd05879\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/codeMirrorExtensions.js\":\"45354f9d06926c60\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/contentPrefill.js\":\"15cade032286f847\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/dataExtension.js\":\"5232ceed94470ab1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/index.js\":\"14ad7db09e722f09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"dd1513dbb2105c0d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/invalidation.js\":\"d5ed37ae18991d81\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/localSchema.js\":\"2685391a17624eb8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/index.js\":\"a4d7884af73f532b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8c4d3df4695fcf44\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/index.js\":\"98d83210128ea2c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/referenceNode.js\":\"966f5387c2af4181\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5afd4466730dafed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cac87c6cea95297d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/index.js\":\"e75fdf269512ea6b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"15787cb8d1f3ca2e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ba5eb2f9f5e23137\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/mergeRetargetProcessor.js\":\"7b69a6afbcf76c98\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/parseFence.js\":\"a51329f27754eee3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceParser.js\":\"6647bcd2e2a0ad24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referenceProjection.js\":\"98f7132dd2cde5b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/referencesProcessor.js\":\"fda1ec9da96e32be\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/renameProcessor.js\":\"f185decd87e830ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/references/spanReplacement.js\":\"c2fa2fbaa70e368a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/htmlToOutline.js\":\"8d43d7981cf4701e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/index.js\":\"60c261c7ee15bad0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0442d0755c75942e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/rich-paste/pasteDecision.js\":\"50b6c4dce9bb0167\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/action.js\":\"40ed5e056c9350d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/blockIds.js\":\"ed0e76c73c4c9da0\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/content.js\":\"cf01bc56864c460d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/effect.js\":\"fefc02adc2b62006\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/ids.js\":\"349138644b9f5d24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/import.js\":\"db5b8cb6ca141d96\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/index.js\":\"011bf87fb2049bd2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plan.js\":\"0b5499d5390abea4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/plugin.js\":\"4fae446864cf3afe\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/promotion.js\":\"0106b6e9ac6de4ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/properties.js\":\"af211c02767da63d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/references.js\":\"a72e2a504071950b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/report.js\":\"5342752c4ae00dc7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/roamMemo.js\":\"53a900caf2eaf78a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/runtime.js\":\"05445e8e61d6a39c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/schemaReconciliation.js\":\"73840dc7943422bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/srsMarkers.js\":\"764142a906cd45d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/todo.js\":\"313a3467034d1ae6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/typeCandidates.js\":\"2808060e626e42c1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/roam-import/types.js\":\"786fbde1a1a067f7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/index.js\":\"68eb5c5bcb212ef8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/search-health/store.js\":\"339ea064bb4f677e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/HeaderItem.js\":\"78c176c5d98f6393\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a3b9fad0dd013a4e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/index.js\":\"fe875383bca1e5f2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/model.js\":\"45df24fdcd257634\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/toggleStore.js\":\"770c7edca23f9194\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/shortcut-help/useKeyInspector.js\":\"368079fc67f4cf62\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e0ba6bee04763d14\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/ShellDecorator.js\":\"fbf2d6dc8298502d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/actions.js\":\"26bc2b9adf4d9a3b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/exclusionsFacet.js\":\"02b74f7415e7dc15\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/index.js\":\"ab9215db9c8d5731\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/shell.js\":\"7631a292177a08e1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/surface.js\":\"d13d4825104eb792\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/spatial-navigation/walker.js\":\"66e0b1a39db42826\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/RescheduleToast.js\":\"72595fdcf6d3f202\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/dataExtension.js\":\"dc15966862714b55\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/index.js\":\"e9f8962daa5d6e5c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/indicator.js\":\"459cf0b67875281d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/moveSrsState.js\":\"0b5438ddcc894d9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8cc4f402f44744bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/scheduler.js\":\"c0d6d267b3360b87\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/schema.js\":\"5ba6426afcf72599\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8a5f60394d3423b8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/srsClipboard.js\":\"933bec87055d73d9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a192b2bf7bf7c6ff\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DailyNoteReviewHint.js\":\"250a3f143ccd4b75\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/DeckPicker.js\":\"f5e3df2e8c4962bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewControls.js\":\"868deedda3d80d72\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e68f7a7e099892b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/ReviewSession.js\":\"886e8809fd5a4a5a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/actions.js\":\"577d904702fb9978\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/archive.js\":\"fa1d497e4ae06a30\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dataExtension.js\":\"3288a77670a65aa2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/deck.js\":\"568b146b20a08c24\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/dueQuery.js\":\"68df0d1dbab752bb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/gradeDecision.js\":\"ef1a4b1e32b86687\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/index.js\":\"fafac927c1fefa45\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/keyHints.js\":\"bb60d5a68db49ed7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewCardLayout.js\":\"3f075fdde09cfdca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/reviewProgress.js\":\"b3a89177a890c2af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/schema.js\":\"ee577dacee31e5b4\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/srs-review/useDueCards.js\":\"4bb467eda55ec790\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/index.js\":\"b778ae7946009cfb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/startup-metrics/record.js\":\"94f80b029b8dfe4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/index.js\":\"6de0e3c566b195af\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/persistenceStatus.js\":\"069214ff791ca9bc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/storage-persistence/requestAction.js\":\"826558a217764b29\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/TypeChipsDecorator.js\":\"3c26752a6a309d46\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/codeMirrorExtensions.js\":\"65ac18f2910613ed\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/index.js\":\"510877cbd884e801\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/supertags/typeAutocomplete.js\":\"136a86bfacdaee99\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"aa5bd9fd3103f2fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/actions.js\":\"6cc8f2dd3848c2c2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/anchor.js\":\"d31e35d76084cd8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/events.js\":\"89d1057435fab9fd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/gestureActions.js\":\"e416393703151a94\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/index.js\":\"9f800108ed18d774\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"33e122c2c128c385\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/collect.js\":\"c0d22a055c98f971\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/index.js\":\"43759d1c830e3717\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/sync-metrics/record.js\":\"59baff09692a15b5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/RejectionDialog.js\":\"93636e6bfc4acd8a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d7ce57f17933df4d\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/index.js\":\"506956bea7a5b900\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/model.js\":\"109a5567085cc0d6\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/queueCounts.js\":\"6bf76ee5f600f453\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rejectedHelpers.js\":\"550f03e168557167\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/rematerializeAction.js\":\"3af8e7e26e2dc240\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/system-status/useHysteresis.js\":\"4d3dd303b50abbfd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/ColumnHeaders.js\":\"b99aea0800ddd9ca\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/QueryUi.js\":\"85a6f30afa5d1c3a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/TableLayout.js\":\"a85c89624604a026\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/actions.js\":\"01bb17cd798638cb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/cellEdits.js\":\"d7315d0d0048274b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/columns.js\":\"431c5c198fccddf1\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/controller.js\":\"0c46a66cd7f2eff9\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/convert.js\":\"046e155b52afcd9e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/dataExtension.js\":\"8a00c08c13da27cf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/index.js\":\"57687f3cfe1f5701\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/keys.js\":\"2e21a6d26a5aa739\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/model.js\":\"0dc2c12614518500\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/navigation.js\":\"fe7083234aa7a550\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/backfill.js\":\"7e75852f7aac2525\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/completion.js\":\"b065961744ab96c8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/format.js\":\"052b0f742f52d198\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/parse.js\":\"0ab9bcc0a28e53cc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/queryValue.js\":\"40ee60c7782745bd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/query/source.js\":\"17aef0d48996c3e8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/registry.js\":\"63f3926b8f0581fc\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowGutter.js\":\"b0864f39211ac481\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/rowVerbs.js\":\"a85b465a5b6b1e25\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/schema.js\":\"511a9f13859f6006\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/tables/sort.js\":\"cd1b0f9937d9efa8\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/effect.js\":\"c52b5608392876ab\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/index.js\":\"e53e679c4e7c4a9a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/theme-toggle/theme.js\":\"fc408b7728acf1b7\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/actions.js\":\"ef9fb263d568dd90\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/dataExtension.js\":\"725e7a7eaa803386\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/index.js\":\"46e6478c53b77243\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/todo/schema.js\":\"1f77c22b9f49a602\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9666d6267853867e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/actions.js\":\"9ac44fb5b48d6f19\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/defaultItems.js\":\"58b6452e0f9e16b2\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/facet.js\":\"409fcb86a11c12e3\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/holdRecognizer.js\":\"f9d4021114ea01fb\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/touch-selection/index.js\":\"98dff9215618b8ba\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/UpdateIndicator.js\":\"47c6f8db77da0000\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/index.js\":\"d30170a37a307fda\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/update-indicator/loadTimes.js\":\"548342e8fd171795\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoNotesRenderer.js\":\"6f7bca6f5196501b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoPlayerRenderer.js\":\"7fc70536cc24a1cd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/VideoTimeStamp.js\":\"da7b3e6b356c5c09\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/actions.js\":\"f7e6986c75b241c5\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/index.js\":\"a9503f984b3fd6da\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/markdown.js\":\"4c63dce02b4e847b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/notes.js\":\"06901abe637ce063\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/registry.js\":\"b51217d56341a3bf\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/remark-timestamps.js\":\"fe83ef27c990f88a\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/video-player/view.js\":\"0d22662ec610ee76\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/LinkHints.js\":\"ef883eea99b3e3dd\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/index.js\":\"9db10cc6e755504b\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/model.js\":\"7118b4b1c12e062e\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-link-hints/settings.js\":\"b8b5e5d581461458\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/actions.js\":\"245e7f4e20828111\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/index.js\":\"fce062960888835c\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/vim-normal-mode/interactions.js\":\"4896a9a7e608d794\",\"/knowledge-medium/pr-preview/pr-1860/src/plugins/workspace-header/index.js\":\"236a1b8153369e37\",\"/knowledge-medium/pr-preview/pr-1860/src/registerServiceWorker.js\":\"d0cb8716342cdc16\",\"/knowledge-medium/pr-preview/pr-1860/src/requestPersistentStorage.js\":\"29565b4e1059a212\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authRequestDeadline.js\":\"093491ab2bc44c40\",\"/knowledge-medium/pr-preview/pr-1860/src/services/authStorage.js\":\"263736395e3d844a\",\"/knowledge-medium/pr-preview/pr-1860/src/services/powersync.js\":\"ac2b8811fc193c39\",\"/knowledge-medium/pr-preview/pr-1860/src/services/supabase.js\":\"901c02f23bc39641\",\"/knowledge-medium/pr-preview/pr-1860/src/services/uploadErrorClassifier.js\":\"5c2c772e35dae9c9\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/ActiveContexts.js\":\"4ea0000da96e5b15\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/HotkeyReconciler.js\":\"d3aed412647b4d6a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/WipeLocalDataDialog.js\":\"f4c07b3d9310d29e\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionDispatch.js\":\"c6ac53c71de7657f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/actionRefItems.js\":\"71358caa45dad904\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/applyKeybindingOverrides.js\":\"23215cfdd30c5cb5\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockActions.js\":\"660d97aa8c89b327\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/blockMergeGesture.js\":\"d17dfa5279296aa2\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/canonicalizeChord.js\":\"add19a42cc9eb40f\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultContexts.js\":\"351427f2b967ca46\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/defaultShortcuts.js\":\"e8cd03c779e443e5\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/effectiveActions.js\":\"fb29c90bfc9d3e83\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureAction.js\":\"ebf183ecccd06eed\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/gestureBinding.js\":\"ef60dd588100136a\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/holdRegistry.js\":\"622c708feeb0f532\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingConflicts.js\":\"826d2c1ff113b027\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/keybindingOverrides.js\":\"0cf323c20051c5db\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/pointerAction.js\":\"9929395e0c5ba0f6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/resolve.js\":\"48c2bf79d221f021\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/runAction.js\":\"245c4504ff945302\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/sequenceMatcher.js\":\"a07f8c5120e245a6\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/types.js\":\"a6bc01a557b7610b\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionContext.js\":\"6375d311828405b9\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/useActionDiscovery.js\":\"6982da8ced11daff\",\"/knowledge-medium/pr-preview/pr-1860/src/shortcuts/utils.js\":\"b942d247cead5bdf\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/bootStore.js\":\"f29eb9509f46f005\",\"/knowledge-medium/pr-preview/pr-1860/src/sw/previewDatabases.js\":\"05b1c40829bc783b\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/byteTransform.js\":\"7e7a83695e60a8f2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/attachmentCleaner.js\":\"295dbf5068cb699f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/attachmentParts.js\":\"98e7090a953094e0\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleParts.js\":\"b08297c9430d3c4c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/bundleRecord.js\":\"2d417f2923b09f60\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/manifest.js\":\"fc16523ccd36c9a4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/takeBundle.js\":\"1b7a4822557e3c63\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/bundle/verifyBundle.js\":\"fad242d1c86a92ba\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/cleaningStage.js\":\"49a6bc2b8092a013\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionKey.js\":\"6d12563fc4bc17cd\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/conversionServer.js\":\"9ec3e110dde8cea2\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flip.js\":\"b1d316b159d151b7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/flipAttempts.js\":\"8ed1c7a2d22c39c3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/pages.js\":\"76550be933c2af64\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/preflight.js\":\"d5f847c67cf7a378\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/reseal.js\":\"3f9fe2a3d3282de7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runConversion.js\":\"fd78656bce145455\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/runLock.js\":\"8a943959295f7451\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealing.js\":\"72c4dba4249be62a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/sealingStage.js\":\"2cbc5f6400e5e564\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/stage.js\":\"d1d18f63c87a58c9\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/conversion/verifyReseal.js\":\"6ac78d7e29c09a6c\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aad.js\":\"86846e2c67539eb4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/aead.js\":\"1da1a2a1ed30e908\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base32.js\":\"a2468004f08b6169\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/base64url.js\":\"89722d9964658db8\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/binaryEnvelope.js\":\"4d142920092a83ad\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/byteAead.js\":\"009cdfc630dbac47\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/canary.js\":\"52362b75286c8cd3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentHash.js\":\"a6ba74527c4d443f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/contentKey.js\":\"fd3e6d8a38e78a55\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/derivedIdNamespace.js\":\"f18acd24fc7d73b3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/envelope.js\":\"84b73349d38dacb3\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/hex.js\":\"d0c3355e9b8a89b7\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/sha256Hex.js\":\"7d81c55a189ad1d6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/crypto/workspaceKey.js\":\"27371976f964ca79\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/conversionState.js\":\"ba04a286d65844b4\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5287e1cc2e6aa69f\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/pastedKey.js\":\"7683046b2897fb8a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9c148199101a9f5a\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ab422a41c80734c6\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/keyStore.js\":\"f1f4ee7cca5a4726\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/mintWorkspaceKey.js\":\"c0c9a95ae89b6472\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/modePin.js\":\"f4bf06794366134d\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/openWorkspaceKeys.js\":\"2daf1f796eaa848e\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolveWorkspaceEntry.js\":\"5a4c3bf50ee2ce67\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/resolver.js\":\"23f8d0d3285ff195\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/keys/workspaceAccess.js\":\"6a4b8f248d9528df\",\"/knowledge-medium/pr-preview/pr-1860/src/sync/transform.js\":\"02e699cc2b734533\",\"/knowledge-medium/pr-preview/pr-1860/src/themeBootDefaults.js\":\"5db23f2fb4ce8c1f\",\"/knowledge-medium/pr-preview/pr-1860/src/types.js\":\"223ab76178ca7f19\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/ClientLocalSettings.js\":\"dd52799a7920feac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/abortableSleep.js\":\"488c58646f2ad909\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/array.js\":\"c88ee8338c464c39\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/backlinkAutocomplete.js\":\"4b74dbcdf18550e9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockCrumbs.js\":\"fc7195cb19e3f503\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/blockrefAutocomplete.js\":\"12a3cfab121ba625\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/cadencedIdleJob.js\":\"c615620e240d3b79\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/callbackSet.js\":\"944ef4cbc475837d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/clientId.js\":\"a9d342b713431b4b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirror.js\":\"a134d68ca2c29ee3\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/codemirrorCompletion.js\":\"492503e246eac98b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/copy.js\":\"831370779d63bfa4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dailyPage.js\":\"d6a43919b8dc60e4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensics.js\":\"e3e915ac97cec7dc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dbForensicsHooks.js\":\"2aa4891d607054cb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/deleteBlockThroughUi.js\":\"897084edcbe9a795\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dialogs.js\":\"93bb00c384b843c1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/dom.js\":\"5859c3feb64dc658\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/downloadBlob.js\":\"5dfe4eda26ebb6d1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/exportSqliteDb.js\":\"971cc0fa9639689b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fileSystemAccess.js\":\"7e70f4ab6d02da81\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/flipSlide.js\":\"7fcfc804cb29cbba\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fnv1a.js\":\"a11cf5b4cdd209d2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/formatBytes.js\":\"f33a05a945ab146a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/fuzzyRank.js\":\"7b45bc28d5016c7e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idbKeyedStore.js\":\"c32437426f7da293\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/idleCallbackPolyfill.js\":\"c3430640e15488ea\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardAwareScroll.js\":\"34de796dc5c5374d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/keyboardViewport.js\":\"1cf388126fa1b5c1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/lastWorkspace.js\":\"89aa0f551d9b34bb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutColumns.js\":\"1bfe0f422b2142cc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionDom.js\":\"86f997de68f1517b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/layoutSessionId.js\":\"b5d64c9b494f43d8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkClickGestures.js\":\"bc9eb2090636c0fd\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/linkTargetAutocomplete.js\":\"af2935a22524cbcb\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbCorruption.js\":\"3058e570b631d1c2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/localDbRecovery.js\":\"3d94938420613661\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/markdownParser.js\":\"1cb6a130496d32c6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/memoize.js\":\"d32253aaeb0c6c2b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameFieldCommit.js\":\"b34b9d78ea138d22\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/nameList.js\":\"6d20818fb64d070a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/navigation.js\":\"f84dfe9bcaf4326b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/omnilinerNamespace.js\":\"2bbe745228fa122a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/opfsPageScan.js\":\"e3584ceced1f4dd0\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelClearance.js\":\"b769b1634a2a284d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelHistory.js\":\"3ac5fc1c6cab8556\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLanes.js\":\"4a46438b7dee7d44\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelLayoutProjection.js\":\"ccee2ed623893b7c\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelScrollAnchor.js\":\"6cab20a2518e7ed4\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/panelUrlFlags.js\":\"7969c6e04ab393e9\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/platform.js\":\"1434009bad24b03a\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/pluralize.js\":\"45b137df4e8c703e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyCreation.js\":\"30b4bbb155becb8d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyNavigation.js\":\"5e2c3d41c38555c6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/propertyValueContext.js\":\"9d635af0a3f9fb11\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/react.js\":\"69de7f31d31f9a13\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeDate.js\":\"405f80893da3783e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/relativeTime.js\":\"b7279f3d83e76662\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/renderScope.js\":\"5239dccb6b4ce50d\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/resolvedThenable.js\":\"598c9ec3babecdb1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/routing.js\":\"753c9e02849ea8ac\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/safeMode.js\":\"971a9b1f829e2333\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/scheduleIdle.js\":\"3aa8417f1554bed1\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/screenWakeLock.js\":\"2560961b0ccfd6e8\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/selection.js\":\"bc488e4b78dcb355\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/softKeyboardGrab.js\":\"be8af80c36908304\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/startupTimeline.js\":\"25a80641072b897e\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/state.js\":\"04f2457e4770574b\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/string.js\":\"62e809a6ce3627c2\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/surfaceZoom.js\":\"ca46d62bbc85f1a5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/time.js\":\"8ee39a92ac92dedc\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toast.js\":\"5655083444a70326\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/toggleStore.js\":\"b4fb6923fea678fe\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/untilStopped.js\":\"1801dcb84cecae53\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/userActivity.js\":\"e573625f717e5a73\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewTransition.js\":\"140d90eebbd67195\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/viewport.js\":\"6bc9f89776beef05\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/webLock.js\":\"00075785c88230a5\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceRecovery.js\":\"41a1331313e33046\",\"/knowledge-medium/pr-preview/pr-1860/src/utils/workspaceSnapshotStore.js\":\"2779ed1865874413\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-compiler-runtime.js\":\"31d419eb7eb3cf33\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-client.js\":\"869041b2ab95942b\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server-edge.js\":\"09665d4ff3debbcd\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-server.js\":\"777c5c513279bab8\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static-edge.js\":\"dbd3788945584362\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-static.js\":\"c12ede4611716226\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom-test-utils.js\":\"b8bf8a5a16300e9f\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-dom.js\":\"c055fc976a0c5963\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react-jsx-runtime.js\":\"08117e6161443775\",\"/knowledge-medium/pr-preview/pr-1860/src/vendor/react.js\":\"4b788e5c6ef8ae67\",\"/knowledge-medium/pr-preview/pr-1860/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1860/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
