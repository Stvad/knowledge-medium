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
		buildId: "463ae178ba2d-95e96282",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"ccc1c111e621a1fe\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"ccc1c111e621a1fe\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-nho46I3L.js\":\"f29013adcd72eb66\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"fba8491bf009d8b1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-CT47eBoo.js\":\"9492a60ed6e750c3\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-D6OGDXmE.js\":\"66018eeba54b9df1\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-BAzdMFED.js\":\"98320be6bbffdd1b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-DHRbx7x3.js\":\"2b638481c3b7a807\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-DYXylEVE.js\":\"5e72e6dac3136cce\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-DwKmRNpD.js\":\"4db670158ae1261b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-BvY1_Ne_.js\":\"95c9581e8c44e600\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-CzZCdT97.js\":\"a3e6a30b7adac043\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-DNaEQZYn.js\":\"f56fc62d92753312\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-B1amVQ6E.js\":\"ca1fa0ed8c453419\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BcWD7Y4p.js\":\"983ed8b892738a78\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-C6oCqEvN.js\":\"788f028f9915a1f3\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-CUk6Nehx.js\":\"33450e2236788750\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DReZKaLQ.js\":\"fe053d7b3066f3cc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DSNuVEuS.js\":\"c176f6cacdb2452e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-CVan-EB7.js\":\"7f5a02601ccfcb56\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-EUNJByui.js\":\"535bf114df848283\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-CZzNW9eA.js\":\"d1932dff0d711e75\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-h7osGuQB.js\":\"984133aed86aa74a\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-wmAjpphE.js\":\"f5d6c167e934923a\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-B2TaGygn.js\":\"2b31de30878f2bd0\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-BK-sDjsU.js\":\"2b74dcb9ac14e718\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-Dv9BFlxB.js\":\"425b0b149d400c89\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"14ebbdf2a3bef995\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"259456d44104c416\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"3b14cd26b8b44709\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"f84a547713185fef\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"80fe1809437d0455\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"606e263949364e52\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"8e1878a97d0b51d4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"be4c09460450ff2b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"437a1081f2ba4bb0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"00e8b020b6f065e1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"2b04409a6aef510f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"8ce520e8589d9ab3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"0f4fbc7c22049c7c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"2d5c696ebe3c6c36\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"8bf60f382db774d1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"9ce588742053b4ad\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"27359ae7083f2ff7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"41b07bad2dd270c9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"08e1a2bed073340e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"f1200b74e0fc8a49\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"24d616828e165199\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"d03b6cc2fb886538\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"87d6db32d22d8764\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"495f29b76fc23ac3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"f3013ae9999cb364\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"3868d35479834ae5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"0506fd54486f9976\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"419639fbc8500237\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"1a8a8a7903df53c3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"22fad6d9bc62b663\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"183661b3524fe244\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"4cacd8fa2f66a6f9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"d6a84540a92c6ea5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"e2347336871d9e88\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"70f5f6f01406a5bd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"5b5ea4d2f2be5bb8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"ec3b672e8526a695\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"4d2bcc367f18533e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"67aefdad33f7143a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"83807f7952e52ec9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"46cdb5c9b0d600b8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"919ab0f90ecb8d99\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a0a78ef511027d67\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"03bcf02eee5e692e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"9556655afff7e198\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"c9e74f3cedf0b34f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"165adabf25925b1b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"28dcd85e5c40e719\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"8f2a4d3cdf709f85\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"503700a99024e27c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"0733fd32e5b865e1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"0902941e84b54ac8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"24c80c793a02a9af\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"b66a42b0d681674c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"1c29d20348db1464\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"e605f78d643bf56a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"420a3623310c1102\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"22243809f419e714\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"6e13ae487811a517\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"be8eba428284b0a8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"a64a0426beccd858\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a587af7d03129a87\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"6d6842f16fe0d2e2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"8f351e386113e5a8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"88cb4bbe1fef4209\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"458c8de04186f4cb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"b5e9ffb70395b7a2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"71462d107f001dde\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"29c245c1b85f07a1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"28687da591aa5593\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"4298f4ec7d08cbc8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"8d95431b60e30fe0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"687a2e0de3f019d9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"55da9c30746389f4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"3265aa12cd065a86\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"48453466f0232fd2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"3acc555420e615bc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"4b6488f8201192ad\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"a33d99fddbac5a76\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"c3beb1b99dc61de9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"88944d985c8817bd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"a8e55eeeed140890\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"4f555a4e8244836a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"a4f9f73e5733f9f1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"686ede1c748bedb4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"944ff7a796767434\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"1f3686dd837fa65f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"0be6ffd07743b5a8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"2dae73713e5e0e7a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"50b6065f48e418c7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"92e2297b583fa6f1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"a541864d184acc4c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"54fe3dc13a4a4254\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"9c03cf52a12d49fb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"90fe9fc072ce66be\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"6296878cfbd68e85\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"1ea264572598ab17\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"27cb8b09a68a1c08\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"c4e3798774525616\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"1ccd6705d0bf4da3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"4961f96462faf6fc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"f231fe0eaae9c3c0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"820ed3058717b314\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"ef5b427c548f5391\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"91a48a9cf03a70a3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"e0cd7837c9cf174f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"650d3a048093a5d5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"08d170282430379c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"53b79876caa0073e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"e72334601da456a6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"22759b68c244a5e6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"9dc8aa13800c332e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"9b1bd6a29bb99a9b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"289d57aa3c448468\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"37a1bb6b39637afe\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"7e21558038b80b57\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"cfcff53cd7aeebc2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"80604b9cb4165dc8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"ef1b50669f5385b5\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"6b8ef19166d7e40c\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"3260f85fe73dd648\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"6cc1477e33a8048b\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"2658771c4a998820\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"2b0f46546024c2ad\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"43568939c52e2e5c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"4ecbf744c9231b9f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"e96f25a8896b09c8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"67a7ec117e051d04\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"de2ba0c32acad400\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"8edf74651923cdb2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"5f14c8b071523a6c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"50e753e66fcc0515\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"05a316fe3dbc8307\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"95e25a75738ed2fa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"236880fa64f21c7a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"4191308dcb430c95\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"b71ceceec8e0107d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"03eda2dffd7aeb67\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"167674564f0de8e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"8f5119070aceab00\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"95e25a75738ed2fa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"95e25a75738ed2fa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"761077385dc365ed\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"94ef849e0d9019e9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"fb4e67a5b42f1559\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"6537e52b21973ded\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"8ec53e149fd3e661\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"eb095a1b51c0c4f0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"5ef07434665afd45\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"dde3fd51b8814727\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"46041ce28b7d4922\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"4c7e113a02971410\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"1128b569364528f8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"705ac62633aa3457\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"967089f04c7d8f34\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"3459e12bca09f6b7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"a038efb681ddd9a3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"a7398d82c073bb7b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"9dd5a6161f1789f0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"502918033faf2302\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"462a675c9daae028\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"1551289af9e49c4b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"f49ecb2089c2283b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"f420a2f4840204dc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"f13c76f72ef859c6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"94d1f8c05d9990ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"9f298caae9ab17eb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"80e6e3cb450eb9ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"a39bcab3f7beef51\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"2819529fd1979fab\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"94a0bf4c462b56f0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"143dc7e1717e26b6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"55f849dcd64a47b3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"c3308138fdd8ea0f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"60c87f932fd9bc80\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"aed1411f8d6f36a1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"62731dbc53998784\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"ac16f3719d1d7c54\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"278f65f0c90c45f5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"8fcb5b9ba2a7a8b5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"33f36230cbaeb701\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"510cc14746b3e35a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"c46d1276e5a7d767\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"c9021f61ed81c4cb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"46fe538c4376f906\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"a898e63a6f5a35c8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"fee9bb5b56485616\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"d0eaa1ed6932c7d1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"5103e8c45744a689\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"e01929717c2a61b5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"cbd19e3a2e81b8d0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"7ce780a262f22011\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"dfa6284c54fac875\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"fc718e93756136e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"5bc2ba48665bca41\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"f2a2790565a1a75d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"604c46ec2707f451\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"6904bc6b5209e8ce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"8a0f89fd10bf3ff2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"f761b73b7ab7f435\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ceb3db113500e221\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"d313b2aa4d1ca5d7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"47541082b75b7c30\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"28b04ee1288a287a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"d55029abaaf45810\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"8c1defdcff9394bc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"ce0f388d808ba061\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"7a65aaac96caba0b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"0c056ee04854456d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"787c9f6f00f7dd9f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"3e540ae522b5ada4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"e2c54d388375be90\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"21f477ab00400b34\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"5f098c4b4683e3fb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"3111e38f5938640b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"6e8c0ea8213fdc8a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"368759d835a6fbf3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"d836887621bc5e66\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"7fb15c068668d42e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"1281ced0622ac008\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"e062517ce800d080\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"8c9d0802af1303ce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"172301d9232a3681\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"e67b15d7914f3cc9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"be71dd324b7f722e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"965b5ebad081c9f4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"d7d49f5cb538219a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"a8387c1491680810\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"09a5643f7618d864\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"bcbb87a68bcb2049\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"f2c2517ee2b255d8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"5da40fe601315025\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"fdfe9ad97e5e97b1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"56830e378dfa6918\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"0fec53ace2be15c5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"a4bf08f3a0901abe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"60b9c8e6730fdfb3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"15097c8a9cab51df\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"0e9cff863eefc8a7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"9fdb19a60e37b05e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"ac86e8b2d8e6e1b4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"27e8e039ed88464d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"ae2be89b4d884676\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"ce2d775f960604ff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"4e03a94e54a244b3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"a5e7c6fe3fd9471e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"f4097b9319011e76\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"070bee12ce9ce83e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"4ed6d01be4596d23\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"1e356287197b5bc1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"187bba11db713fe0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"d8013038d367189d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"18a92f361563206a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"beb60d6e2f16ef13\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"c2c1358dac17b655\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"375f38063fbb07fb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"e4e05cd33883d594\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"c84b56fdf06b1b13\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"0a4e44af27a25cb4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"f345b3b06274f387\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"8ecb7d87c51c10df\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"19fc38bb6a0724e8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"6a002a2dba4b0474\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"503b0e484e4b5df5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"0c0e86f8e5d23960\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"3bb96e8deac06528\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"f1ed9ecf5d3bb3a0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"28ba4b268373c2a1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"9af481d8d1089b86\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"1dbe2e8085c6a26d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"d2203472d206c1c2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"5a0f681da75a4aa4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"d9d013131d7713d7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"c827025ded31ebb3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"f95001b3a21c69bf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"e190fcdcc001ebbd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"5c9faf7b54be2c0a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"11201fa0d1ba6551\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"7575bfbfeaed17b2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"06a09ffb0e382258\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"32326091b3d3a3b4\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"8afb912df093269f\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"a2ee727bac980a78\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"5775f607bf612c8a\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"6e26f2eb53cc5602\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"ba393612976feca6\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"74350edbefb2e898\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"c517dc59798dfccb\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"8af736a6291f55b5\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"88f9020651950fdc\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"1fd7079418fae181\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"0979d441b29ba0e9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"035f5d19893e5b20\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"16d57ff16a8bf362\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"951bd30925113f15\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"1afa1538c049b97f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"cfe278663cccae8e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"df8c77fb104e40a4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"a71364ce5c4c9ad6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"f87ba6fd7ed73171\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"6785a708fbea3f96\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"a2ef90ffe2c255d4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"062b3f428b16680f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"75891814a5c907f9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"dde3fd5386b6e6b8\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"691787d046c34794\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"9981737c8b211f71\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"5b80e26d8dfdb16d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"7e944c494127b0b5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"3fd2d6e46f378dc7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"0f6e0745933506b9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"5fdea18f4e0be3bf\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"cd2dd016e69b10ce\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"6788a4502784ca1e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"86dc34976992b64b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"7567078afa212f9f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"9f1feeaaa2c8eafa\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"fdadc9d650e3c514\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"f0600622f1f6f5b3\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"7acfe303da27ac88\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"1d2e18fd7e8e850f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"bdf9af997110800d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"87379b64ea394ec2\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"ceb2870fca7622aa\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"835e88b9a4cf8b74\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"a310e10fe419cb45\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"824f517d16a6d73c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"ff8bdbf89243958c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"a6976a4e9bc938e2\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"4f868086937dddc4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"251222c3661d20f4\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"b98985a8fbe44a8d\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"c2515bc837da0c3c\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"c2191f7280c0681a\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"b81d1f8860ffcd74\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"8988683a353ae102\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"502ebab368fe19e0\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"69980afa0891b9a1\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"0315aafa53061567\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"232c96a22627e4c7\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"438cbdf0c43f0870\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"d747c26195c5d500\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"5eab32e0e614835e\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"5cd67909aeb4d6c6\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"622e490d6e33f5cb\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"72e4dbe2140ce976\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"675e631e40a37a8b\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"1969becb8b7d39ab\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"a904414127554534\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"688fc0ad412579e3\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"ec073491764cfcab\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"5e40ccc5efd90bef\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"3566f67083160ce0\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"56d7359ea268a538\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"278c0457f16f3136\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"2490562e562770e9\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"b70878c827717e19\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"3a89949d4c966c3f\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"e09f8c9b8c9a97ee\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"f4a20a8e528dfeeb\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"1e23188c5bb95736\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"e641a7addf09c0ec\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"886b29edf3aa0dac\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"7535b8038b165027\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"e5628043dc9303c1\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"b3adec35d9a6c359\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"c9f16bd4c3a6b7a3\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"bc0699d4ba9e56ba\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"eba31e2c056ead72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"27ee36846fc9d7d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"c519c52acdb6af50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5c1b216f76a468c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"e405a0f8f6ad5fae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"d392b076ecbf8678\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6a17ba84cdd18630\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"bcb6974304092f03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8f7b2a7efc46474a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"d9349fe2e026b5d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2eb7dec698d86efb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"6f4c546aa575da44\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"27ae21826cdd8577\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0826dc490cd0479b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"2301cbab431c09fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"687ce1d4205da995\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"2049a852966c35d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"1866992da92cee97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"91df4c3ace91254e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"d14dafd94f9c13c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"60a350faf4e252fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"5b5e3097d913caf7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"edee0bbf2594b7f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5cea345f151430fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"62fe71953c6d0245\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"85a9c0190f7b22ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"01e2ec46394a95f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"f7c6b12fad942e1a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"91f3cbf6b5fade44\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"c516023f47c141a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"3237ce8fd32e8806\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"c2928a5fc618b3a5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"f7fc44a39357ce91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"042e7e21e69b2680\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"4574c6e8ea6e53a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"65717288ff64be6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"b4e48c7bc533e8a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"9d0d4b7b8df52cd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"a7de437f359c0057\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"301c1ee210ae4156\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"237d7c6ec249ea6d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"12fb05850f4f8047\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"6065621a8a83a56f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"99cef8640949d01e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"29e35edb30859840\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"0822c11548906d97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"8434a1e48113a51a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"6d61a65370d10b8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"8cbba16f81bda8cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"a367759ca95528dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"dd935c18e2216c7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"1dcd1be4532e4efd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"617ce30d445555ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"20661ce5bbc581e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"5207773398c2540d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"b3b3057f571118fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"65d82c98cafd15c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"5b51afe09d7c2cfa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"3707637e89f534a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"96f21c6a595979ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"f82f6be5671ff521\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"3f58879a2f9a3fcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"8a3ba13dfd8680e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"855849c17eab2f3e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"36365c71d9a80d25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"43de38223d7f8200\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"428b8445da965d30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"35275648d754a6b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"4af9bb27e8c8b5ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"14f80fcc91f292df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"dd5866c0a7fc6d2b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"6b5cd2933a5bdd7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"92f9300eeb34393a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"620605c29790a554\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"a3483705413032da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"c308d55c58f44b42\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"e8de5584db810d9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"41387b8a0bb8cbbe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"8f80c22c16ca7c79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"fb656879b3450d8b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"89f8491b8b183f5b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"c5769cd4a970c9c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"9b999427507ced26\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"9032e7dbcad33e38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"b77d5adb83567f48\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"3132c17a5d59b55b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"fb8c409e761b1edb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"af523d4b49e8ea61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"639288b04adc7d37\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"b8ef9ee7538f38a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"cb12d8036405aaed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"bdb3e203e734e665\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"ff623106a7e9c007\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"122820d41042f814\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"2caff2aaeffe967a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"0c484a6cb60b0bf9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"cb9599a71a7843f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"faf45464c47f42af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"316f54c128f98c5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"e7059c49b1480ec6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"051712eef495af70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"52215c52bb489f99\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"f536186846dff7f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"31f7fccfa70b735c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"5fb6aa640ca39b95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"51e7bf7db72a4aba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"4e3a04ac0018de03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c91aa9cd8d32c18f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"7b3799e171638b5e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"b4216fb825aaee2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"03710ea5003e358f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"89c81840e3ba2644\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"10eeb5c8bb706d68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"65206baaab8ab23f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"9a767b594b8b71c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"997b4685c403ef58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"542b29a8247078c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"e2a3688bf86c8b36\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"2e89b291d4d72bc0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"f3784fa27ecaa263\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"4fee1226ed289546\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"9fdfb44cf8c7c68b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"746b2caa89e9e3f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"52c9e64bb653af86\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"ffb2604b90e300c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"0b782b63f452bfab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"086ea1994c4fdbf7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"2d16871dc8ae40c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"f8917f2bf5c9403e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"691ae2c57738fe1f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"572797996549f6ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"b3f21361df588ba4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"7767fbf1afa1019d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"9a4a528c0d1db210\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"36a8aa9150062346\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"5c9d413d90d91bc5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"eae16a7b53121064\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"b58315f8d8fd0a46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"249f3dd2ec707598\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"768da363edc23312\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cc9bba0f95449039\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7d590a889f0ac52e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"e93b45489c8bfa4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"cf7ac1dcfc8d7285\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"cd8147628a8de515\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"f62ddd5c4284fc39\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a70a42257c1092a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"646c456d48eb247e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"6d6e8fd124c9d100\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"796031f3d088b50c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"2aacc23fd48fa585\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"76c80d36f163de5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"650ef0ac682e11bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"8a5314f7f2913fd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"be744ee483109487\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a20d853220db50bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"c514a4defbbe8e61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"b0a8c7b58aac5dc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"54591bfe6accfa88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"ab58af37020fdde6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3afe04f934e1c3c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"2d8b30ac19d728b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"035892f43f4363a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"e8eeda9e3fbc4aef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"5c7bc6e8f3a76ae8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"85c18fa84e595a41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"9337a95c81d7a316\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"9888fb3a8c0108c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"5314fc3c2c791329\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b73990fcc74a748e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"33e3e79a7321264e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"822fbb92ea379975\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"c647bac28f01f7de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"858fc1f4d20fd799\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"6a94f562af438749\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"98f059f5aa93fc15\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"15733f169bd27278\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"0c31c761bdd8e0e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"5d63acd92d4853e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"ed2bbf2a1a787336\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"79d9a9fd8c1db096\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"a4dd43a91fba0ae8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"adfe1ea0ab4d7b7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1e1b70226b4c0a57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"06a8013a677f3750\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"336208ab5f81ecb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"c7c857dd2727abd7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"d15c3044673d2047\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"88a66a306ec17452\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"48395544e994abd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"f5ac695139b97f10\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e7e70ba0c317855e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a9557c027c8d2e03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8afb1c137090f87d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2624b0fe517bf7a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5d154619185b0dc1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"25a78f3d94187b03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9bc9048324bd85ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"4e54150ac23f91f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ab8ac4f240bda387\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"9e141c00143d06d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"4e4a612ca4e84177\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"86a17c71ea3af893\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"1c00d1cdb80a6278\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"6fd9b16dfe390e84\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"a23fc910f15d2b67\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"3fc79d729f17a8e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"d85464383aed0c72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"16923e3d80e28e49\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"727f8521d795c402\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"0fe87641667a43b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"031725142d7299fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"193c6c564c094b87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"7365804d4a6e6ef2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"0fd724e9e77810b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"a2509e4823c46bcc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"0cbc96f5c9f51bdf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"e090d857c610d0be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"61e7082c9acaba0d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"cb1d9bbbec614ced\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"90f3f955cff3ab6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"20cd12ec514d6ef4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"8ff6c03bcb7c5d04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"db390fcaa5afa953\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"579e264bf96e66bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"b28dfbb7d470e9c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8f36647a0aeea97c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"54b82fc441bf6b04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"1f3b3343c6d2fd4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f85b8a19b4ce6397\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b0bfa949df4e321a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"6972c2957ee60e6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"ae575583958f8ffe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2ebcd6f8b759a483\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"ee916edb7125610c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"3c45f0b03b5c370d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"da34ef5ba9569954\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"fbc8b990ae239e86\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"63f6ffe086fab9ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"0a165ccb168bcf0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"e7321a1f669b7418\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"eb37401b332c2734\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"88c3fa83e7dc6b88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"5be6b86d0130db80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"1cd3b9ebbd36f4cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"863073e2b86d4f85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"69887e6e289f40ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1305d2ed262abd4e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"3da86e02c44c276c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"7ffff95d035019c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"612ebec216426dca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"36f5cfe961befd5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"4c60e17406fbff8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"10a782fbd97e2832\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"6170d3075aad9d5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"1ae1a01e4df08b5e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"8c3c1703a57404b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"0717fbc12e1bcd03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"a1ebda861484723d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e90128f50835a0e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b1df7fe151a811c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"b2fb44607df6dbfc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"2f2d04b36b1ad005\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"d7c6c37fd582fc9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"c3b4ff6c162ebf09\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"c7550630a9ade90d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"29d5566bf66918ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f6cfe81ca9625ebc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"c9bdcfe11e23d648\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"165f88e695713f1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"f191e5cafd728c83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"2fdf6711d8565c82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"4022f3ae0cec43ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"464e3aeff0e942da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"cad552a2b6a00939\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"01b06e057ad5d8e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"bfc8e01b306a478f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"0ac59b064b091a90\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"065c7f5a22751da0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"9739e3b4646d1cb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"c7cb5c950c6026ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"c81333b09eb4f9ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"2277bbd7b41a985f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"c71c194e1f51b23f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"7b1ac90e6e1b6933\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"c9571bce4878bd1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"5469cd0c874ae8ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"9c3bcbac10ec7da6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"47247348bffc2e9e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"5d94a6f1c0ec500b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"4a1dff5f8faaa1f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"72fe4456e8d68475\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"49c0d1470f9a76e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"6de71fdb01582f1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"ba86b19a0282082f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d351e9a51564b6a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ea254c394db7b7f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"771d64d1b428b2e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"5cb56a1b761708ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"52431ef3d97f0042\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"7b7d1ba507cdd159\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"653d60b2e8bb0cd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"840e4823a4c06ea7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"121ba5db5abc6bf8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"7724f64b11142569\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"910170297602e19a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"cfdf549921e7d5bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"e6ff0154ffbf23f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"d22b418796716eb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"bc58a8e5dc6768eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"7b3c7831617d0b9a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"83ace5a6c6e7181e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"510fad31df6e7a69\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"e8d04104c9003c3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"e40e4b8eec2ac8bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"2cd63565a332aaf5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"375837818aa2b05b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"3338494ba6edb171\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"d3dc36ad32f69e82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"2d3cfa2f272092af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"193a54f9eb9a63ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"aaf1b1cc50ba22d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"856a5cc75302137a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"c9e29b20cd41d068\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"d6e37f259b0d7822\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"5222fa3a873110fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"bb2911bd2986bb95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"2b93005485ef26cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"269d1188005eb869\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"79b75b6fed13e1e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"07f563fb806e651b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"08a7bcd4a34bbf5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"236496f77c9d1880\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"bc53699b884c91cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"bd8960b451658eb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"828118dc44cea18b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e5b1309bb0ba1a2f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"defb5bc9d9c612f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"306077e0d2a11930\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"3c26b3dcd9a2abb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"0ad6c1209d8db03c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"b3ea4525910227f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"61c98b1488bbdb03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"fc92caeba38a07db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"4afe6faa19c1d3e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"50320fc694a27fc5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4800eff4011957e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"e92ae6606e320410\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"fdf074d4885e84b4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"6ae632cd05636062\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"a8d2572f3b6545bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"7e9997dbafcd4700\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"be87f4aed8b9e1ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"1ffd247a5dcf8e0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"6b7217bf1af7a1fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"e7d73b220159e429\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"9165a416ffbc888b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"81198081d69a9acb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"2a31baf9c4e1f9f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"684b33c6eb6e4171\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"9568869dada309f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"21af106b9b56c7bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"ae4dadb7f25fcb35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"e647c232bf79f162\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"751ebe9465a0c35a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"20090013382f4e0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4eb4bd51a111173a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f0eca44bfb672af0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"32d23f9efb201505\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"3fe8ad71a76912b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"bb4b1995d27b45fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"fcee76daa75702af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"7e0e8794ad6c5fc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"1b4b8b41a668428d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"eb5efc488673018d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bf3df70c7937ab7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"02a55f66dd69a9e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"0fb396e23ed45139\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"a521faf041676c4c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"d4c21e50d8337634\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"3f0e583bd611434b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"8cc574700af387e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"666b1bdbcfdd88de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"d25079b9eb7874f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"8db4df8547fc8ebb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"cb7249bf4dffda93\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"5c1c6d204be0ec7d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"a48d980928290f56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8541ffe788d5227e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1b628cc7b5862156\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"1a1fad07201a5353\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"633c85077f622285\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3cc3649af882a764\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8d4ab8505a5a3294\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5bf8939e05034429\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ac508b492642762f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"e2d88f828ea07432\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f2eab313238896f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2a5faa1653a204a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"e7b8e2d2b302fddc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"30ef2bd8a2c3ca4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"f53a4d70a940ca14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"16a51a87c53772b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"38d05409b58dda21\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"424c04dce891ca84\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"4f75eb60ccce648c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"3112d4442f01a29b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"bc9399ac2c2228a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"68b6953c1058be4c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"85076439a28e2a06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"fe70e52071e38f1c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"e1b704a598b4a089\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"c4322650918c7c30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f5f015fb326d1345\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"3176664066df8256\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"b0e9a7d487f66616\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"a3da27ead5d89dd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"69ac27db803d284e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"78b4fc285a456e8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"202da2610adf351c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"c57f7234d6db8ad7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"983687f8dc70fe18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"bdee020b455f1924\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"a8fc64cf7e18ff02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"de68509bbd5e7ec6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"4d44b41d557c0ff4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"d1500b4f03beb64a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"38e89a283c05d195\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"711dc6d9db96efe3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"3aa249ad5f471d4e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"d14083dcea0562d0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"104a16fefa0fad46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"bcf316160060f45a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"1d0b9e9d353d6e4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"95e8ccc199d47df5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"aa4d4100d9099985\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"da0dbea1902f59da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"9eb98fbc60a137f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"224007d2baf8ce28\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"27515bec5306ba35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"969456717653d721\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"d159eb8b975c4cfc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"e38ea3ea9361d82c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"61ab4eb0d0634e79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"ab5a0d34eeeee11d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"3e4ca5f54898652c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"efe60f7e1c9b21d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"df9323f35e0425cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"fcdf7c0a608d5190\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"c9b58af65b625122\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"b729cd5d2803088c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"0f2af141cbc49fc8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"a88289883d117769\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ab866a281e2e02c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"10db2c851ab27104\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"7228359d5299aca0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"995fef091e09d6d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"9d220fbad117da65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"e7543b6511c10e85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"3fdb9dd51592a793\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"adda2ee10ee77837\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2501bdb94d72fb8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"3f3d4592ed77d0cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"81d85c02d006c67a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"77c724a6a1e2ae30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"fa7580c1410802a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"b62b806ec20d0a97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"85dc78d0910110fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d91e2d59fe0a39f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e66385b6b7b476a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"02e5ed78957c7652\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7f738bbb9511b923\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b6c933ec5588e8ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"d26cf1ed6e75e79d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"a68f8b827c1b19eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"ab84732c5a223ed5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"1733a26dd747770f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"0b4c4c7f26742ac4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"41278dcb29e55452\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"f6b7461c5f6b7c45\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"420d4e2881fa61d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"98f7457b44d01428\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"98ef55e11431b91f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"5c16c12f0902077f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"9d8e758f36889595\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"d0ccd9253d41a7e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"47564bb1e90a0ea8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"cce65b4acdbea460\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"0bb193823411e676\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"07e3694191a66b61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"efecd3fc2ae87a49\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"1930f973a8a8d92b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"07b6755384ed9b40\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"567c0a03226e52be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"235b7651ab68ce8d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"e73d701bf5e24ecf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"17bc0bb1e920314a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"f6c49034c1164c47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"e544ad026f5f519b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"e9522f87afb1a21f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"9be0275b22659929\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"8564eab681e3830d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"d05f2791cd3de7cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"1c7f6b31e559f0b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"91c20fc5919d9d16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"1e5245dedc6f9963\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"8c264a9102a39ce4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"556fc39f269fd2d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"e74451d00bf764e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"e51d815750118a7d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"a9782683fcf9dd13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"1b35ddf585d8f784\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"aa111545a4786613\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"1feb6a343287960f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"353883433007d0e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"733ec6ec4277d5e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"66c246b0921d951c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"5661b903509b029a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"9eac6e94c1f745d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"de39bb2e1e2428a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1d3453684ac38f80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"f0d37ef43ff7194c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"2569d1c9e76b8a3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"e87b1755e3cecb77\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"3d91dddc8f487e9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"117a9667a714a130\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"cecf6a4cdc050687\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"a60f2249def8b02f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6c2543f9cf692ca0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"6da9e1a2428299f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c1c737cedb75a74e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7cd959a1ff307d97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"3360feb94c85d31b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"fe795e32e52b8212\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ee715f5f57f128c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"13f9c7cc42f37141\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"67d112d9b78c9917\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"b6c41dcb842376a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"ccfc3a097f2f5884\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"7af397d0280cfbf7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"35ef135c89f5defd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"2addc0d5af00bb70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"483649ef4dc44f69\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"33a5955f86cfa0d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"80560607ecdeef80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"ab16d60b1746a8be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"b108494c342a3194\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"86a5144c82f0485f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"cd8ee6e014a45dba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"2bb4ad2ea556e6ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"0b5821d73d01ad32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"7bdc3b795fffb0a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"9c343ea5674d78b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"d99e7eb5a2a12c51\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"e3fb279483b9b7ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"a6824e8c74c57709\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"b33ab4ff84ac234e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"53a2ad88f3a50f65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"11e7d57a4772d99a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"f02b86e153e48d0b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"497a1420e6cdabcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"722a613dbc0ab927\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"bd57498fa3f9e7f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0e8d1d94a1f32b69\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"f0476e3c278bd5de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"0bbe4c0db27ce83b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"b40740a7e14fcc32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"d9ea85607aab08d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"05008ade86a8de57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"b733aea60bc3141f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"aa7dec1090612323\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"739caa242a4c0db9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"01e447a2c329abf4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"a8ee756309b92095\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"cd700874edc8e6fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"1512c7079057e023\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"ba0e9f4898ec8010\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"350c3651547ba004\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"ce0c5a35412049fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"f4815e21b9352f02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"76de7888f2558cf3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"7a9200d855ecb598\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"a528a30d02f21284\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"681ea320e6108c2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"eb276222f610903c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"ea832e910daa0d9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"5436e875274dbbef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/navigation.js\":\"435de563bba3a6f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"82615b7d0cb24e8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"66428d9dce6f70a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"7a91e4fe4e3a67e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"5b624290a4fe4b63\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"9ccb178f763c4c55\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"c9af89260af7bdee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"23da859816d0df41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"b3c3d80973a1802e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"5596971e69574c79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"8ba733e339138d9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"b03575fa309a8902\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"7df89099d6dfe7f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"d4deb5b81619087c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"a5613520b0d11a97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"b11be5243f65b93b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"e788e26836af1f2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"d11d868ef0679ddd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"e077b993a3785265\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b49328f3d9622fdf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"0de2068f88f4bf0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"3cd8efdf603889be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"847b4dd04ff6e159\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"7c80b27cf1c82ca5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"0abf54cc8272c203\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"393d035961020874\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"7b999a7d9d8abe0b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"01862dfd61267867\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"cc0465b02a8d3346\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"fb1c0e811eb99034\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"cade86d93f62e4d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"9653cd19fd150a3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"796cafe0ad7b0a4c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"dad99145760b92a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"913117c045d335c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"60ecd8fb9e004329\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"40d4c44e8f44786f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"d5c8d1dca4b77fb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"970747cda2a18731\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"6587a9971de59826\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"a21425d55e555822\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"fe5d18244f7f93f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"2993cbdaa2fbe66f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"fcbf0622442115e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"958c9158d71314ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"7b9c09a3c53c5ca1\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"00e069f63a28044c\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"5e7dddc173faec21\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"9439ff35a688373c\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"6b5a0dc471d6f25b\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"3e54af5ba52bff31\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"b01e178409ca1532\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"1089cdf882f74ece\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"0c13601e8461ae22\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"11a7148888e11519\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"88c55d1dbc5be8f2\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"d9884bd2512227ad\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"a813ce529628fad3\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"43aa92166d495962\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"3c55522f1b42350a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"5a103586bf9ab6d5\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"d8905397e4e2fdb6\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"6a738b8cc90bbbcc\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"b168dfc3060c70ad\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"973f2e5a13569367\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"2b0dd2960766057d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"8cbd032cf1e67f2e\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"8587175ad6ad804d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"2b938d7babf52096\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"96f3c9947d3e6c13\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"693e751dad7be272\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"9141cc25bfef910b\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"3fa63e7446ffdcf5\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"627c0187f3cbfae8\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"07e67df244fb63ae\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"66f6333aa3189ff0\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"93e4f4eb417783a5\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"added70ff644420e\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"50803ea6031010d5\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"adb260efd4cc139e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"5ffb4cc9aa977486\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"38a7607d2219348a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"1f30eb0007fdf21f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"781ba65668659bdb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"af33f4ab297e0a7a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"58a72c4a366af242\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"c89fa0186249c640\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"b506fccd005aa292\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"414654dafb82fbbd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"5ad61163456ee146\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"370ccf6058628ac0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"a64ee9365a767156\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"5e9d995c4c378931\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"0075aefe99f17b27\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"5804376b6b9de153\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"83ea70190fa74209\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"b279f4af21011dbf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"853fe328b594071b\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"99832b3436ceb4b9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"1b1724a2db82f7c6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"23fef82842518ecc\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"4b33ef5eedf88630\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"0e845cdcda5e7329\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"caeefdea51dd73f8\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"aab8b5073783dd05\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"dae11d01c27e72f3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"e9b16ce58e9ed977\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"651486ed2ef88d24\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"8d98782a95cbf1e4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"cce1df934f38aafc\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"c7b82640cd1a427a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"9d125a61ca7e08eb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"75cbb086228cd735\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"1312ce4e4ee48ff5\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"8e9efa8cd92d1129\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"4a7bf3d1a17a2bc2\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"eb758aff0f3402a6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"01213d308f2b4908\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"1365578d4866dc2e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8780411a1f7a0bbd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"aa399868a8b3f9fe\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"6b77ba544be333b6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"40c4eb668c971d25\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"89fec3744b77611d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"bd4d258eaf559a64\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"bcc15f3eb91b1011\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"7ddccc9bac87d7a9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"6b726c7b0de52521\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"dd82e2c1615c152c\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"deeb1a7a68203c3b\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"82b752cdbd45b3c1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"73998151852f9a84\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"a79f2222d4e7237d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"98b8a552b7c0698e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"5d0f2d93b53e0fc5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"b1c4daa5ea64e715\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"5292594d5dfe2121\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"dcb8e0cd4815e84d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"2dded6c6dcfaa5c8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"1e32001597f03f2b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"be61ec4bfd34180b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"c41e9ff9f506f8e4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"00ea54515aa354d1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"6bd976eedce481bd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"08edfbd66a7977c7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"2e840f30fd99a564\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"57e143f9420e6ddf\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"86d02aa2f36edded\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"dc9db020170f85b4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"ab961ee52f74858f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"ec55f1f2006a5655\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"5b18925660f8877c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"8f35a567cc92e23a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"4214d673a6ac5893\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"e59e723ccee4b944\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"b80387ccc1964b69\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"608b2be6be8993e9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"ef616d1d89ad3a0f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"0d54d4f0487734cc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"0fe1b1581cda3613\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"d271f031ed665362\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"5235c424b956663f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"56e6211745c65d2e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"d8cefbb540eda12c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"ef427da3b0bd3965\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"0f8b5586f3b84aff\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"aada8d4794664964\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"4814f0925bef939c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"95c7bf6a33e06b2a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"a1bd7af306b15e2b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"bcdaa90ece086b87\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"e2d1a3d690f495ca\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"254f744ba76046d3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"16be3bf0fa0c82dd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"9c0fea92cc7e6df9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"0ec7f5f31375a7ff\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"5a20b0771cc5cd96\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"d6ae9b6d3b9709a9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"25a9153605f533b0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"d011c1a8f9292cf1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"8c2c1ec7f925f665\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"601122224effb283\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"18ff244ee0bb5c2c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"848ac51223e0b562\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"e214d57919065ffd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"5e4478d97cb1bdbd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"821e3de324aa7b9f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"cdf1e70089cdb9ec\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"554f505e43227c17\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"e343c190b68bcbad\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"45ebf5fc19925f02\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"0fa3e41ecf802e91\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"7942ad14f1a4aa96\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"1d1e7d510c9ff8f4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"49b7733496c253df\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"a9936fbca6fd9f1b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"698edb16b8a6099f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"8b32485c55c80f47\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"97946b5907fe44a1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"65937bda28605d7d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"64cae35c12b6b5ae\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"8520cc8472b6cd8e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"43485f37260553c9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"acc49799de3e22f9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"667e7bb0d6c7f222\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"74f5ad70fe22aecc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"e4082f4f736ee06f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"02c4e0cb9b5b270a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"396ebaff3522d8ec\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"34a74a4043d73356\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"a307e86dcf15a40c\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"fde3e3c9ebd93d30\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"f1fe00cf108aa571\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"68bf86af342df230\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"1fc4e2ac266f5e0d\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"b5cafa1c42240d19\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"ff41d0f872e2c7a8\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"8168cc85acbf0b63\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"70195c9b8c190c63\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"fd6d70050e0da748\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"3142fb77646bd7ba\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
