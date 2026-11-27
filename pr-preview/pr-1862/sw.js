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
		buildId: "8063d1197306-efa9a17a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"c05de647e86d9eb3\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"c05de647e86d9eb3\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-DB79IriR.js\":\"c463e05e483d4588\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"0002e4824d530a31\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-VAvEnkA-.js\":\"f8b4ef25b7002260\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-BZuQmUJL.js\":\"e426897af77fca42\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-Fzw-cu45.js\":\"d2c7608c83587d03\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-DisGXahO.js\":\"a17fd80c8c4984a2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-DnXHe_Wm.js\":\"93a93f537def6b65\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-B3JgSofp.js\":\"a95263101e95a208\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-BAwU4spI.js\":\"5000cddf518ddb69\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-DbtYxxAg.js\":\"291eb169d5c162a3\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BgwMrvCC.js\":\"c68df1cb910d3157\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-B6DcbILI.js\":\"1d0d8b0676cfc078\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BKtu8YCV.js\":\"18531f288c4613c7\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-B_kuflkp.js\":\"bb51d5840e5fb3bd\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-D98Ter1I.js\":\"df79af5834386ca8\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Dz-x1Shk.js\":\"cbf91401b919e287\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DzCxk1DF.js\":\"d67162e313dd983b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Vh3HE1Oj.js\":\"35716fe4feb255f4\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-BpxrYFZd.js\":\"10890a116ce2f05b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-BUpoFi2s.js\":\"3896541128483419\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-TzNTEzF4.js\":\"9db656e9c556897a\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-vZYFd03-.js\":\"f633d8e12666dffd\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-CilbLAHo.js\":\"d34ee0271daf6e29\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-BGQJ6roA.js\":\"5e2215a8abb1c1ec\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-BuMCDwik.js\":\"5c217b68fa0933c9\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"928731218612a22c\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"a06b053901b668c9\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"5c64674abaec8d2a\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"85f3fa70a766a386\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"6c52bea2e321ff66\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"0c2c35d2f55d193e\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"7839a498a6708171\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"b950e14bfb15b578\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"0f98a6a3571670f7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"817c61e7453b141e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"82514b377f7f89b3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"21e93e1b7776910c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"1afc9297fd9d762e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"5b271036baeeb685\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"0b00e5930536766c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"dd0f1c0bff16fd63\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"b37757f10d68f798\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"eb30728df9faa465\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"949b5b28d76eaad4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"e391833b569c14a4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"6ac58fe23bdf4e21\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"6f652b5946c87040\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"53e0ecafefb4a7b2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"deff6b9db90887a6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"e4f7380a26f29c9f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"6728829c42bbf645\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"8c99a3c11016ef9e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"e8601cb73d90097b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"fb88c279352b90b6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"5cd0cf5c70b2c05f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"180bbb38783dd643\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"579263c5aec20972\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"36527e86f85bd55c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"ec099356b0a2ea7f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"53b71f4fa93c3cbb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"60371272f8444f1b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"cad43b65fcad20c5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"80647743cfa7c8b0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"f6f19abb71ab6f6a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"61c0ccf064fbd8bd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"4a17bc773ed98c54\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"671cf8f46fb846f5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"40c5641a956a2bbf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"3d412a064253ec0c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"8e32ddcd14c397b3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"0200e02a86dd2d8f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"489dc0123a31a8ff\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"cb0865c36fafb384\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/CompactReferenceLink.js\":\"946f562e1ac99385\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"161f209e4fa41d75\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"c37236658e3253b7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"da8a06b6a17a63b5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"ebdafb5e67433cc6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"26655e733f1e73b7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"e9b026d878340970\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"a8c979c455ac901d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"887085bf0942205f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockReadText.js\":\"761b40035767b3c2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"d2f26e669c4fb29b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"641696468b969ab3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"9c92619058060950\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"13de79f5f19eb0e4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"bc54c440bdc40ec6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bf81d63846124f62\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"773d706732cc0e63\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"404af88d2c986a1b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"ca9b0b6ba28864ac\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"efcef8796d7531f6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"b468e4bf5c5542cc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8d0c33c10dabd25b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"a78e17499901c961\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"5779c18098dfe663\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"a9181279ab71d6f0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"81d487e01fe70a00\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"3525592b40861f98\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"900fd0ca9a32512d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"16753456f2c3eca3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"643e389ee7997fba\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"bc0cc36db9defdbf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"223bc35d0ae5a654\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"effb479ebbb63a95\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"763e9d224602d737\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"f5e0cd22244dbc1c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"02098ed138295417\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"74018d3eff023cee\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"ee9032f3fe3d8875\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"f7459dc17603bd6b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"c463b688df672a10\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"c07c9b569d43d43e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"6f854b2374b848b7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"b0105551bc874abd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"729c1eefee9223de\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"36c983d3c1f083a7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"f170a7afa7ef0fb2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"53445a7c67513357\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"34a9a20ee9b1cef2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"b16289758f3bdeb2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"51fed7b8a23a1179\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"b2eec72e9576cfc8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"453c927c5ac1925a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"e3df3aa8465e7b50\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"2c94e92e329dbef3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"987e91e842870b59\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"fcc1d975cb28c7b2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"47fdd00483a1c42a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"e30b435ea62dd0e5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"7f3494cb48c7bec5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"08221423d8ade316\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"782abe67d19d7c82\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"3340b1c0b71f46e5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"87a57aaf2bc9bb61\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"77092609a2e4411f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8bf40071775f0f0e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"6b821882f0717233\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"16c0a83a52673963\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"bdafe15fab5c9721\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"c484f60b058b6c3a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"f210eb77a5799d5d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"f084ac9b86fc2908\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"542f3a4626b0f36e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"b0762b0fc768117d\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"80a0da1e17c5c1e5\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"ead5e266f9265878\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"ffef72c8e9eabdfc\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"c5009bec3ebcfaa6\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"b26b75a2c60647d0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"d894962581ab3aa0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"a54af77171637184\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"7e2c2ba42e183f64\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"5cb282e611f23156\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"9c0d660867569e21\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"d69d87dd0b9bb928\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"0ff262d08fb39f0a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"ce3fc616fda83756\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"4e74edb4af76502d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"30c416ba6ce48cbb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"d54451548b6a03ee\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"d438932e05406c52\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"9eda63129d69eda6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"41c107e8c086179b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"8b1a6d2197633719\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"df3b1526fa89dd22\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"30c416ba6ce48cbb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"30c416ba6ce48cbb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"d9fd20c29d405990\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"23caff09f75afbea\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"a1a4969586b924f6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"a127784ff239176f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"e7573f8eafa1b58f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"04bdd64d6466f580\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"d492f0e8a9caaf5d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"acb9c0a8c137087f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"52f51a27e6338b6f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"e2fcc12eb684ed78\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"f8c3c039941ad210\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"07d8566b26f1f2b4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"975942baee6a7326\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"830d642117a5ace5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"de7c1ffc17088e33\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"e439f1b2419492cc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"f7442de59b72af75\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"51580e2017f5b0d0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"edf76338b49608f5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"eb6140479286bce9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"fd8353dd72b08565\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"4643932442aa2d5d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"a6c160ebf1f2b73c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"fd59620401c3f120\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"ec9bea6280e34c35\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"ab7f88aa8b30e72d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"5ce4df702c10ac42\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"85047bae84196526\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"ee27be951283dca3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"1a05ae8174d68d89\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"3d6ad7e2e048f1b5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"e859c92dfacb1fb8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"84dadd33eb553955\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"e51649341122383f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"1e9d45132ac8b234\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"d6a8fade7c5504fe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"a9bb4495e67b6d07\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"0114fb36ddc57c3d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"d91f6206dd09d0a9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"1ee38a73a2b76967\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"70c1d3bc0912bf29\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"9fb8c63b44e222e1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"93783d3d983eff6b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"649922f5406c1c1b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"ea3285d0a6363771\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"1c8abc6db7c0c612\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e82094c910438f17\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"9f4a7fdb7c7665d3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"2bb5beb2730e6a88\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"044d7d7209603c0b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"5106caa298bae212\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"b60f45dfbd68cb8b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"b92cd572e9a772e9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"9fe94a19275aecda\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"6fb40359b0429299\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"ec404d301ad3d8e3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"5f50b57b3b1fd9a0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"5abb8215776ec715\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5e8ee016e77eb68a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"a0bb096b09b2c7ce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"33bf85b1316ef867\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"c3574a5bd69aeb73\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"d2604c019598bf4a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"77c2091a5307db9a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"ef31cf982086c9ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"2c43786ba94b83d8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"263427f89d40c311\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"e085accb32f65c8b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"35f68564928063e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"024cf20362abe95b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"da76260ad841d059\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"8ffe1162407a40b1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"5451c56f91986e12\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"2ee2b9843cd3c553\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"7bdbe5adbd2234b4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"e180210ceab19713\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"7ffea356a32a4b92\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"83cb088bd445c7f2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"b5c0a79c5f1c6fe6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"d8968e501e1e5523\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"5705a586449ca078\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"43fcf593d1b3df1f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"eb539825f5e85be0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"5aecc55811c3bbce\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"3b8c6fbcf23117bb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"be85950cbe325b3d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"7ce7734e578f20fc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"d37ffe2a72e42103\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"4324a1cf6981d904\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"1329c61f5a5bbc3e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"81804ed8961ad319\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"3ed8e5270de6b638\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"91c29764fff11692\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"bed2995f2267e288\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"4804a2c94850f572\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"0642f1136df377a7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"db7fe80e610079f6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"cb0269a9ec383d57\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"acfa7a0990949ceb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"295964917c3997ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"9e8bab2c7b4f3dad\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"6c71e34253d3c993\",\"/knowledge-medium/pr-preview/pr-1862/src/data/refTargetComparableProperty.js\":\"48e09a2168a0d091\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"31580cee7b3c01b6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"2ca7abe915cbc798\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"a89564c4245c6e80\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"f72ca0c199aaad3b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"67ff796bba3ab5dd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"715441000e801e4a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"aa2f041a9553a885\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"012905b31304828b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"c4e6b4cd87dd22ab\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"3faab66e8892bc7a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralInsert.js\":\"6fb9dfb5990e8fc8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"7395f779e430898c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"c2eb07ed6d4b7ef8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"974530ab7f3ed67c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"da7763f5c5cd7d22\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"f8b7acc35495bb4b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"5a2629eb04557c80\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"b4709120b2771f8d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"a84963e60114a610\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"8e3b7f1e155de076\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"8a4dcfae649a2dda\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"a5d63403befaa04e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"bd996a156e17017d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"e73605df428a333b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"9904558c547099eb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"ac754985ac70dfbf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"5c9aaae495c8f040\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"ba6c675484f24092\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"5d563147c53dfa5b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"2d6807ba18f14ec1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"144a1f5c0aa782b9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"8d24d939a4958991\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"f76b5548b54af0a9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"b478a3db5ed82db8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"be4d2119ff72f16c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"3d9649c9b5a7eb82\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"6a55bd7a203c9ebb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"79e286eb079686d1\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"9760094f53690396\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"7da0d49d02cfc927\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"b214731caa2c9e27\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"e2aa0e9a248cff16\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"b6f37be638e117b3\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"cc7d3fe9286c3538\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"ca41a22f1155d2d1\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"b0baae633047696f\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"953c2b22dc3c1b7c\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"57a4dc06e9f585d4\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"18c4c052b197d61b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"3a56f8a6511e83b4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"c040463ee9588998\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"3f2a82c06e34dd8d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"8d176d48cecb7661\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"0ea2c82538b49afa\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"f093fc20b27e24b1\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"0b30c4d51e923f0f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"b233a0366b81ebb9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"61dadfdafebc3f0e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"65566085005c38f6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"c3d3a00ba3a91e12\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"f165a03c86ae1547\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"9dca835fde3d650a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"271400fb3c806451\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"5bdd0f8348de40ed\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"beb6faa988d4e64d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"89c170af053cff96\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"672fa3f8324dfab1\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"457801bee8b00183\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"5e3798b3a14e669b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"1b2c08647df33246\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"24b6a2e5a18dcdee\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"de52d07114a3a997\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"bf8aefed972835c7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"522203aef5691438\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"bf15948b62344e94\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"d7064229d0e89494\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"e180842f66bcac4a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"f3d5b817bf77580b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"89e74350b1c4b16b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"9350940e57755960\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"c5bda498ec80a339\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"6f1d1c7f69bc6030\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"fb299a33332f8ced\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"57af5ebd664a13f4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"fc94b698b50adbfd\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"dcb87f9182e49d32\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"3b6999593510cbcc\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"0c2fd9617087bfa9\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"1bec0f6077e66f51\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"5263ed34edb093e2\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"c5f062ddae8d1878\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"54a724443ce9cd8a\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"7bddf3724193af4a\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"51890e10c0d46964\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"58dcbe5f91cac9fd\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"7fee47e22a76e8cd\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"9d3a420b590315e3\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"eb4468b7e6e7f29b\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"af3d286c3809b5af\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"de7e90d55aef4ac7\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"5ed9aefa6c3a253b\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"8f8f78a8b81dfd3a\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"5e470d0d0a27f327\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useFacetValue.js\":\"e05b18727d456966\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"7487b2cf3a0bb3b3\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"656cb0956dbeaf38\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"681b53a8735bef99\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"5155827a86057f6d\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"4475bc96efa9f9d8\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"310c90ad37ffbecd\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"078a4e40aab4c3a8\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"72e4ca8355ed1bc2\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"ad4884e4455843f0\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"ffc226a6af240754\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"d7939ca7ae98e358\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"538d7090b3ecf1df\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"28974b6482b8242c\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"19f7f17d4df03196\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"a87d39ff3370e3fa\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"58b9cebc1c48be52\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"e8ebb51320ab1075\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"4a83440c5031faa5\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"0de352ed041ac312\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"ca68a2d4282bafbf\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"0492a530032aa733\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"61483a65b545b87f\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"62a32459b4072af5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"13c999d35e758a20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"9281b77c2ee086a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f492fe3604517770\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"a17dd989e5e5e20a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"6f832ab5270eb2fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"aa950e1047da0b23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"22a747328f845127\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cd533401237d2079\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"00231857b1f65753\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4b86645b13d041cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"298eac8df6902d51\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e0cc4e045218dae8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ff7eb48001a7d632\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"3f686d14aee93b27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f3d13a49237a9c44\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"26f02d7f1d2e1774\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"561043d6e00a5c01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"64bbfc75a4cfc377\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"fd42f118cf85710a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"22427f7e15222d35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"60349a3e229eb33d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"f13a53df213f6ccf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"504faaaa2ad2d3e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"0ec15bc9ae90ccb2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"93fe1271d9f484df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a419377715f7f1f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"ad3983676f072fa4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"141070d305ee8598\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"448a7b92eb6ba4e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"d97b7df92f491148\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"4caa6ae4a28ab9d2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"dfa9f8e7a01fa594\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"676b79601aa5effa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"95c3c3e6609d6a9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"bf8f7e76af4aba3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"ec2e6e74d8e7283f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"c07fd101700a364f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dayPropertyInputs.js\":\"479eaaee97195ded\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"33d76ad5f0b3e8a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"e2f6f8185c8805fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"b2819c91ced958da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"84522505e58e459f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"62e3f8b498a8da7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"ac642b37319a0c72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"afad53a6b8f4e18b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"e17b38202109716f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"34926dc61a5fa1cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"827f13e0f9a4dc6b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"64726dfb91e0a50d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"615efbce2e415d85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"8ca382795bab47a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"2389cb7a3d78d317\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"76cdc60912ce3184\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"2ae8ad41423e1f6b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"823ca0bf58c37499\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"673867e44a8e3641\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"987eeefbaa64a61c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"545d5dafcf2d6851\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"e2dab61dc1a0401f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"36c0694172cf36f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"352d4b47e7310fc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"1e12f4aeedba9fcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"22d5c7060b23aa5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"0e4d9fe810d3aa81\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"feb4d61fdb3667bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"822e95693d64f63b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"840d94c7a9e0e36c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"efb5436e3abffce7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"7899cbd25263eced\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"c6a187f464edeabf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"9527e9ada2c128fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"f1112516fdb3a586\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"874bd5f052e9b3e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"fb2fb658ff553ec6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"92ddc98468eef8b8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginAnchorLinks.js\":\"d8930517428655de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"9048ccd0dead2c01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"16e59a7688d1626e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"9d91b34488b73143\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"78f4e167245de44f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"d0af746f87f65690\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"7e67cb9681f79c9b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"f57ad2f5642b36f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"bbc3ba8a62abf07c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"02bbbc0ee3a5b67b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"bc78ecca17a37f87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"6f2e771f8ea56ae8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"7825b0210f0dc2f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"9f3aec665b3163aa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"cd6e8ee7d0f86e7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"ad8534fca04e430b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"503f28553bb6946e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"0d68ecdcbf05ca25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"ff85b7bd1390219b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"f6462b885b0f4389\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"cf961b8742097495\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"a2b90689a7972a82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"b37f3e331baf21e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"4b29764fee2ec770\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"584637be48766c20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"15ec51febef9231a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"f7e77491ade5c977\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"10b8858b5d7b04fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"b64c742dead6e062\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"ab441b5ce66d4330\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"b3dd87dbaa1825a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e1ac673d627986a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"bd4bd222383f8d47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d1f85abdb6de156a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"2f03c46420e41fb4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"5164b8872956b496\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"2710843c1649ec31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"5b5083e545446e60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"10fd3c3a14104da7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"9df86c5c775f6e0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"98f08515d7a6d321\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"e951872ae32b77af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"534a84651c0467ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"d35c649827dcbf8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"048d75861f12102d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"0435c5f3fab3f1bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"85387ad8a7d4fc1d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"55829a0e34513258\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"c081ab3239f34331\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"7287e4e0df4d3704\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"cee63987e0ce568a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"01f9cea48084354c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"aa8dd26a06d9a40f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"2bb3768f67e342cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"2981a5df81bdc11c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"a47a18e980966bb9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"cdaf4de2bee33303\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"d5c95501125c9ab6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"43ee99f82eb252ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"1e8a269644a63c07\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"3f9d513c8d93f397\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"b5207dce81dab4fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"6d8c36f88c3f2346\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"6bcb2dcfcf703dad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"51b51b113065e303\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"583a5411fbfac030\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6c84f5e2ad0dc141\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"44e7e64ed27fce6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"394ff59e52c1a84e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"e4465edf41fffe10\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"71ddc92c180eacc5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"e93275bcdce12595\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"942ffcaccfecc06e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"3ba765128838bca6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"81d4cbc558a98e7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fa0c006d7f1b328c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"778696d4a28c5bc0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"4b718e3b851afe70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"17f4f8d6dddf61d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"a3e8f7e5d11e6420\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"c7d02f77f1661356\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bbe4cfae5015f7a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"fb77ea33314f6c86\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"6b36cf186c7d3ae7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"0de83125777de81c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"c8a00d41c70f8f72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"61eb63dd984b2e6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"fbbb52d970f39dd7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"aa7241f876487704\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"786db42dc72f5685\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"7b504b3d35526158\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"44fff0a922e5a9cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"9195cad96a86ee22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"aee8fdf5778377cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"9ec8c8414584323d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"de0ce9365440f674\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"f3a19e597b95506b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"c3ce298748f7045a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"15d6fecfda723159\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"23d2cb02af92f8c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"f364043be49f43ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"db92cbee6cb90fe5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"19fe5717aebca1f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"c56913a097e5873c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"4805308d4e5e75de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"b08f0d3ba7e22177\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"275d9a9b07a9b8f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"eb87ec14f6aa0fb2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"b22e78bd13e301f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5a51b6a74e778891\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"41f61709f71bec5c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"89617e8f711fc9bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"d341235ce35dda54\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"f2e10ce7d4f17dee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"32fb071863d8ad39\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"c8a7554274d70bc3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"00092060cfedc522\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"29337d6e547278f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5dbc794f0fdd14ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3df2795fa61645a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0d58713362b0c76a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"acfa807e603ee839\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"57962361dc6c2ff3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d8ac76d160d948cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"8ca83e051829bf0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f1f52ae840fe82bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"65c1d787b8d97029\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"acbecfadbe72b917\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"dde9c64cca0aa27c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"b18358908f5473d0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"3635c476bb148284\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"88c4cddb0901ca40\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"5b92d2b27dc5290d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/subtree.js\":\"bae9fafa9b9ed758\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"004c56a47fd299af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"49c522e71551c7e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"17685765837a329e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"a855e3f1a9722fbf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"d28294545d1888dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"b84ce924d5d28837\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"6e73937b6417ac8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"bafc8ddf7ea9c33b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"0bdb05c6896592f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"12d252726172d824\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"9cf856cd699efd7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"3aa04bb27ec93be2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"a2b619f758800487\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"550e11372192dc35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"d723d51fb419b3d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"cec36a6bce8cd865\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"96a28f2e68580781\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"687007aa31681a25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"e085c42c8679259a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8d576fe825e5f76e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d8f446589e4395e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"7f9465152f17d8ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"943ae20f1e3a05ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7df3082395e076a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"bb5f475b8b310300\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"1ad9fbf29788a2bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e0ef9390496c1804\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"6b709d8ac65f59cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"d4b3f8689c8d6fcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DayPropertyControl.js\":\"30b068ab4a517561\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DayValueReferenceControl.js\":\"8dbc3396cb867efc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"49cf7be76452c9c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"e949980ca48880fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d9cc27850452adf1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"1e4a2a335fcdef06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"84191cf00e5adae1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"6de4583e2804a087\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"9a6ae70f1971f6e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"b2d5d42b0c074cae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"5d6e2d251492b56e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"fdb10301b332c386\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2f24ef0753601318\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"41624588c93d7365\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dayProperty.js\":\"d3a674a49f22d816\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"755792cf51837e9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"3b23efd0fe4c9290\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"850d042ed5aaedb7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"e5ae445ed6ba1082\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"016086fafbd4c7f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"c6c859f32c14f002\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"69e3f899a9985d19\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"42f96ff24929a860\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"660e4ff5e8385d85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"a60977e560fc259d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"daee5c35bc52bcdc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"1c4a020a718b89cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2b24d4ffc26645a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d7855411d47a940a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"737751e859fbab49\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"8f31bcdd478907fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"83f6e4aca12cddd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"c366edd1dc3533c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"19269dd83aef322f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"011799d494e9ab57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"85b520ce300c748a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"80eacafdec0dead3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"2323a1f70aefd57f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"52dc65a82def6bfb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"825c65ea6dac7cff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"9e81e9af90b9ee13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"0a50491de9666659\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"3fe36c39f36550a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"952060c2e5a0866d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"a4bc82a3e1ec7ae7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"27f931727d8e47b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"041c968f84cecace\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"eb0e3b17b7275cc9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"37e995505d8871c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"7251ce4faac9ba32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"e0c5951c5ea5703a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"6e4ab515f0d37ddf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"1c861c396193e951\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"01f15ad3be75ff61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"2bf80aed67cd22f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"b3d801a82de49ec4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"5bc2b745de2f8ac0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"7ba8512c2ddc650d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"136e06c47099d008\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"dab969d6acbfed77\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"bb60d5bdbc36f979\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"e248448d994437c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"90d9a1a50d4a80b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b42d7e2c512d7920\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f8cb232183f60b57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"a22ed743eb5b70f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"9d1c49289386bacc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"b8a18883dd064c61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"d4bf31bff0fe2fd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"1b8080265fff2c39\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"eed950617e2a15e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"dbc01226db1124f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"2e9f96e0e80c0f90\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"69a685ed4ab4207c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"9c23e86a680f2d1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"49a410ae87f1de99\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"67965606ad75d669\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"d014182dd34d6239\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"6186291bfbcda429\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"75792645c482da67\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"797d152b4f393198\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"27a3d83ebc6402ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"86697dffacd0ea9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"e2300afd648f6062\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"dc96afc58353f78f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"9f1508a104735191\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"4c25027e07b7a359\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"3db4c63cba1f138c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"4c47ca130bb7685a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"c13f3aa239f78023\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"5fdab7090eae54d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"685ee2940ff78e0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"93ba82e4f35cc2fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"de62b2285fc761b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"36a7d037bde1843f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"78952e69b66e3963\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"59427af7ce61dc82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"e0843b5e01a6ecee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"6892cf3adf4f2ef4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"b6b9f4f99f3b310e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"c4fecee3aacfc661\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"6b8476601360a8f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"11e0d52d6e5c3bad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a4eebadc60caf2f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"bb2b507a1053543b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"0940f5f1d42a677d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"4fbcf67882e44017\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"114e9ab177e86f95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"2d79beef74252483\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"ae0413eebe9c83c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1ae1d3d1147ce15d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"9e466f02aeceff8c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"fda3b95371a2d994\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8a05f8ce4729fb94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7fd100d5b56d7660\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"5c1d3d1f8f58f542\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"eb480c934672870f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"325360afb4ff4089\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"bc6986bdb52714dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"b20411639e29b717\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"35a5c61c3bba884f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"dc3d640bcd61c003\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"b8e6420db9b57a76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"c3990f6020ea73ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"c84e761aeaa5c8c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"cf5de7f1982e98c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"f56144587f7ab6b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"0919fbbc7c9f5c64\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"81899e8bcc6f0f0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"f391233adf859a62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"5e3ce3a53c35485a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"f80ae365a22601c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"b46c150202a2a7ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"64fed1c07b76b604\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0e7af7dfc8d131bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1b01e0481207bfb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"9203092498ba6890\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"916d122c47bdb878\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"0c22bd301a31148c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"d672b0f43e8d90e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"56f38f0ce70c234f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"0ab7887695d8c23d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"c1d90e3a948f541b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c20c1cb74d377ae8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"9e3f74320aef4538\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"0626ed774d5ee39e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"fff26d0a9f2884e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"972e135f822d7990\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"148d1af7dcc7b852\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"05bdc12d24ebaedd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"e9eb8670fa0d5e46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"6174ffe66139d496\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"eda323d678869df8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"8b80b315bfcc08d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"ce00bb1a1ea0ecd2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"07fd51ba5071bac3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9d34c0a7eecaee24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"001d9ebac56181d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"bdd150e927f3b185\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"f73e8ca6c255f831\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"519c364c63f5e407\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c67e379ba986b2a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5aa356f264c2286d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"02f30280f200c132\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"7c55614b54906078\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"393b4e245dddb447\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"157a3b3226642068\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"3d9f5d67715da9e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"450c0129f8a6f590\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"a05d195d5084cb50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"387275f56d1f02b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"218667c41c05f981\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"8c7e2be8c5cec7e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"80723766b5621724\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"0e3218c8e6540086\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"921a2b3147eada4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"31d8c3519a43b4ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"d7a4546d1d637fbe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"f21c2351217fac95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"99d8a6f105d2585a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"e766b921817f90d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8987e2327c15de3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"28016e1553ed211e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"f549be67e0de9bfa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"684344494aaa3ba4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"0277bf2cd528c454\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"4130f1ca380da56d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"5f6f8e23087f5fd2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"8af83d9ac6b79493\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"8bfe2f62044c06b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"41631abd4fd1d578\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"91d38a3528f32706\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"2db649f7e3d580ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"d54976bf74e170f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"8f5dfecee141a4af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5ed7766d926c1cbc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"0add14bf7ec115e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"66991f9e00a55a1c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"827c423190cb99ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"4084ea1e09f9b6c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"5433d1018fbb7a87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"746152cbc2f072c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"1b3d10be50429bd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"62f5aba82c1feb56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"e57376c53b3a5915\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"13411fa9e867dbcc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"2de1ac282e6e1a1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"d260fe2b6088b0f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"5c3fc4b3c5364f11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"a024da99585e8219\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"3371d9aee3b4ed13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"a3d69cfc0705b068\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"eaff2eeb3c230ac0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"ff43b0076576e770\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"ec08a52f34d7d33b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"2e0f8e3279a37344\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"d60635ed062e72de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"e636d9820e535f8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"19f7ef8036ba974f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"7265ea5e9365d415\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"e400e5bf3d09d609\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b103d2f7528a6c68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"3119280b7d1cfefb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"ef3e72a8bdadcc97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"dac2bb753c807382\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"a0f898614cd172ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"a992f769812616fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"9d2c2724e9dbe714\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"4cc357700f76dcc0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4b005ae04e705f18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"9082133ac4988834\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"376c9aa7fc9f6f0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"61b8d3b165bbe47c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a5296f27988429a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"0981e6b77edda447\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"f05bb2938581dca3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d49fa4cb4431f3de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8b08f967f0b54c76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"b678b949e9f7101e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cad26ba70afafbe5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c6d4897a98cdb774\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"f63ed260d0b88747\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"8a38b12149a42ff3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"6ad7bd093492248d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"bd8f57ed7597f2b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"6f1a414133b72dc9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"483d9f6f66896791\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"377acb0354b70f46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"cfdd669a1c9e84d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"502fb6170c9ae5a5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"22f7e1ad61c1c94f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"6c6aedf2d6b765af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"b8d19f2921f3d2d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"0e54a810d5b22123\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"b52ddf6465810a7d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"ba1ee0e69a76474b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"1701b5cbcc4c02a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"d17fbe9ba572ad60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"3e17fc40b0d39b50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"1182e2a70a33e9db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"8a8969e45f6b1ca8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"fe085b107a0b838d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"ac5938e4ea6354ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"23073875a6d699fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"f0f9036f11d40063\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"6fe2d2fd9f8c44cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"569c7495234d7547\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"39852d00a804a573\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"d59f78ed26276521\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"daa74757cf6a7b33\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"10174b40882172c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"1d94a8aa9311fc8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"eb5ff49d33dab33c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"e07aae849317fcae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"4dc1327370bc5f38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"acc372392a9f5485\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"d39ed1dbbf31ac22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"a0667cf715161340\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"11a31a6fc6ee7b1d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"e96ecc62b6b6f3ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f6efe8872c7e71ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"da3d0b5a3739eff7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"cda34161f95cb06f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"626d5d8b46665a4d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"e7052f8384dc4839\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"98e4d3d59e05cc34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"df9d53762830950f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"4ba5a74b7870e985\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"73bb9316175cf1ba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"5bd5f60baea8a285\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"6f6bdef8f7d7ace5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"5abf633ca01d0d78\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"7c56c609300824c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3ad64d77f49bb6d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"62327bde532740be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"518f710db6e6a74a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5417d9a0f8852344\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"3e917132108f17b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4176e23a74cdb213\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fa00c17961a047e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"dc816754991d6199\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"f8d6081432534697\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"933d35585cff1265\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"051bb88d838e5eef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"c326e5658c124d76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"80e951153425ff99\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"7ed03c0ffb5469fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"7719aec9cc7efff6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"3a3831feffe09957\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"a6d9951b9f87ce1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"667b8964c0f282c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"3ac797e5ea6f776d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"aff67c69286814bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"3e47c1c34480ad6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"4182251cbee51cc6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"efee5b06d34eb519\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"a1ab6f56a787f6aa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"cf6e7e253ba369f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"c159c8644472c0c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"1e40d8950b17f81a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"322339ce645c1f6b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"bb24636b755a80bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"0970928a6e535b02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"c4ecc5f551c9cc4a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"281e925f615c316c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"918fbcf36e678395\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"e39290a91d7d858d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"926e8f78c8a3793c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"fed68ef3d6af4467\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"672ae9baea767702\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"dc478d93c124ec35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"767251f82028072f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"8b58edd3236f9b36\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"6ee5e0adcaa43b04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"29dacf18b040d78d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"4903b01a11e24223\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ac828ad1fea46bfe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"4a86be1d21d6b207\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"33e5f52de3add37e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"96521b36c6a8354e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"6c6fa246269275e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"5fcc37f282995cb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"8afb54b71f7025a5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"635b4ccca1972b31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"214f44e4bc7ddd70\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"116fe008213a0546\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"cd483418973e9b26\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"8fb61c1f49e33bc3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/childrenViews.js\":\"0df836e21fd914f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"27fbe2612ee4bdd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"5fc0e3ff7b8a5f9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"47549f72eda5b566\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"e07cfeedf46a4c8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"3bbabf3615c1a98e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"de8b248fc0c04c04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"769cca9957982204\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/QueryText.js\":\"1927c1c9dbd0ee4b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"f98486b06aa4a3f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"6d7856b04e9e217b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"35ba6aa58c276f57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"abcb455baffbc8ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"079a92d60279abd9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/registrations.js\":\"019285b00d30af5e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"d18dc757b1ba115d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"e0e8510090a93517\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"b5171a9d5e11cadf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"777c1bf545e8a6ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"87aea2c2f477a38b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"fa25c289ed4b484f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"64327c8e4024d7cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"2e47656f2543ec87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"9e5cdb6352c7413b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"fed67f9f2f8a5504\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"3f9e65be2fd0511f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"8530cb9b43c8f1fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"f84b71177f1ab75c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e7b2d834c17a3759\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"1a4ccead2a1111b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"188b7ad0db31b578\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"c162096a942d0559\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"bcd19209e7db5765\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"9b6df68bdb528cdd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"e6f865716d0a97d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"5d4c1f8d92e089f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"7914a3801f480dd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"ada8eeb9e2709a12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"47f14bc1168517a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"c05da1fc9cd6a608\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"a5bfbae53c77cb3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"dd986852969c2c9e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"db5fbbbde4a4e17e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"81729a1f6719596c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"42810d8838186e30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"9ba1624c0fcf7abc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"ceb37408dc0639af\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"897e762ece767af4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"dbca475cac3bfc7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"18d2a118256f7b35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"48a89dfa49f8d057\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"2922a489d6d9c662\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"e0965e0696e52bb2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"105aa3212c52251f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"165e9212f2defa7c\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"ba4d0cc9096f131a\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"ae9ada30145a4ba6\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"eb9a967815908129\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"6307c89fe2e4cc08\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"5a15bf11488997af\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"163c733d4a1e69db\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"b28c29dced4ea5c9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"fc9bc796182202cc\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"0b88d5b178992458\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"cd4d8f1c9d92ba7d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"f0ea533ef0870c23\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"9d53d611050766b8\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"4322981458044fb2\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"07514af70a5af7ef\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"d5017cfdb1e4003f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"d38eef17e4c052e1\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"06254edc22c3297c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"fcaf22a53e68b3ef\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"1a94275def13a1d0\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"e96f50a20dc5f16c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"9bec2bce63dd64a9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"8e02a63fc2590ed4\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"d10a9aa9c895612f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"ff93da0cab70ca8d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"a2a7ddde3ac3bf68\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"7613e16ad18b4bfe\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"8c4591974834d195\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"ab17d18950a21a6c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"1efbc518ffba8998\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"2d3701a37464cde8\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"ad5f6c4794002ab4\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"ef7feffd0c5d39bb\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"daf542d4de73386f\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"31482f27020deabc\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"d8ba91277a70c0a9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"d5cd3e94e83e8d11\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"4cf9fcaf717b431c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"84edb21845acc90c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"55b4901b23743640\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"bff6502d1291a87a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"51f180e53efd6725\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"e54e440ec49b5428\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"ca80d4c198f7abc6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"eccc4930a2a8b8a1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"050dbb83516f422c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"176f727876c91201\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"80542601c170f186\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"7cc03b639289d6ba\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"ed95d8c690187dcd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"026cc1631c07e930\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"7715bfd114655c3a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"bf79e446f323e396\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"0901b41ec53159ce\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"dc646764c4ffc770\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"f16044af8226a577\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"4d667d8cc0294d81\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"78aedd89d3998008\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"3abd9006ca04ade0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"6aceb786cb18cc26\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"04223d56bc2bdc47\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"bda6947b573cbe39\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"14ec6f24a422aadf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"1d9a25939e168ef2\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"7a9ca1e0b9ce1920\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"96da0401e7da312c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"8fc5b42549de18c3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"da6c0746ad35eacd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"e5277eefcf1a02fd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"4057e9d4b8f11fef\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"e55923eca40274f1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"10649d4aa82ce8ef\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a3cc4b05402c32c4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"fd6ba85cec846c1b\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1922b9c1d5b69e0f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7d73306ec0cd5ae3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"14e4d746b7678bb9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"9206cbeae72f8910\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"485cd77fc6959e33\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"e79642a4bc218933\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"fecddec697b15b3f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"26130135d74740d7\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"64e6e3b4a7a24581\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"155fe729a66855ef\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"b77f28618b230318\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"02b4b1581b6f28e8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"85841414989f2b68\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"7dfa4f3cd5e33f33\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"82513cb09f66b02c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"3b727fea637ad6f2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"444adda852ec6b8c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"158f3576733df88f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"ddecb0d04e87f897\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"958e16650c85c7d8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"26e27c495723f4ed\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"fded0164b434ff62\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"d55ad8ca6c72eabc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"2f5cb788bb5aa512\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"7952b5192b03a84b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"a15422cdfc1328ff\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"b709e1a773956bea\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"5765260976c6b546\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"5a96b60c92a95edd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"d260139b3f8aa4ca\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"db70fc0c773cef33\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/drawnWalk.js\":\"7a24bf21c01317eb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"779200b6d4bead40\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"acd981366cb2f1b3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"17812dbb53d1a3ba\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"05ad3f856123af3a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"05e6c1e353c82c44\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"ae0722fca80fd509\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"cc6edcc3b061d335\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"30311dc4920b6722\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"6eb9d97c8a1306ea\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"0025bccfd3625f4e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"7ad287f79a508c40\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"e7e1354ce5571d36\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"7b4957ce428041f6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"55391c46a614a907\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"700cbc9be1cb6f86\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"90fade5a71a7a477\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"73091a5f291e9130\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"4f3ad4c84ec7219d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"54426557b0e2d047\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"edb3e30e9b6a507b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"1f2bbe035de56121\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"b06b65d73b87d850\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"fc217d94959c4641\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"499321eb918022ee\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"ae6823394a76ea42\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"9b341660c40d9805\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"a1d668fd05f97f11\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"d34add615706164b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"16f52f8f8d1e6dcd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"17043feace552110\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"bdba98a8d04780c3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"945e43d286a009ff\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"95145171b900dc36\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"663fb0ef1a30f26b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"222920361f60c682\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"66dc629e083ca669\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"454f13ccfc114479\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"129ebfae943e4aa7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"7bf9d43ce43d5720\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"d3a289dd23ce9198\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"09e8d278cdb8b74d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"d0fa39a1a4b7140f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"5e5a7e7559cf0d50\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"36b7be6054e59adc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"fc35b6dff24569c2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"7d6c781478d31810\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"8401ac3ad3640717\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"6746ad0a0466f8df\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"deb1ffb58772aa56\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"3854658ab457690c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"328e73f4d2828676\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"c2cb8469eeb1aab7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"ae98816abef6385d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"f1232a66ca64614f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"db461cd6d9080959\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"8d9c5275c8599408\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"4115c52e5a5752dd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"dfcb0ea413976636\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"b6743ee2459ccbb2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"602324e37acfa737\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"cc5731115bc29cfd\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"f0163273c91ea8bc\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"3df136b9bcf65731\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"aedd2cc494f01107\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"39bed541b12864b1\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"6f4bc983f0596fe0\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"9e84d2997295d797\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"91402e9dbd9f34be\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"edd86feefd206a24\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"96ca185d445c71bf\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"98fe376056e441ca\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
