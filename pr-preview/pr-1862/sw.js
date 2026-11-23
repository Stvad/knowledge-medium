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
		buildId: "1130e5f7c9d7-3b78f6a1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"feb94a2bcda43f22\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"feb94a2bcda43f22\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-CPgSTpGW.js\":\"31a3738ff7467ff6\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"06079b2b4a48a87a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-BQtxfA7d.js\":\"cd52f59174277c44\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-D5wHkzGJ.js\":\"7a1c76337043db7b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-D7KsAEDU.js\":\"ec5010b5df9562c9\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-B_czV76I.js\":\"550998172aab693d\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-BmwjFI_K.js\":\"13b03c4a7ea41797\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-Cp1NO1tF.js\":\"32050c6fb0936ce2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-CcXiy66u.js\":\"159969ce3f83834c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-B3H4p96d.js\":\"83064801afc0f960\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-Db389cml.js\":\"5a1a0b32f3e24e10\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BBB7mUJb.js\":\"6c87e94b708d8091\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BluNwqyK.js\":\"5aac3ca4e69c751b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-C7Lu6ilW.js\":\"0d7c6adccb4e1269\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DTtgNNLi.js\":\"dd26dd3b1d95f2fb\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Dbn4Oyjo.js\":\"d4e1fc03d589d3d8\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Dw1cBCkI.js\":\"42e88591dfe0d2b4\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-HplpIAun.js\":\"c7d7452c74288ee3\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-h09es-zo.js\":\"85c39676ff33ac2b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-D6QULpKN.js\":\"96260c6414d3630f\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-BCFXgK06.js\":\"85c80de6d546da33\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-n7h0ex2v.js\":\"0c0f5530a58f50a2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-gLh_HPrB.js\":\"1f754893a2f78b00\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-Fh9rDh2-.js\":\"793fa070a0832d4d\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-BN8Z3K8y.js\":\"4bc6029bb1644b3c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"35ab5caf7c752c12\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"ac187a6c6177f90b\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"066b0044f726a475\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"138163bbb5a274d5\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"6a5e186760bed5ad\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"ce49e7b9adff9e9d\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"cce9548d1c93611c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"0671985b852b171c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"26bc5e960eb3365f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"158466b64f409b24\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"5151341b6f28fb76\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"d7c0ab43764a8585\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"b79c46aaca0fcc92\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"5b9e73db789c530e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"be9f76bfdcee1208\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"4d5aac5ced72b320\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"3b439cbe7d4e5249\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"1b02dcbc854bdbd7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"9686b9847bca24e7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"aebdf52894a66766\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"ca003445d5492809\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"67ed12eb8930c8f9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9cf29f24837368d9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bec8bacb064d79d6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"91983177a84436e6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"237f7e12471a4b26\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"4058ee5c7d404d4f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"84f67fabe82ef956\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"fa11461a84b9e2c2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"cc46fcb140448b8d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"0d26337dfc164dfa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"05bf39fa792fcb00\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"9faa0c4e171ea65d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"54a64591b8c84294\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"15b1e64d5c451d1d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"88dd90f0d9005414\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"a70dbedfb2b10f88\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"4f1ba3e9b72be657\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"7e47577ec6c6a065\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"af9a477544148ae5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"5e85df5fd6faa782\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"508cf43e451413b9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4cbdc550ec4b685c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"cdf3d0564d1547dd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"2a669178a70942c1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"bc7382e8bcbbaa1a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"ba3c7ae6db0cf9f9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"b708bcff16d203e2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"5eedc8bcb3e9c173\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"9bcbffcf9fe88e3f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"5e4e810c36d82729\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"11e676d2edc1138d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"97d88d79b2c27fe8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"eec260d915724f4b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"1d2deb8b1577b5ca\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"1c5439f788d79326\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"5ec807e485d1c408\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"83c56b8857e0a133\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"37b8e7c707646167\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6996a74060476c3f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"f2d522c0db9acf5d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"67d41b5d79490ca0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"3e55984918cffd4e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"9142eccf3dca38db\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"55534f14fca02679\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"1259893830f91714\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"af142eb5945757c0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c062064803ab6bf1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"fc5e43ca2fd8d064\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"31c61f079609ccb6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"79e97d0367a104ab\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"15cf1267bef79b0d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"bafceaa5f0de416a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"adda2e47276c4a84\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"98c97dfc7902b2c5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"7ee2223d6f520036\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"4f8d3b78ce7a58b1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"3d166e81b951edf9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"df6d05523344715c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"e06194894b0491f3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"19343572915cccff\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"289f8a5059366bcc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"1306eacb9f2c5f0f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"1030b60e7f8410dc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"4f3d2941fea8bc98\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"5c86a0c2a8e26fc9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"e96716b0598927cd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"ac88670698186f35\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"f3d0f2ad24796e59\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"fc1dc6570af5c371\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"2eafb082294f1bd5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"32831e3e525cb57d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"9558e960f7ba2858\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"487319879f31230e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"2a50d032279484fa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"fac28adb1e393207\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"886a103d20a551de\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"56e2dbf3e158e3f1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"55bd5a01e6014d1b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"0c6254ee28083d71\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"730b4a0b205179a9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"4152540628f004ff\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"9a8114a962eaeb08\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"e4f51599b69ec9a7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"2d196bed54a039bf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"59af1eae7cb066d1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"3302de99b1930e58\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"f87bc86960d1669d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"c8f9dab0f66a4bfe\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"4baaff3aceb3dd5b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c5304013cd6a147e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"b04c514abdc49b11\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"0d0014ac817db370\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"1589bcb1e6422b5e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"ea8b2a29c0ddf3a5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"1063fbdcb7bb3e46\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"e60381f595dc1dca\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"dac1acc1ce041019\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"f61d24ef962f90d3\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"6102ee69a42c1313\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"12e31f8f905d8f7b\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"8a11e7fd58defe8f\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"6c3c77256b7e97fe\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"3fec9333e010857d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"aebfe6c9ee154dc2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"7fcd43ae9bad295e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"8b5b0eb853a1b272\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"e1d6339390062635\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"b7889f015e1d2197\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"009c5c0ccdfd2e5d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"8a063ea57a09cabc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"816fd67213cb7ab1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"a87de9223c4eba68\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"13c26e7fdc7a5c6a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"bb17526d3445b1f7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"3c2e42127b53dcc6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"c1cdab3c2e2946c0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"a19a1f643a341401\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"45e8d32f4a7da117\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"a0998995b7d41cf8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"13c26e7fdc7a5c6a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"13c26e7fdc7a5c6a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"94b0082d09181c35\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"e9348a6331a1f261\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"dc222c58c256435b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"52b071a8df539412\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"7f28ff2c41dd0b79\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"d35f2bf98db0bfbc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"0b5fc91c0ca3112d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"590b84671af592a4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"aeda9b3a89ac5816\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"c64c4a5c960eaa54\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"c2172ea4a14a4147\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"9067615dfc4cd8d3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"3d704123bb91e63f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"8ed90323ae5d675f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"849905ae203b1d93\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"4003111273426021\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"53a007027577f8a8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"f1fb7864e88c93e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"6c7879f897987ebf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"c66df7fc18f05d4e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"bfbd4250da15591d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"6bc929cdfc2d72c4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"06c671e4b0b27cba\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"2c380304b86447a1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"fcc13ad7973a55bb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"7adf26a5ff71d8da\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"e209f165b45a5d49\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"71af5fb4692fdc6d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"1c2f29a02fa31141\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"92d58d4484a5b813\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"5cf07a1203422363\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"a6d0a36fa1a043df\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"c77c3c82afeda9c3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"ca13524c26abd4d2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"f821e9ace37c2dfc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"e10cd0a3a8eaa8bf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"d927d98592feb17c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"7f0f1c219e85db2a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"7ff09ab312e76859\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"cfe0082243314221\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"a69e284e21c204f7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"11080cb5ccbd9a96\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"daa5d728963d0d1d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"4ade59114e6df2e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"0b5024c45bcf3647\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"da2c286a691e52e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"19db256ebb31bb17\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"96a37d27edf7a591\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"a4ae5f34c98aa21c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"804a9922442de124\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"e16bbc7bd4ec3e5a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"2fe9887da63d9fd4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"cc1bdbc83e6422b8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"6a86e0676a618363\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"8953f6eded07c746\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"5b61d17a42be81e4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"b0b2ce2a87915cbf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"1abd56892668e46e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1a19e9ce89bfc181\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"2fa9bdebf3ea5ed0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"d84f338f76966d79\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"0fb2e67a3077ffa5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"259b25dbaf2bc4a5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"c8e8ad546de8a0fe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"b084b55718c2626b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"378b6eadc3dc8d42\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"5aa7eec25a46882a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"c72e1c1640e801fd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"a02651b21e1c4ece\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"336e5a1ce3f2455b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"b0af2c7537a4ef2d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"6d860f2054f03da0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"4503f3e179102857\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"7e3d0099a9702b2d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"043cc66447660e29\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"67041b7ab93665da\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"c268489cb16df44b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"342c27ece8865583\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"72012aad9775b671\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"e6677d4aca497a37\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"2b68866437881003\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"5f3a48e577d0e1a1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"eaf3908cec4f5571\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"7fd6ea73d4de8d26\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"6e2167006952ffb6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"16ab2761f32a6c0f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"cf646edbc105f06e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"bac148765d205a1e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"1cf8e0f9ec720166\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"47bc0831494c42bc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"de7c098912cbdb6b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"e8d22a98518044f3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"837a0fceb2162c82\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"5fac462ab2ed41f5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"4e1e76267f2c26fb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"1a777c4db63911ce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"8638f7c3f91ae0c0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"c7de4a2bb540b993\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"a74e4955f1b1e163\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"458877ed67da9b48\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"bfb42c299a17294e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"7a15959582f9f34e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"a60ddf81f5088b56\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"8228db66ae5e7f3c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"959de22644d23b4a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"2e493516891736c0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"f94a58dc28b310fb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"093bf14c8f52837c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"7231e2ebfb401dcd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"b012fd8aa30f6437\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"39137b1f46328720\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"6a3eae5f138acbb8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"7b1b28bd6376cb70\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"dde9c6503b3ee951\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"8993dfc55005111c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"499ccc0a5efde32b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"bba352261045a368\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"d34eeb6924916e5a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"7f8162fbf0359127\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"24dd4a72805a42b5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"161bba43bc5a7778\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"397dc5fbd5ff5177\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"c55b6251faea0a08\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"fc914b46c0467854\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"1843208e78be6329\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"5abf5494cffd8d7f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"3d925aed3b2d9e9c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"35ffcf3422d0c40e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"e80b0f90dbe13222\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"3649cadc3e395b90\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"1497b758134b3405\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"eca6e6a33a0c2e00\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"415dabb92bb9ecc0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"552e3e1dd8caf669\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"03e63afa8a5f5047\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"c8aa5ed16341cda9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"37b400a4f41b0114\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"ff15ca453cfe310d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"cbb8f6ab11a6c580\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"3d2979e536248d14\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"e1a1ec04af24ced0\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"c36c7f87ed60b6b8\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"dca32824121a75c2\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"4475ca9c15fb2560\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"e8dabb20aeabd207\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"60dd003b174e1406\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"c09672f22d151c51\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"51388c918d42184f\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"8c8876aae9091381\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"d8ef1b121868b714\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"201833c9713fd449\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"9500fdd805447a79\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"7f57efcbfee3f7fb\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"ca986fffedb23a3f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"27191715fabeff79\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"3671ae1f6f887be9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"b4ca5bd3f743660c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"5ee75a95852d4e46\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"a201e234e3826302\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"bdae61884553b29f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"dce843c3b1308a10\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"9b7b4edb9efd9d3a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"2c588663d8fcd991\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"8b16c5e8b2044cbf\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"b168b6b115f79999\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"cfd0cb145a1462c3\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"057099503adb11f0\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"33578750fddd79fe\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"894328168ba04328\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"cc9c2af186859855\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"3470330c427390ca\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"c377ff09588ed054\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"a99fd3c6a77d6c5f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"90b17fb113043ce6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"0122241bf632a282\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"e8cb79a54ec7598e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"7fff510a04fd98bb\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"fb6475c2fea8dcb7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"a9731a497c8a1d4b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"8fce1b9be7493959\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"032d8c64af7cce20\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"0f84c1b76011180e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"5ce219110f5de537\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"e8f1067d38ade5d9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"5e0f7203a3408fa3\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"ac0d830bc27bdc77\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"e986d5d12096de7f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"3e891fa2195f5029\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"5e0118fbff5991a3\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"c01797e2d4fe6cd6\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"dbb4d5b373c63b68\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"6d4c4b46cd39b15d\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"0b8982713c0489f2\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"ef07538dd69e435f\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"db4d9a703da66f0f\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"740733ee4eab501a\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"7cdf5fb26c45276f\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"1a7c051ac1bcca3d\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"228639b5e9464b0b\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"a68304a1c1775b14\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"8c718c2f972b1aa2\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"923b1257f859dc68\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"620bff040e3f888f\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"ee78b14a73e594fc\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"7bfd944a93b3986b\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"5b56b10f61180971\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"2a1716dad6084cc8\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"f52fd5fa8003d895\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"4e08df31e5a77057\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"5e6eab1f40357ed7\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"ceea47a48ceeb9db\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"a160ebba76f2afd0\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"bdd77a877ecbb213\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"cabdf2c706e8c77e\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"bc46d614370e7763\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"ec2492724c852e53\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"98b0b49a11becaa4\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"693a1eed9034dada\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"6f241fcc2e7992f0\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"fb1b1a0ac7f570be\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"52f285d7c613d807\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"30d9c8c7cf09e174\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"3ae313f74589036d\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"11ca955d88394713\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"5ec3acfe2251c0bf\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"a446f255995d99eb\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"efffe2f5bd5809d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"ec85de6029b12d8d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"5dce40b605578339\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bbaffcea9ca2db1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"fa21808805cca908\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"f7bc0262fc5ca0db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3c87de31126bbf8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"8e717997947fcc15\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"46de0e8f40b33d8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"e6cb93862eb4b46f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"839a376cb16ee938\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"06a33013a27fbb76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ef1e2a9cb8e1fc09\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9761db5a91c58f57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"5004b96324d25362\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cf67743d81aaf5b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"f1c8c9e742781297\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"96cc38495b53d295\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d8d5431813baa7a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"95158771d8fb5e7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"4f77cd6e833a731c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"9bce46dc53bf1895\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"e6acc7364a3d5f16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bcbaaec918beab51\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"d974c9fcd38d20d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"359fee452da1beeb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"998f8ae501312eee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"9ebb86dd7c59b15a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"a9b6f43b29a27880\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"9698611c192be91a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"9628814ec54d4d03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"7ded3efab40abfcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"7816700c9448a6d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"487a8ff39791364b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"fbf157e1e6850d9a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"fe4bcc0fe150d0f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"c5b086cfac96a76b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"ce1003fa53928727\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"b2b6d8c623a40911\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"f19d56a829e197a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"54d16fb96d9668bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"d9e8c052d175a3d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"38e97ec355de6ac0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"cf90de8c4e61e883\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a7e4d9c8f341e31c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"4cc886d63d5080e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"8dc49346abdeba28\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"8d2f868ce5346f1d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"4948f9a8fb25a5cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"9df531fc21f24cd9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"650e6d31ef556457\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"8a752ab5b13e2187\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"1ce26d9673424661\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"48f81b34a3c6ea3e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"ea8853356741ffa2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"e102fefe884bdc27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"61c05dc9722eab81\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"cae823f2c35e77b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"3c94c2156a876477\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"b391749105434c87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"f7385a0b1b85a949\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"d63337195a46a71d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"ad557700e87871b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"c2ee7d72671a3e50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"a28289597948ca50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"e19c6ab722151edc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"2de84168da7589e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"9ed27f2eb6cb29c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"fae600cfb0c5b9e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"9aa5c3956554ce04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"178edb93ce2aec36\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"7c97239657f67db3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"d01170edea3a9acc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"013ae85f9e627123\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"2395317ad84bb793\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"a9f44f0d35718aad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"2867ceb837093686\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"c791a020a4a72f14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"b6f4dd7257076c7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"acc4a2b091783d98\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"dcc09296528224b8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"116f07684381360c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"f71425918d835b3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"b0072b0f0d4e8e5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"35754d89d08848c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"ebe6ddfcf2daa3a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"39d1b2f4e600fa7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"7651fada97385d92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"c9980a98c4829ba9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"69fb296eb44ec443\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"624d73793ad4ea31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"0bd9136bc9a6412c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"56d91c8d57fd1122\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"da33d0efc8cdc9a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"751841b4e9e9d1f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"570e7a506f1b498c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"ff9be97260c9ad8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"12dacd4abe30c334\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"4b110280a613ee02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"39ee2ba1187ed519\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"0b1b391dfae53eaf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"baeb64777cb369d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"1eca4b840114a68d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"4cde7533da76cecc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"630cb172d57a928a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"38b09f2cc8bc7d17\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"8ed0e5d9299bd08d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"973201f22a7706b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"7bba870b498c783d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"db99c7997f09aca7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"18ade106b1fd2654\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"110f91d0f49843e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"7ff8138fc3d32072\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2371b7e43f76174c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"374e4f0f8bad2368\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"2f745636fbdece03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"1ab99f983bb8d6dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"3f6ea41c5f9add5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"795e3030ccc8ddb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"a8a5ca9269131f83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"cac40ef9dc9a83fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"10980f3964c35e72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"ac9aaea0cd0dcf38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"cb89f03fe5f41c5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"6cc1158e71d91a1c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"d6b18200be8ebe5b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"c45edb2cd8401deb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"d38cd53a9829dfa1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"45bef59767d4423f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"6c84a8004ec44c0b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"cce9f10b8edca2b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"13485d1cf3677621\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"b73e4dbc55a7948b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"2c5da52789019854\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"78596db3a5db95f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"524e0d1b485e3a66\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"aec1da49defa6985\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"8474f4059295c9ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"a4369e44d9b0a8cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"332cab8d33acf604\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4c5bf36075ab945b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5632c006be126205\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"aefd77cf30aabda3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"f24d9bacc4ddfddf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"59030652e4e1e41b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"c075a954290a7822\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a79b436f8cc81737\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"3a02c8b3c1fed592\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"929a14d9c8cafb02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"22a8c8f485e5ee5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"4f4ffab96910a47e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"45f62377c815a14f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"196df807c5b7f757\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"fc9cad7ffcdc0bdd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"c18dbc5e732ff5db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"958c94323c785c30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"b90f32e493f32790\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"829e496c705e5897\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1d97dff43700a3f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"714b75651d8ad89a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c25b07493d6938c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"3825ab7a2540b1ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"0fd9caff31369bd9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"8a9434444033a496\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"c2fc60cbea0615d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"861c4c9baa4d35e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"9dab669792f9cdf6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"cc12b73c086ef52a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"d810d7486e9bfb7f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"71b8280e7882444b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"d6079886a601fdbf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"a7d68605c7c7f5e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"798faeba800b277f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"e26c71eb4933f478\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"69022c00fe9b581d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"db7afcb95781a986\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"769cc2993f1d47a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"87691046f057a63c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"c848334d47842151\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"245c9c19def9d493\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"1173d927cd888d3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"5657b8c16ed75a94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"ddd1c3bdfc1fa8a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d5c3e4fd35c7f326\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"76daf7937add9b07\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"d540bdebbf0c9e5c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"71a4524d0f4e15f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"71ce899683c6a1c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"3dd33cc99880d3d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"42e5f45fa45dde4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"928eb10abacf3629\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0aa95499b64716fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"677e3f3467301dfb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"18da5d0dc247a527\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fa33e4110254c0ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2117a0e214455cfb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"816a88da21ff0850\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"70cb55236990918d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"dcb9cbc1c922c7c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b34618a9dcdc20f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"0cf50f41b172a406\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"3e21744af7ab7f9b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"3aad182f6a3c1bde\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"4036e1a47d40e7c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"16b50f6707266ff8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"22496bfd8ef9a714\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"ab4ef581c09a41ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"dddb0d68f768c59f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"5fa5a218331e53c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"d16e1a9f7750b6b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"f4ee1db8949611ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"6a31ae8808bbac72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"d3a9ae03b60bac81\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"a5c5daf74ee5fbbc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"2e7b7d0b6141fa92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"dbc1e2507568ffc5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"de8c069d46b5151d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"86fc6be6329b5828\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"094ee11a21eb39a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"7efdcea8f3b0c984\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"0bf10606a67595e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"367716be9b3502f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"de14c0d826409084\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"aacfed9b1bd600e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"e25732f2fa362877\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"2515b22aad5f68f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"67b214ffb5f3cacc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"87289847c2c1ad44\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"117288d2cd94e54f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6bb002bb6c92c04f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"502e2a62fdd9027c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"5d2d440a609d8d70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"31d00f7862899563\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"beca2114b95ac6fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"1c7e3912dc33a619\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"288a6f04970652ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"17b7399fc116d5e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"bf5803ac480f4eac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3723c787d24449c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"b2d9f7b737f2e3a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"8a62185de99e2dc3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"e59c2e2449dd5279\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"995ed21d773b0818\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"1d856195efc630c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"753474d98eddae40\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"6b4192c8646d2391\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3e79d4696f73ce18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a4a7b0cabc9a84a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"47773639f67eb236\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"e5f5b6ec5bfa986f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"b4a458a1d302fbb8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"0353362fbdb5a6dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"393502f9660d74d0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"788aa9bdbc6c5308\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"ea6779bfb1086f27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"57fc9d95380c5678\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"f5628bfce7c10171\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"9d314f2ec520e784\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"fe79fdc3d2ea8f26\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"be95cc369dcc6c79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"38d93b9a31060484\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"9ad2d3fca7ff0775\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"018e4041ceafe0a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"13093042ef710c92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"958a8ebd4a905727\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"ff544fdbe20af089\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"9a55771d319c6a14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"76c0625cb63256fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"e9498949185e20ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"30eaf200812d97c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"ab5f2b9aef437993\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"3f62faf21f57e9a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"d49af4e1c103ed2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"b405b73b712eae4d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"dba014f83a7ac282\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"28c155b73671ef16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"7e539b3c16993f29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"c6b9c5ce30d50cc9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"deb89062f502f664\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"1900d554f730c6eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"ac19d7c32cd5208e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"6a392b6251b1ba78\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"097a098d71096b95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"4e0885e95309ed00\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"5c86b0257e7f7c41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"ebb082615f169717\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"6b6931b2a3eba146\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"1011c9a7fb1865bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"02fd3991a3c4a36d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"f511cebb617611fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"880f22ba29143670\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"d7852a6d129d7923\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"db5ac64ffcd1ef9b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"78a4beeac0b39a47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"762a76854f18ae5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"892e8d8315bbb121\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ba969e85028d9af0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"4405ab348c1007cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"38566582b429b830\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"64f6fda501424027\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"a6852a7d08566612\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"0c96193d93e53fc9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"75657b980c9f8286\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"e919c3d881c42ae0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"9e71d1eba870a1cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"3cdda334dcade243\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"0f82ee9b36b02cd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"3001da67cf7c334d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"9d316e6066fe02bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"d1a549f5739c7441\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"8c38e5a721a3bbf6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"10a6450f0e03232b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"ea490f4a99ff1600\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"13ed33fe5c5635f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"d5a7a0f1cd1650d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"8d4d428ba7ab0113\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"21bbb476476a59ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"e607cfdefe614fb0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"cdd31024e16ca040\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"73c074330ac30a70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"0f4291b90db83fb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"2c080451c9a1a752\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"66d3278b1332bb77\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"43aaeb6b861f0b33\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"6b0d1113341fa84f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"33aeb35d2b798fed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"a886fb4d993cacdf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"d588448b14638a6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"1f8341ed641af78f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"23239c8e133ba729\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"d54d76b934db9a9a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"a1e3b7ba950f0fe2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"c09d3f5dc1d723ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"fe7ff5b65f298217\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6d909931102063fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1349875279be55ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"367e08875f54605a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"f5767a8112d9cd9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"cdbe52f2c2ce7127\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"20fc9a890a403d60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"5c61c530f26b385f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"d5eda181094f1aba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7d0b20b2c00fb95e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"e0d158b62b8072e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"d53243bc2fa0480d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a7982a1f53520b34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3683acfda232e0ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"dc7ac0806b5bce9e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"cf42193f7867aa9a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"81881ad26452b288\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"f63dd282389c1252\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"767b9d0a468c337f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"84ec36d38a912f61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"b697ba03fb5d32c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"fe9f5fe26216d444\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"2787a861ae89b50a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"82b871d0c209a01b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"2a67954192b4c02c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"ae0badb94ca2fd1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"6a567604f8baeba4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"239bb37b6d1dea08\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"a4de559d88b5b999\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"539a0484e0739647\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"44812ec1f5c9897f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"1a31f99d8ad1d73d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"1de90bc757f1f3d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"10cfe8c1b7c77e98\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"bb33cd3eadd56173\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"8988aadd701dec86\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"0060e05572a8122a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"e562f81c5e5c09cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"7f1c13148cf667e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"41ddc2c9473723a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"4e7999be09acf8bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"78bc99b0a699cf56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b0ab95b3360b7a71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"0652fa52f7ed1ede\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"596fb1e634e6da7d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"8785de533fc65785\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"e3427aba4d1ad3f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"6fe28e3ac9a9bfb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"19dc75fa5481b23c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"23127a8e3c98b034\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"06d1ed5eef51b91c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"efc25e11c12010dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"cecf8dd99ba333e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"050b0a74124687c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"540218923695f3f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5c1a3d414979d053\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d41a50b769679593\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"3c2f496bbe490d57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"4f1841fa110e77f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"15e7f19a139aac23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f160000afed6837a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bb7be62fbad15037\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8466c5a0657bb6df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"60b120ab4a0882e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9c1c00aa6dd2f78e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"89fba6eb821557cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"c68697506212263f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"f79a3e428740d9b4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"bc217b6532d889e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"cfaa6d3b1be70841\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"796eb6d00fbb76fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"83e05b58069891d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"c1292b0d42cbcdf0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"63e2ca2cb6e77687\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"79c503a4a004e242\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"cbb1ec00af9de1d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"148fd40722342d26\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"1d8a000518758150\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"9067afde337679ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"22d717a0535f6a05\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f4c8d2166ab689c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"7e0afe4d9756115d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"71e9b860ccb06e2f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"2e2dcd2b6326ae97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"ebae440fe06c6cb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"16f5716b8a9a7d14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"68eb660a9f208ad7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"1189f65f798f88c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"d75ce3d23765986f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"10ced543a6ac236e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"010f601b7e359abc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"9d5daf4e0cbcf9d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"f61bdf55d4c67d78\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"27752b38add65489\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"93befe6265910148\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"350fde9fdcd97ce8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"eab9443abf56ee7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"a6188b516d9cf5e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"9d8d019e1f61476b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"a565108617440d28\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"1085e57d8c6e31cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"8f3c2d51cffbdb87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"cf0af1fa954fe693\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"631b9508caf75d33\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"be71cabc29b8df70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"6a845f0b3083b1a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"e9ad00481be3bf95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"0293e8427974514e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"288d49a46982ff61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"92dbcb325392d839\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"7f55c3dbd8e0af91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"9d912bc54437e6d0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"9ba0e2424bea5770\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"af7c5102f66845f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"2fbe9805db8dc84c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"bf648f24638639f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"cd0b403bc36ad896\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"214bbbbf252170ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"19f35c031e4c5683\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"2e1b1fcb52aa80b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2c68fd232ce95186\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"243491781327340c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"74cae3a50c68d314\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"9a5fa4a73d12ffa8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"5bff2f090c049555\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"bbd84eefb4ceaa53\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"960ad1f149a0e622\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"61433792a74c6245\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"751fbca6449f4a82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"9152ba75bec67a6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"e96d9d3084716fa9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"edaa1496a20f4f70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f8967312d28a1cfd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"0a7b090d708957c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"88edcc48eacc7f81\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f8c9541f182d01ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5b1d2cd422ad22f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"15a9b6f90e8e8d6b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"287e3d94d121bdd9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c0ad269ee01d89d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"b323bd322da043f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"7e2ed5fad8f4437e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"9415873594c6bfc1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"996e92c57434bf88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"62d141bc732a1f58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"53d6331b05d9aeb4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"07bc970a12e90ab0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"a49fe4d323c3140e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"58688db3620dddcd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fb77b4c56c2e8845\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"87f7c5a0504d45be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"1f63e2c0032ec0d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"30cc461005a09b82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"1d3e106489365c98\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"6637c08068ee5bb7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"9668534e94de94eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"2508c2dc9befcd3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"e7bebc9eaeacdd6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"0436cc491610165f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"39c8fb341c67ec79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"a69edb2f2eafdef4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"11dd0382dd3d3ba2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"9417ee2e5687c340\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"b842df4e15f45c2f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"ae5efa8de7b15795\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"d9b66897e0518255\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"8bd69c0f7b944b18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"9117333466fefa3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"e547a669f01d265c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"999dbab14f347891\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"2b78ac88e0889b8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"455cf6c6a2420c7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"717fa44b7921ffcf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"fcda0fccb653781a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c56ad5330b484a8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"4255bad998934608\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"5c0e6d5167a406fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"5a53121aae63beae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"587a9db68dd3fa39\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"dea9a1d50579b2ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"80c3df45e285b9d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"4c237781fb42e1d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"167b630881e6831c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"888a4193cefb9df5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"c23d3a14f62749b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"72cc9fabfe1764c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"3d75569ccf14b26e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7309102becea1366\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"b529e62642bfa607\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"54991a3b62be4ccc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"c8d0f1b802e2e3cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"ab07507e64b7fdf3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7574230e80fb517c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"b46ecdb4736f81e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"4750dc23da11e62d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"11a8766535a877a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"bfb96cba8d3c4b91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"dc24bb8c15262428\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"31169bd74c59512c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"ffe54445f8fe18b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"3e5456b5b281f1fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5707044d611e52ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"c5f5d9977596d968\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"507743227e1762c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"c416a6827092f02a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"04539e063575662b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"9e47f7adb06aa56d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"5ea68dfdc8552d8b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"8277e8aa51f7a230\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"28a06cbcde80c742\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"55218673e85cb3b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"ce125a769e00633b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"aa43d8832e90a57f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"bfbb9a78a3f3496b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"faaec79674ac4e2d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"ba42406ced3b928e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"c7da41d0771f12bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"fb0caecef5deee2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"8b61bc386199842b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"8f27f2dfb492539d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"cc00e3463bd00269\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"e413ec027c12ce9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"9ef794f2c1b0cbd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"0809af54ac5527e0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d764421f034175f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"f356c4fb9375f714\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"995eac9d7d275b63\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"0c8f1ed2b1361030\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"3cd16345f3537934\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"59a395808aaceaa1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1242ea55baac94a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"4a096c3865153699\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"120e1ad6d63463ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"dda367123e973b24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"2719f249b57aedf1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d3ae703650f1bcf4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"9b9006dba6d5b831\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"4b2728aa39afa369\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"d819f936b62136c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"f1a14edec6e39f71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"316e0ed48095355b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"60d2a87698d906c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"d49292b90e2d7030\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"02b2246af9fc4913\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"d0d5a6b77613ff34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"e4bdd808d6d3db31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"e45394d4ecf24399\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"23e3244f275f2d29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"de9740cf6fe33da7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"6b8dc54a8874985d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"d55295ff94ecf98d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"f74f41816df19193\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"162b596e2014166c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"02a252c0ce57c53e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/navigation.js\":\"3f7f6088de037c32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"5d86e627f7dd5e7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"73d0a78f0b60d1a5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"f3989e61ef090ec6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"b0b1478c67c976b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"bc1dd2d95b2de1d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"076d2d80d6c26dd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"2d984decdcc90157\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"ec2d9db93b4e934c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"46f3493789eca0f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"9f6d7ac342d072fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"97f8ec9bea63c46f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"1dde745f60cbba1a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"212add135c581a2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"3e115ecac4d992fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"d692ad1e5f8eb840\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"e3a87aef3a0f5c50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"7ba7c58dca915809\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"81ebe20fd9c38e58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d18bc3383b786e2b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"b36460fcc16a0193\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"c329e473de2b6a71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"f60280f470e81aad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"27119f776de777f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"197dc89854d9e4df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"d58e40725046d3c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"bee630eb7002657a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"03b6fc5b47aa960e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"183d29906485fe81\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"a148348c3db7118b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"66013ea6d5524151\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"8adefd875b72d37b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"538732cd6da08c18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"49d5dcda6724a6be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"82c6ae11d9866cbb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"2d1624ae4a69c9a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"000d8760ed35d98f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"463d59aadee485b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"21edd22bc8a05d2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"decd6a49b966ac7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"3ef77aca0dad5749\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"e30e93cdfad8d4b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"9f42edd22db8a3d2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"c1dd8188a3ccd7db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"fdd2ca99f5d55862\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"301d4310e9bd7c3c\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"6a9bab6d7abbf9ca\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"6e089511771d3c7e\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"0dbf5658ce2ab3f3\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"5b8feb92ce0ae244\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"949c330e513e3bb6\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"95d5232996b17b6c\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"8248e1c77883e958\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"3421a84d1a17b053\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"ca3b30825c8d95b4\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"5aa65810f1838000\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"5b1fa80dc4a8042a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"fb2181e70c2e45e3\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"465b863a00aff659\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"b7f80cf2ee8ce8d6\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"512528027cf5b946\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"6d6d80cd82c97da2\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"dbefcc2652b76402\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"610960daa393b57b\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"c7a4ea1a292aa451\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"5a9642b312beb8f2\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"bb37d5432f483ff7\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"fdc33c4d97ee606f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"13a21b5af11e0231\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"43dbdd0f0be36a37\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"bdca741d46fba9d7\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"0ba6f7d7184e4a40\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"0b07688ffabb76e9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"9d5c09e1f9b6c8a3\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"5e1dee9ff947277c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"58055936f21a8732\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"495950af9e1fab0a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"79500f341e4a1571\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"f14eaf1a8b3c5e61\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"35b7721b94ed3a0d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"27cb9a333eb3d500\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"f025b7afa1b61166\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"18e0936a4ccdf494\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"3c786e78000726fc\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"6165c4054ef7d043\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"552c206f2762d815\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"28ded8e65b030cfa\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"c10661762b2f878c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"a7b67a885e4e353e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"e028745bcb237110\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"cb9ca45e65a7810a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"f9949a309ded4d9f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"d55b80866a8a570e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"61644c9d6565d9c4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"54f21b0ac98f3f80\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"3e8b4752350a98dd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"6b90cf8be4fec1cd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"18fc3ca8258dd4fe\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"e100716a2b670b0d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"aeac8302c5bbcd5e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"90d0597bcadbd6bf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"b7759f2c729bf7b6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"6166fdd9d621c589\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"ca20cb1df0c449b6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"c001b6345795d188\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"4b67245ef96fecd6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"239cf35cee19a771\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"52a12bffd2472e50\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"7c2058e4737fd60a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"8098c2ce7653c519\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"58ea411caa38fe38\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"54f46e6d96488e8b\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"5816654150cdcf95\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"e9fed3bd1b3f1c24\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"39ead0eb77917af1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"590448e5a63e01a1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"034fd92f2b2e4d11\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7a6d3599d3b6ce29\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"77a9c18760238c9c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5762bb6003501efe\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a0b62e830ad1fc26\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"bab06d21f0b06357\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"f01723749177a81f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"27c38ad6f1711ce4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"ced266dff0a72d0a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"5c8e8a96da9d1468\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"bf81b9905a7e9960\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"a0835ad138befaac\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"469594268bc020c3\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"ef6c6997d735141a\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"229c7f774a785d8b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"3b476a37c101154e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"9e247b6458f9f8c3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"3afee4ed6e41610e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"96b87023df57ab2e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"bce83906ab21007a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"9c831f5d1d32397f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"100cdd5f59c741f4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"ac119b3981fb0368\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"6f513d7aa822d8b0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"11e33816997952d0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"459480015188d60e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"754f0227bfdc0832\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"ed93e356773102f3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"f25858f95ed18d7c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"add446f52ea8aba5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"80f2211872e8d117\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"c577c9bebf393f4d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"064d0628f4098566\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"e8d20f4203e6dc86\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"2301ff73094c6291\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"36bb47f48ceb24b6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"870151fd7691a0b8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"c69abfe2ea70f883\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"daaa4d7b42783811\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"fc3c5c141a3f7710\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"b44128d7bb4bddea\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"4864703927e10388\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"0fc26e80cff46758\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"2eccc7cda6eea1d5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"77f18048aae6b9a6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"4d03afc406c635de\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"8dd3b61d6100cac7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"19f9311399b2ee9a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"d9b4d6dbfb8eccae\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"db1f5cacfb0f7ccd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"7fdc05b1bae72feb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"a6833b650f9b55ae\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"6e8d9da016ebfc86\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"12a3e30214dd37dd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"2fce169c48d685c6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"d766977d4866c14a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"0c8b139ced36dafb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"f5e0abafcf216180\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"0c162a757c816c12\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"36b9257dfb337611\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"b278f153917c7537\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"98243bf95019bea4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"501234333d1c6576\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"c37e26a478ef3841\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"0706894bffffd59d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"ea0e31e708ebb328\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"9b34d57db4fc090d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"274d0ba1b32fa657\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"3d7a735e6debd903\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"a381a6aa5b47fa5e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"47a78d67c359a96e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"acade3817f54bb32\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"1a948004c713f8f1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"094d093770c3a453\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"c2b58d9b0797f14a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"cc62f6a57a22c4be\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"eb73369801384735\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"b4a56ad36524015a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"7992f4ceb15c94f5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"f48ec01932fef8fe\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"fe8e7d8b66a52331\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"0cdfd4de64087a8f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"9c52d01f16f61fa1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"085dcf17f5cc40fd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"b5ee040b58a52dc1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"fde247163c271cab\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"5d649e115fd79e01\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"8c54b6b07157b797\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"91fd58bad0fc53e8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"4db08330521b85e8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"1207f4523626c109\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"5ace9fb95488530d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"8bfcf10bf3cd094f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"d4379e75307de60f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"a5505012103720d4\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"2e338a298c680456\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"e108e9bc59daa39a\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"66c7525410e3c0fc\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"7da3988f0d5ea097\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"f2f50b358331985f\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"76e2fb788692b76e\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"7b25cd760690894f\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"6cb513a3842b4a85\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"58ec959027c4b845\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"27a06909831c4545\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
