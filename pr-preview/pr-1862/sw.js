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
		buildId: "db00b8652c7f-64eb64db",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"345941a180982f63\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"345941a180982f63\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-CqABzAT6.js\":\"1e0398af5fb9fc09\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"552fd304df2f9dc4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-BcwPeVE8.js\":\"f5641af7e5db53bc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-Dse3grSe.js\":\"5d3f6ad9cdf40da2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-DwwWI-In.js\":\"1b80cf1bf9bf60e5\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-D8yjHzXY.js\":\"b04e1d8b4e97156c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-r-uVGH7x.js\":\"7c845ba73988a1f0\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-4ZTZqWit.js\":\"8f5c4f33afb3f18c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-Drsvljl_.js\":\"31f76efa96701cf7\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-8MNxaFNC.js\":\"bc782dac8f7c8f8e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-qV_syEma.js\":\"0372cd3a6015228e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BPkdmiRv.js\":\"f88b0dc1b377de8c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BbTYdpxD.js\":\"e0e6b82315ccb761\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BcoopvN8.js\":\"bdea419c8335f095\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-CqeQHE15.js\":\"75ea2998458f5bc7\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DiXvI4Il.js\":\"571b49b327f636b8\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-H3R0KvPJ.js\":\"a4b82ec5596f271d\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-DNElX4Tj.js\":\"768d33d19f16b848\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-BM3cWr09.js\":\"420994da66254689\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-o7Cek2PG.js\":\"511ba8d2a7c0b864\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-iF-mufic.js\":\"2b6a918ba603d73e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-xranhsej.js\":\"fc9763e49f9d58f4\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-JfBr2ozt.js\":\"70dbe8718297d898\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-EaedMSQQ.js\":\"1031d8c265e83cec\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-W6YUZYMO.js\":\"79aab7b6a1fb73dd\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"22a3ff5292ff6d37\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"6f7e00af818b9eef\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"204a3f3a3083e5cf\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"f41250a212a4c9a1\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"af078a7f965b90cd\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"16a2e89fac3080fa\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"39d8e400fb6126bf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"094617c16c5924d7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"9d628edc7d272fc3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"811d72aa8e255d0b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"9a9796395b42f00b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"cb297caddd986501\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"4cc56163ff423964\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"7255ded01dfaac76\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"2836a9460f96eca6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"6d946e7794b60795\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"f7fe5b28d95953fa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"a467561f3427ee32\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"709795f447f43a4d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"cfd65ff6cf70896d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"454ede3d32f4ba70\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"72850d0fea594307\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"32dfed15e55efc0e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b6c214a778f4b782\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"2ff3a6f7aea87a9f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"b13aa00891a411e3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"f857428deb38b63f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"4fc133411244546e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"5b9c75325edd2b10\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"a64a2e1ca7b88223\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"00803aea9f0ec453\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"a0d1db4c9862dacf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"97de59e8a3810113\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"7be61bbfd8a0bf8f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"2c56833e1e2313b6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"27584c67f0f9e4fb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"05ffe4db22743778\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"5f91940191ed12a8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"a844a1a60893ef08\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"ecaf1dc03643ff1e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"80590a59e99f4c4b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"f88928ceb0e2dbc3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1e3f637782a6c73d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"6d04b7c5b21436f7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"5d228f10529f035d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"ec3a4c1dbec4e18b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"276db7236b06127f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"2047bf74d401a6cb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"b2c8dfea10592e62\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"c25450e9261cffa7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"a3926d68ff250ebf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"0c5fc768477413e5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"34d6d8f36a8e1603\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"cd87b5373bca8e81\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"c6cbe7dea2fff685\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"0c8bc20c3eb8b4b6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"78a7a26d64778243\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"49dfe4d5c6d4f6c1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"1d1314c25753d819\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c4550092f423e413\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"96072f16be3ab0f5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f3067176b1113a9d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"9d8c56dae3530a99\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"44a0a3dfef770049\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"3c1ef22a80c9c8f3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"8a874a78363c6288\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"caf696e762ec72a1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fd88e966cb26dc70\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"2166d213104ed915\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"ac65ffefe0a25a15\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"6bf7b95e2d6fc92d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"a3f038b927a627ed\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"727e2236d3e18287\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"ec6ea929ff2938a3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"d388d1833b093d3d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"88d4a8950f8a7c70\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"b1a255dbec579ed4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"f299e94b5ca6ebe6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"ac34d935d1ac1322\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"d446d3ac5e681037\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"476be4cf007c37f8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"8e4df6510114b552\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"cbad238689c425cd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"0dd3e5efc0af1669\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"1b76811d7f7a1084\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"169ed04abf205110\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"c25206a6f52fdcb7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"e0b3481f2038a5a2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"33ae9d50ecfae5fb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"8c431c67c9bbff6e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"c537a58c156e333a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"1308a86fc71983ad\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"0ee0bc664a1abea7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"78c95f89117274d7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"c04cee61e09ad250\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"2793fc6a0ef7693a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"f509d29f079c2a2f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"a912a9db4be9efb2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"93688c0b77cff74c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"7727fc30461369d1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"737f4da915b36091\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"1aa7bfebe759699d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"8b77cd89fb6f1e68\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"463f7e02aba2b1fb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"dc87d57f1dfc5bca\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"fdb52d90e52cf005\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"40d9b964254df2c7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"bb1fddc5b04735b4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"9ff04bd7ba02ccf8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"d3a404ae6f0395f1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9d5930ee3107d331\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"cc529d1e8f18bcd7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"b8a8dcba69bacb4f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"c6669b19662f5bf4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"3d4acd93adff9b0e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"2500e297b14ed44a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"60928c7689d67cf3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"66e54a350757d161\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"91bdb0a0135cc764\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"453aa0bda25689ce\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"77071ca560ccc4f1\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"8fdfdfd0d2b77c25\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"ecf4a36665958ecd\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"feac8fc40b35ce72\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"7d83a3fd5a00af00\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"c51094f0a95cdaef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"47f11aba76098726\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"d56b2d535eb851e4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"4956e6bd03ee28ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"76f8936ea1ed5622\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"923ca3db8965f615\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"0a687f6fe341276a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"7382edcd2306f235\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"fcec8e93d29b6787\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"42130a97da535699\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"5bf85de817dbeb35\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"8fe71fa577b7e123\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"0bf9758c78610225\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"ed07fa8e7c29439c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"0a3e6288e4ae7063\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"fcec8e93d29b6787\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"fcec8e93d29b6787\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"40a3afdf02f52797\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"f081e973687b1a7b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"701a4b441fed263a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"7c417dfd67e82f75\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"b7487abd86855bea\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"eeb85ccf67e85772\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"b4b483e50226a1c9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"a3825bcbe84d011b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"b6712338115baedd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"ce6c5aff72e5a34f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"c4df417aabb8bf8e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"d3089e0c673fa3b3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"baf430f2252519e9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"9aeba907a5294e35\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"16480665c70413e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"b289c3bc81c6210b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"f2d6f19a23d4b699\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"655bc9eb0c33af55\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"c5a5d682237e5ebe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"fb00385ef676e17e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"cf3363e2ac9f654a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"35b7de34b260e2c7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"89842e136954a2d6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"6cb08c9708f0119e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"2af2aa6c32919f8c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"ffc8557328c3d9b5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"60d55c30887a4f8d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"5faf7cb91e1e9503\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"db1720015f5f36fb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"25d3d9acd0435c6f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"8527ac8301c0e363\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"9b8ba992d263a2ff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"1e7c46ab007e4134\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"c6520124bd7017e3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"9e527ef595a9dcb5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"0dce74a804477e94\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"b466d211e9af4de8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"8a3edfcb4ffd3062\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"df82469fb8b9a733\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"aa3e7c0f927914c9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"a8b17e1b690bb648\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"9bd0c51892a4f997\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"9127d80ddb2c55ae\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"9de98e6ef0970783\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"1511f24b32742f7c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"d3a0ca23aeb19342\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"115176b998dd9a70\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"34ff1801949658fa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"f98a229a40430be7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"afe3e86c0a30bd56\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"f9625aa17575d597\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"00e91f5c19ba452f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"fee337e7649d50a7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"2b0b34f46aa765b3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"6aa29fc666361601\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"24b1fadd35492bc3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"a8a2e9d583b5b7e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"b844b1ca1cef2184\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ea707971e6977cc2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"319730dc32de483d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"2e329864f644eaa8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"b9888c9ea7d3d597\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"4c6450a76da27ef2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"2b94df63272e7a4f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"c0d5dab4dcf1bab4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"bafad36640bb9a38\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"3afde2275112969c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"980637ed1ee062c0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"01f325f478930d44\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"4ac7892da716a45d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"a952fe268af341dc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"eb3e9c58e938e71c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"20af971c3869ad2f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"bcfd6875b9dd2e95\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"3f27d6d04cba34bf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"8176c5777b429607\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"09401e242af05aab\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"ad179d1b6d282fa1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"053476f49be0f51b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"9a6c83f3c4fd7667\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"1029d681039493eb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"751ca4a58c0dbf8c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"4a2963cc8a2b56e5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"20f89fc56bf9dd22\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"35b945f13a67220c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"cacba6666f71a7d9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"26253457fb11aac7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"ed4a504d2bf4192e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"46bd2a588e09e88b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"e6d466801e816cc3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"af9fa8ce4b9da3df\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"fe43dad1411e7222\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"7b4f18b36008f72e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"c52ed81b7a312feb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"bc99d9c00976e29f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"3233edfe771e186c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"3580407ff4c18e00\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"c7b43eb397883686\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"7543e8764bb19acb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"0cc735501e31cdcb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"d8de252b32815fb5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"a9ae12b89b04997a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"cfd15c1f83f1fccc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"84559c2b1cba85ee\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"e16aeb841d4bd523\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"2bcb32dbcbb16f2c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"f887af6f5665e957\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"a206792b6b133616\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"28d9dc75d7209438\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"b95437db4f45ed54\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"58a2e582d764e44e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"6b745a26daa22ec8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"fb884d197688bcce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"58e512c4fd8f0abd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"d0449e0273401549\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"94ad3cc5aed8ab15\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"0310fa2a28afd3d9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"88db7a4969f50251\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"c875949cee5f4eca\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"52bdcf8f004c9020\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"55926f91c666e51d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"ecf03443630ff171\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"ba88a9251739c2aa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"bd79dd245e185846\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"e7828f25986de217\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"0c6a2ec6e6377888\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"c57bf404a59d662d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"9d9f8a607e9b6b71\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"7b99abfad845064f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"e2dc001e77a9f470\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"ec3b8ac89fd32573\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"75152f62b295308e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"a23e7df7662ac8ae\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"9694377ac017c310\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"c2f5a7efa5c9c1c6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"bd0811da8ece66ce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"36b5675619df097a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"bd6a036b0022889c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"a9922704ae190a74\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"cc16de1f1ae3134c\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"c5cd3df7b17b7340\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"cfc15a32d6372adf\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"43a9ab76e040aea2\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"5806d2188c691d54\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"3982f8df7abdded9\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"381d72a9ebc8c9ae\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"565b53e13e743a49\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"2d54008f515609f1\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"662b27554ec3917e\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"f98fac5a21d0ef08\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"bf3e1b6934bbd58c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"47db675b4886f3f5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"ec5025c40eb9c694\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"1f56099c5e423a1d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"983ac53612982678\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"6a80039086bf8ec1\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"b0e484d8f7f98b73\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"34855d1dccd8142c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"b40503b0a21f5207\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"f87fcf7fc69bc72e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"62558b5f77c5606e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"02f3dfd7a0f26d4e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"78860d877fe484fc\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"083c01469d1e2e89\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"517e303ce43cd355\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"9e45aa8a91098140\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"9208d3ef89b97e16\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"b086221b3ecf151b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"8ab122a2cb5b0b90\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"2d08aaed865c596c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"10c121ab34bb294f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"8fd874a9e8bf51d4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"349b6d943dedfaef\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"9c96ec9d490a3e11\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"aac30eff2cda5453\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"484c0f7973fceb56\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"b23ed1ef4ff46f7c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"43b1b8e8550f7f23\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"0161c96f88f13fc3\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"f0e8cb768c6106ed\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"37a30c87097bf70f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"eab0c90f2888b441\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"36584b2adbd943b4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"3af29e9544348ee7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"eb31c9c7130a75a2\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"559e160729eea893\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"8a7f63a9a360b53f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"eadd977fc4be1ff7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"5f6ecf0a16b63e7a\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"d1cd3395d7e30c87\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"d7ebfacd012a1148\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"68749d65fe61f537\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"7b24c7f2101b3c76\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"36e07c05d21d5a87\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"7dd28d151de0af89\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"a5810a53f2c4e405\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"5bffcec691298dd7\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"ffe9f6858240274f\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"3a31d76074c66e0c\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"74427697e78e0197\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"e319574b599196a4\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"4f0baf6f35d3c56d\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"b378e3240effd877\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"4e6411a533f1d989\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"b76881cfd5c88e72\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"4cc32d7d5d8fab28\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"49935bd6c513098c\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"0234db6557faa412\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"ad64e8882189b95e\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"06f6ec7fa6b73e7d\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"03402e8656841856\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"adf7be972c3ec042\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"770f974a1ca9c9a3\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"f7fb01eb1f0a1db5\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"b925e8c87dcda3a2\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"2e79b44e1a0f2b80\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"dbaf868f67640507\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"ca15393acb78834d\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"03e2bd037d60746e\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"6c8c95de7abfdd79\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"4785dc659da01f2a\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"b32d7f7124e3447b\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"362680de59ee8581\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"9b2af4767de6a8db\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"05769794bc67a128\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"04bf73f42c0b46b9\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"cf60008c8ea40a72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"7611892f890a8487\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"4d44913c2eb5b2f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"50f03e11777587c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"108c2f27ffe95855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"28616cd21af390df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"54dc11c7177771bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"ba244149aef105c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"167f52e1baaf43c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"de9541bb600f0f96\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"21165cd448fba529\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"1990361b933e016c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8fe9097b04dc3345\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a53471ef94158d1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"dda3ba48532286ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b15abbe44f4f8cff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"be8c65f62cbdd0ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"d44b4fb9b8039363\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d14e2a265d9b731b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"3f2ae2bc9daca945\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"9309b4ac8088f08a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"c615f2ddd81d1e3e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"7b68c140928112eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1754360ff06a49cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"14118a0c25506636\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"073ec6a344e8f1a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6bc4744eed7a345c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"516c30fa5847aabe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"8f490732df7a2dbd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"2dafb61f9e6b0068\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"117e5bb9461ce7a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"621c2d7086089243\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"d9b52f4f4b1b4cdc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"802d507d2076fbff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"9c7d26a9e67a5e34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"d282f90cb439cafd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"dd6e7eb259787f52\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"1cf4f183cc4d8e61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"94f44e402226c70a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"f813f319bc074b71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"6b9da0578978e425\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"a9cba2d5b701a853\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"3337bddecedb8456\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"48e97e45db7cf129\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b25343b82440fb73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"db857d03732ee0a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"c83d0de17654f1f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"4fff3d137d25f261\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"a142d1191f96b2ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"72243c2e8c473733\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"7f6fd01e7c665040\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"2f275311aa963b01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"679175ecec7f6d5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"9e65942d2057d241\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"c65d13d2adffac0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"f75403cc7b6b863d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"2add812da2da2cab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"1f3771c8e4ee8909\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"32129b7ab2e38888\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"f070e1ea0b8b078c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"2713a1cd50f99425\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"d489bb670df6783f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"1c299333832d986d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"dadc0fda5206e39c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"1f0156f164d137ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"3cccae6dc8177e3c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"21b72cd52b9bdb67\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"53616775444a0e34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"519aecb864af9d23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"0389f73545026b79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"f8a2e985f187402c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"bd12f8d8c3bcd1cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"8158edc36323d622\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"feacbfbc6c872801\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"3c7170869750b5a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"14a26531c2f5ac32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"f0e127e4854a8123\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"59d86f0e2bf68e17\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"637c6a265a48f5a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"6ceda73f85f8f5df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"e1ef9317637777db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"b5fabee335eb563a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"cc6c31285b19b7d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"77c36fd00b487755\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"bb32aaf1137fe30a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"0ad6f8ef8930980b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"1e70c134b4e6fbf6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"3240045b872abb6d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"0d7bccac712e144e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"5c7db4af415323dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"9dcf943584686daa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"1a3ec026bacc939c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"21a54ffa6ab51cc7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"2ca79f5cc053ebd4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"6af52a928a127855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"1c6107e35677e351\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"2beb1132fa077de6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"97184cb3fa9085d2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"7dee6f7e9c7af421\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"c34797fa0ee043fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"379e9f918aa6ba16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"fd44c547e6ad594a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"7cc45590118241d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"fae43fc5bc3eac3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"6726108638b37997\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7227310cb8e5a689\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"00b64164dc208dfd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"267c3f220be5e80d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"20df8d4743670640\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"63aa1044f15453af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"09a7faa10ec382f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"e0682d681e4380c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"2b14a5686e72dc33\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b702e077e7118da1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"8c30c51f3dfcfb12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"4d174dee0082f432\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"40ace8ad64bac05d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"9aa7e8feab0829a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"77554dd49cce14e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"4557d220f45f99ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"199bc328c0b38907\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"4f538c3d66decfeb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"ce2b1deef6dfa740\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"e76c8e2028fd8f21\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"06687d2ff56b4200\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"53ddd60ebec79610\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"fa67e94775ee9f94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"4b18083523e3c6ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"52db7b7646439dd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"fb4111ad179d5a22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"01469f3f8f14d676\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"e25f31a32de5006a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"a2e2805a55140c51\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"71bddf5e5bc695df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"ac041ad188fe8d7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"a1eb72f991c0f218\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"0af624d59020e0b8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"aac33b9a0e948b9e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"7ee6ec1276ee4299\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"1f0ea3e0044a89d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a7d7236b40466ab1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"70786d7a72460b21\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"dfb09fda87023234\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"0a16fdbcc8580845\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"5dc5244bb7eb3526\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"62ce1165f9961090\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bf87871fa1c2ce11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"8dc2074dae722663\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"f4b37da95d4d26ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4abb59088cc1cec6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"238851eab13b246d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"5f464a5b70bd0d1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"8b91bddfedba0e71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"abeeb82b6bed858f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"4d27d09aa46b0937\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d25a320bdfc0a667\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"83d1241c23dc0105\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"8d87a8cee59bf7fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c592c8944fa0f882\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"a3f088d2ca415050\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ceb572570c03fc6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"07ae7fd8d57a7271\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"76146dc4c231197f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"50acf398210928ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"c97027a04fe40cbf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"c2ab5a2c81a83db1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"c240d53b3ccfc97c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"4a737969f62ee321\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"e9f22eed12215ca8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e105967298ff4832\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"1156bb0254753759\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"78b8caf81c8b6fec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"592d929677b305d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"01cbbb1abd54011b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"e754f06497a52be1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"44d2be36260b2cd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"16b5ae9b97673d9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"399783d2de3c160b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"a8f31ce7dac28aa2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"c6ab2214848de8a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"b871f164684795d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"d0de8373210c6ad3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"17d511f67cc46036\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4640b1b3ac231064\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"c87452bb82658b02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"d18e72ae692b6049\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"e3c03b7d31a076ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"963b29b17cd3016b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"5cedfff7386ad84d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"e21a7a9933b7f3e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"9844460c0688b759\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e76a74da5a8411cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3bf67fca299549fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e93943aad913d094\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"249bf58eef9aab23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e2e7b43edcb3407f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"3f865d271e833385\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0d4866d76050a9fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"3b1e85aa7854a6a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"535b94edb553001e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"4ec2e34211de2e7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"e9dbc739433acd25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"767b85e3b8983355\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"58413ac7737967f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"af5a7b8f805380ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"f683b4a12941ac34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"e8754f379a11f0fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"fff705ca8bca1c21\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"83b2452c3adf52c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"47cee405718dc560\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"329d6b561ea78336\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"c443ed0ac33d723d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"48c625d83d334c09\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"5cfe58cd7c19009a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"450fcd4ddf92b9fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"3d2510f32aff0c2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"d93dfb2de3191eab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"c9a5cfa661daef06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"c23507e503ee94c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"d53b8eedd1e963ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"11bd5b8a671e1c2b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"0f2a73a9a7c9881c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"79457f1cbaadc2ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"e3c8eef77aeed2a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"11d0c3a49aac9aac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"fef0676b245d50c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4bc7954853285d96\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d536bded39a461bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"7c09e885f5345779\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"cdf0e855e9bf9230\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a09977f1d6c88e8d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"1bd4a9bd733f1700\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"a69aaf96e4c19586\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c272c7690fdd2c7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"c4b1663bd34beae2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"12283f62667adf73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"459ddad2e577811f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"d9543db1815ff973\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9640fb6c396b52b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"98012c793d1b5055\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"f5c28428f7b10732\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"2838a98c3bd5d542\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"9b02761a33c8ca12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"75ae58f5f5a7bbb2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"5192dbe215082410\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"8c842a3cdfe62262\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"cc298f436f082c83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9c5c00f064a8e3e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"2eccd0f36d1a803f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"6b6a72c8e22929d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"467da4b80434a3b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"2964890dc070799e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"12cf3ec71902d7e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"36036e68f88747af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"9037dc4010e2d04f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"0ca022025fa62ba0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"15b8ab6b0876f956\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"2359e8a3efb4ed20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"4809bc098f125103\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"49707af3e9062405\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0c4553664675c4da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"7ca6ea4aa5775100\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"6901a02e35445bb2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"9cc81058dfb4a31c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"614f3741f65cef9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"6ebcf190dc1d5683\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"9f90139820900a23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b8bcaec33587d02a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"c3797362e78d24b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"99f2fa982248f179\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"ee6607f01b1aaab2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"538a054fbeb39336\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"93316072a5b8fa10\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"504caac46d86c7e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"d574164d240f3870\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"094e256ff7df6524\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"ad92762d93ee1e54\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"c037f26317a6757d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"14c24881c8ad3249\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"7010d8597afd077a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"d8d9d0fd1eb8d87e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"0d9e78d5ad1f4a76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"2e90417829092889\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"e386b0dda8a7880f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"095671794af15ae9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"c3446b4c14b5e8de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"ba9464576b4be88e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"62724931f5e0eb06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"c2ab3db6b3bf37dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"fb91c03e8c72e9f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"c772cc0b697c8114\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"85fc06d864c93722\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"b37cffd8980ca1bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"be91936c2453dc90\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"6e9af78e68d9bd04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"81cf5a85b80a1b29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1555ad854d92ba06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"d089706f0d78bd29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"01a5d6425156c833\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"c9f3fb4b0c43ba58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"c95134cd3c9ca047\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"5953b81fc0334b47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"dcc988fbabc82034\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"09110e7ab70cfee9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"5e346e574577faa2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"76f79fa3a8ea8757\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"60fd9959127b3b88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"46733565ecb3a2fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"afd661da64a47419\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"520ee7ea0a97c120\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"f65a610eaeb062dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"5d2d7e3d1453cb09\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"fc6b7c55096733a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"6d36cf56676a6ad8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"73cd8a8883b5c4ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"3120806d0f1170a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"6a0ea6ba4f34d217\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"13ca53cc623181fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"65a77f940e5b8047\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"4cfaf8fe6a8f2bf4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"13534e42e13d3985\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"47d3e8a797efcb0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"697ec86f90380c43\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"3bf0dc6021049cd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"b37e7e360e605d2d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"5eef26668670df9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"55d95b77b2cf7db1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"5c17448e7577c986\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"8feac0b9e054a665\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"9ec7df1e07a771bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"09b4685170f63fd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"e830cb612e00a8a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"d3942df9d180a979\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"7bffe0e79ba00a0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"339d143198aaf8b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"21671b4a10002f00\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c0093ff81f9eb338\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"87e355e6cbbbcb4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"70bc0b5ca6cd12d2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"75faf0653c204c8d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"c7dec9d3ecc729de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"465eebd7c5f5cfd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"584a972689104ec5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"99a4a188d491031f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"72460fca9fc40286\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ef944a67e61884a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6e76807eb0415ce3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"ede5d487dbd9c3d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"0661e4f293e40160\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"2de0899726aa7b9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"d6e802c0068b1125\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"0dfc26c8a8824931\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"65dbf15d27988863\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"6a47a0eb74d04116\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"2658698c1c19f029\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"d2619cc3a8e0fc4d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"06b752ace1100662\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"6cfd8f0de4c254a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"6050afe7a5aa94ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"1f30ff390bc2509b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"63c757314e01ddc9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"37c28eeaaa5fcbf2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"67e3943c4c51fe9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"954f24776e2d732a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"3496854ebfaf3e91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"7acf5d9c65d67aac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2fc8045cbb3e7438\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"36cc01083b638b3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"530f5e71925775b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"37e645f006a6e176\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"d3886f2fea58b548\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"7577c82fb72b99a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"994e3beb87803bf1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"b39a02ee672cf041\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"b87fd3d5a01c78f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"938b41df5f5e520f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"e2a1db644ec3de55\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"fc761de6f2fd501e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"af483013778c8f91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"354cb4403d657053\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"2aee8ff440cf03ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"b8afe8856bdf56c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"cab8944dea9f0848\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"7c6e17f6f14787d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"9640a70772017a12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"e7eed16b7ac422b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"980828d61b61fca4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"243cfe413ff5ed43\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ca0dbe1a71478c86\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d606f76090ef1d4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"2015088c4eaa2e0f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"22b168678d40e1b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f0feebef470a895c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0ea965e7859d9e07\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a3ca468f2d08d328\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"11c9034d3e5ea1d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"13dc3fd165ee4acd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"058b64c15748c72c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"979c1462d2921e41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"fac1d65771159598\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"4068343471fc98eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"fca1c5a0dc6b99f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"84edf8a4f7c4aa7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"71b07d85e6ff723b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"04ef0dbd12d5be02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"9814c5cdcc6da577\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"6d68ea095f1056e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"6dbb8c8d54c8cf98\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"79566fb81c670b18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"59af263ca54dbf2b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"400934983bbeb4e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"87f9b29314ef8ac7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"a12396eda34b43ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"77cf1acc39ccc7b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"e6972d5f5be41141\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"6587e4b03f6eac17\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"7bcf01fe3f07f73b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"a4219a5514815ea0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"48ba0063adbf5ecb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"22a1b99ca9568510\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"d45f2334de6a1dc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"dfbc5ea78c165d1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"d885a74ef6e5104b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"e09fa7647cb325dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"919a10832f2d992c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"f9121d27cd3134c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"a1b683cdca653806\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0e4a5386b5d65ddb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"60c2c8973475cc4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"bcfb1e6a94e1a767\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"5773ca2dba092114\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"888f84fb44afa4e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"a27ddfb87c26cd3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"6dff75aeae51150e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"46bf9ca920d4b180\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"c80a550f9c5b8eae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"4e9a6706341c79df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"67e2f7ab491e9533\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"3324296188f2ed2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"1e8bebbb1646029b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"503b5703c15e04bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"761bf0836f085966\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"144803268f30128b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"a7cc0d8b851bde7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"dd89f25950c4d0f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"2f67d5249c9624b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"8b34e6fb175a4f1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"8bcf9c0a728d6f79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"3a7ba586024ab1cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"539232074f519d92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"579024b2cc350b5c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"aa3f4e4c7ca95f01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"c51f2549c7f4ee8d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ba2ffd01fb4c6f0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"ef49331d8ac9d7b4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"015dddf5ab16c0b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"83a92034221dc5db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"491e5e32e103b300\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"fdcf5f4cf0d113c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"f9ea0b97a2b6c256\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"4eb99847da233d02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2b54fb718192e011\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"e4aa7ec3f96d5a89\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"4262f65abee13502\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"2b5329aca011580c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"57067317eb819286\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"b445a6d106f7aea5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"2310fd6eb5dc0bc5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cd56f1db3d153e08\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"34654f80dfba550e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"1edc29295168636d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1ac5412921a3b637\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cc9031a56ee22f43\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"75ce83a802ae0159\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"7d0b0b4017d8ddaa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"a2f342347ff01cc7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"c0ca766102c312d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"f7de79f4cc88435f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"06583dcf2c64b3eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"456d06e8bdb2e000\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"b9398215df34fcdb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"000d854dae88aec3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"62241f4515cf3ee4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"b81d38ca880cc010\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"6e5f82b13c942bc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"0fa0e73dce4ffbd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"486b13958ff4cc6d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"5b25e2b0f9e62026\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"822c5eaf7e9ab394\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"e75a94ef3c4f9cb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"8d2a79a1251b9ca0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"d2f79b879788972e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"cc883f05470b5ee8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"c12a3225b0eb95ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"5d564b2e75c34ae6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"24b90c99d6adbacc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"cbeaf0bcfc06111d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"dffde362db2b0346\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"79dcfc010819b732\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"9f43f83b1e3f1147\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"c68e2e0ebc8f08af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"df554ad72130e222\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"29b63a1517fe9540\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"69c77ceb7a7489d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"2c970219895717f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"8019c47347aa5957\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"db946f0da8a8c5b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"196a2196f8ce2cd5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"e2e4917fe0543465\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"c892fee28a84fd77\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"a643d52980028973\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"37d8267523c4f942\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9d347dbe376a696e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"dd05eab8c04e4176\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"17cabe8342b56cec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8e02378dcce819a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"4d37e687bab32eb8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"5022e0aef8dde1b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"7e4ae70199716780\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"199a6a8448a7127a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4361fcdfc323f95d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"7016155e7cf22aae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"085fe54ced5431ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"5ee1b8de92dd5fe6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"2e3043e7a9486521\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d0481a1c3701f6ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"7bab0a2d640f7702\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"6b97e38f0d33d583\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6d79f7601637e111\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"33561b694cc0460b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7f9e4087fe720302\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"839121e87ae4f9d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"8ef6f7fd6c58bdd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"43d8159ce5c74ce5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6423a288806bd43e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"6422e31ddecf5af2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"6700646a796c36b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"eae69ff45d68cf63\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"d8a2cdddc0a36c4b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"c2c6af66bf658468\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"7347933ea0c75b92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"2fe0ab8133db440f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"49d859981312cbf8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"5796d5bb53b610e0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"487168404f85a724\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"d0d85c494fc514f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"26e0ec00a555541d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"8e6dbccd6ac10ed2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"2f7349241c06001b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"efb5d53846dc906c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"74f378852c06eb06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"ac903c215808edfe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"06b773a6c7e613b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"7e5f0715f828f56f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"ffa0b5cab8f1bcd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"30e291ad5f498335\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"f791151a97c94694\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"cf53487d3813b28a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"5eba6082d8a5334a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"1b10198e9d552611\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"1247e679e58966bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"05cbaf5b30ebe789\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"ef40cb3433ef31de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"96507a5279b32b5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"16f52da28882ee01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"bd03fa6e849dfe87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"3a8769342f95b243\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"6485f0429fda9656\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a1a668464c85c703\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"821ded12a6b62129\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"d6451463fbe60120\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"19724600ed0cedfc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"1690a85826e95070\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"525f62da1f81f9ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"54e134741403f8c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"c088f0ac63dffff9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"8ea5035045c885c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"e09b857456236abf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"03c7cadf6c0c7130\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"6e18a93bd471972e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"6759c0974b6c0ed3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"a043f7fcec79bec4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"b303c5a16ff4e11a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"a5f2515479431c60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"d48e482927d7ee11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"58aadcaa7e975c6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"2c9e4fe8d87dafba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/navigation.js\":\"506dd1335ea6ebe5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"845d9b3080441ac8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"575fb2725a48302b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"818c105c0ce58a18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"6aea651e23fc4baa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"4aa5412806361e82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"f1904cf1278d449b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"cdfb584c8993084d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"0372e1b66be67503\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"56a4eeaa8ac0ba64\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"714f57b0c8538af6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"6879cc4fe2ad522c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"d7c2b1c58fe0e0cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"752d87f6f386181b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"17202de19d670ef7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"841e045c8b8d13b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"f6cd7befe61d84d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"c50d70fe89113f02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"bed602201de5d328\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"70509b9baa24ab6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"e5a92fb46a38648d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"b578ae055a6f8030\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"32e8013640c6e2b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"2ad41e9fea5c3cff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"18f7c6c22ee08e56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"f8b4e1fb6eabae68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"8ff6f5ea682a0e94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"ac5ae669421a82c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"2a3d5dbc59d7a088\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"c77d11a23da3989f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"1c60452b9ae0366c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"0e0bbaaf6c2cb5c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"afe97701cd0c6bcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"0dbfdaa85663c4e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"a4b1e144b0960bb6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"79b31b3f73572ae7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"39a26dfcfaff39c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"edfaed471a3c68c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"6959e5caa1342bd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"38bfc94f290a9aac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"5f0b1d0e1c71166f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"02c7e99201ccf56a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"d1ad5576e2774c6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"08db0f935aac84d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"e635b22af360c60e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"c5b64b189fe7e32b\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"3fec4b35f20e0100\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"c87c966646d35682\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"eee01fcbd5273c96\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"2d8ecb514ece07c8\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"b85c9e960e415d2a\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"93f095814aa4f383\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"6738b7fd133743e4\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"b4c5c2227e7d3930\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"9cf6078853d39d19\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"0e9334f4d03ebe75\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"68fad7dcc1a26b23\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"ebfa2965edf226a5\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"a76294aa0c22f1f4\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"cba0ff3a3e8057a9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"d68d3d80ab7ace75\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"f61fea5b8e978c2d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"249da26a6892239d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"14759a497f3e87db\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"a4f910bc1108c5ba\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"1314ef4c447152a0\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"aab04f3e272d053f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"d138fe9e3aa56eb1\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"2739d3b1b0d557c0\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"ea43096ca8e3c5fb\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"57c7dc3e5209b6ab\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"849011077a231b8a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"e220036e17b13961\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"2e4edf770aa9846e\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"50772778bda2845f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"8dbc2376faad822f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"5c0ad199b6e89b16\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"e2f751ed09f11b21\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"837345195a1e6902\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"2c7f36abe2628705\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"980ede1a424f5389\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"ef6594beac2272b3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"4e99e68b8d01a965\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"79dc7970614fde5f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"ea11a49d6287e7de\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"bf91e889016992dc\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"7aaa3e0a90ba1994\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"25594ffb708cd680\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"8c0cf4b4b2bf3550\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"437e4fb2d14c82c0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"d11d8505db58490d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"40fa29bbb68e21b6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"de4a2b466b9d4cd3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"f90940278923e16e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"d2b239d93b839230\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"89f0dd81c77863ca\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"7254bac1167ac449\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"3434f2903c52f6e4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"4e2f2607e9a4f1ea\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"eab02c6e9e3c773e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"ba5faed051788425\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"2d52d03902b1dabf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"b4a8d25f0765dec1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"3ad1324fd5c69fa7\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"c4a3668f4c71c1cb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"8e15b08801e0f1c5\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"c02d175c1e484f71\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"e92944814aebb8e4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"8724ad65b943da73\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"a6c5509d60797793\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"5bc815e653478694\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"699aafb6478167ed\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"4a5073081decc5ab\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"5cf9260cbff4dadb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"5d1747c615b56819\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"553f685f364782db\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"e972dec78f6b7404\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4b72b897e96b9751\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"e11ed5d875873f43\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1f4d90d7dd55cbf9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cd6e353857ee2961\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"2e8887da4cfc7001\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"934bb9878ba5817d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"25f22bbaf7be44b8\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"419c4f7f3ecbbdbb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"7a0cc877cc22c215\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"53dbd078057ecb5a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"5ad4a6c3040a4516\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"bfbec9985a496439\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"832e9a631c821964\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"ac6a98d9908d0bed\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"d8ee26b1ce2d38ac\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"1b632170a47a05a8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"ea8778f2a1cd1f04\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"1a966bd093691ed6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"b20c8cfe7c767af5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"016a5f7144580462\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"be5cd0daef18aae3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"a9278e66a7faeeaf\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"abb5f7fab8eda9ca\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"b832add81d585ab4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"32ac5cd0349d0e4a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"225eb14b11449e89\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"059307c13c08963b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"4a9ba0a4490b4e5e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"1f3d8016ecb59fc9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"da9d19d24059534b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"e8cdda3228f5d781\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"593b7b7a31e48743\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"5c993f27b20b13d1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"4aeebb6333b36806\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"e064314d24371fee\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"41b163444a359445\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"357b05f784c4158b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"24c54d28b42f7bc0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"c97326146e7bf448\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"2c3cba27bff6508e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"d195bf8e90bdf605\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"61f7c93935b07a2b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"3d95a5473b6c44cc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"543819a59e727725\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"8fc3f92558f51ed6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"c49eb32ce4ff6bbc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"87ec924fcb58a971\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"c165075832d6f4e7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"36bdfca2cfcf4fc8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"3cf42da1884f617a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"7364bfe66a85fc46\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"fd50ae9cea7b6a1e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"371a3fd871eff36b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"de73d84dc2b96ac4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"6b17fcebea60828b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"506b8cbe9e8f474d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"4459402c4603a3e9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"e83b091beecaaeda\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"4174cc56d41c8c65\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"3c56eb41bd3c1cc3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"4a8b0d962704f656\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"084938e02407a8dd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"1f56841393df8236\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"bf17dda5f0c7b4b5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"7eaa6d8718570583\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"6725317b4444cd95\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"043e351976f3b84d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"8b262f15b9a699e9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"fd81af5426a5884d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"e6c45bea34537bd5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"695fefbd03cced1a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"f7983c7702860d2f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"3a9dc7dd092139f1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"e747c808ed89d2a2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"d1d5f80c6f58d95f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"2a493ee70990c2a0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"df7260197435d40b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"dae1b8bf81ecc1eb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"683257665a059924\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"3a66b407f1040790\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"c3eabe5725ce3e66\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"6271f60ae78f4dd4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"8dee6c25b18e73e9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"529ab4884b449cfa\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"2127c026a6974fb0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"6ef2351c2f2e14dd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"bd32043d5fd6d5b9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"3a06651a05f94217\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"e8110f6708ca0d06\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"d91c3f5186e22c93\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"5b31ee75884e8c9a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"f00798556cbb104f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"257b0bb6837edf1f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"197c040a10c982e9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"8a782a52c534f9fc\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"5425861500f4e5ec\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"28e577b571162c3b\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"92ee962dd0c4946c\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"f3849b3659339b9d\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"c61612c77c54b04e\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"61914679a4fb35ba\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"497f65f1974bbabd\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"7d1010ba6610e1e1\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"68a25c155ffe6151\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
