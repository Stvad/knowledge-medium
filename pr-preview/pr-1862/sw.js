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
		buildId: "d17eb11fe021-5588d54e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"6ffaeff71c32fec1\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"6ffaeff71c32fec1\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-jJF15_j7.js\":\"e061c76b3cbf3e42\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"d9cdaae4fb129753\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-Cxrew6VJ.js\":\"2fc4a7b5f0f21d55\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-dIJcS5or.js\":\"1cea21569108a5bb\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-BoL2XQSg.js\":\"e030fe49fcf7b0d5\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-DY8amMqB.js\":\"7859fc66c5f2546c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-BKlYRFOX.js\":\"2f15f6cc8684da5d\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-B-_p4uMs.js\":\"05939d3a4f7ebbc2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-CbxCs3dd.js\":\"77a42bd59ff7876e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-CVwVVCz7.js\":\"36d5fab2e4a6ebb2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-Bh4aYZQ6.js\":\"7f6b91a71678b536\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-C2ZbQa1G.js\":\"a7794f370d230567\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-C_i3_FIy.js\":\"6ea0d7de341ae2e5\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Cn_h85lZ.js\":\"16c266a2d944a176\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-CqgeWc3l.js\":\"ff6c2e34d372944b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Cs-TyHW-.js\":\"2c56cb37adea7892\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-D4kbx1zU.js\":\"f4e1bbb255c58769\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DFqJqLag.js\":\"13fe308641495d44\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DMEA5Na_.js\":\"775cc64916ef907e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-BEMxCrug.js\":\"c3fa19671299dfa6\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-gJm7wo6i.js\":\"26fcc0d59b0a0dd5\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-BnEut4ki.js\":\"1b45d4f9e063c58c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-CqFBw_IF.js\":\"625cf55afdb21e66\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-B3w04n5x.js\":\"ad308f576f463784\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-74ROykf0.js\":\"4a8ba0b3d71c2747\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"2dac6e511c264d21\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"ea84d069680d6cd4\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"dd0d2e1e5e4fa83a\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"65e5c2d84466dd30\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"c5d67ae802e31212\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"e9c05fb7ad47f7d3\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"28feeafa1a8c3fae\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"a3ea9d10937cfcaa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"fc613cac87c8c983\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"e64f33788f7b9490\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"038523e2905bb592\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"34b32bdf75c6d622\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"6a15188f946fcd09\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"f587903e75f6cf95\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"dc2ea6a6126a9b54\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"21bf58e68bad1310\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"737f12527de5b3e0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"9bb372481cec2d80\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"03fa9bc4fa24ff1b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"6ccc6b450957e4fe\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"7da6342a36cb944c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"a672293c1b4eda8b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3559760cc59c8559\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4258795042430134\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"ac16e16049ec7702\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"ce5445d8d25193fc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"b3608d4413d6c0b7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"063efbef60d47ec1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"4d75d8cc104f7179\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"4051b11ac9010afb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"ce4c83d40471d13a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"a9aa3e845737c4e9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"1f25b9febfb05cec\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"1d4cb14e228e0e3c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"a75b650dbf515492\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"085b936652f1e6f1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"1a675f519f265cc2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"1320d2a9fff7d96e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"cb25ca931e2f2ffe\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"b77332a83a0f06a2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"98af3002b4aa0efe\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"39dd811063f0969e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"38da623c7a46e1d5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"d1714d8bc08bf940\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"3e21ceb46d713de4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"58a4723fc2c2cc19\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"0097ee8a19c6330d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"72deb32572b043d6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"c9796a1888163034\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"f9fcb0b4ae65fa0a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"de7ef91796c2e542\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"428f70502d24c9cc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"1515db62fcf97608\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"1b2f351e01d1ad96\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"b5d3c4f347419958\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"d4afdfb1367a51ed\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"c61cdf738e050e29\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"b3eae1ecc6aee713\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"d14af44161061d73\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"45b4ddade2c83a88\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"15c14028c49d70de\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1b9e32c1b3c3d8dc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"5c40c330922864f5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"b6040ddb0d3c2db1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"657b443c23a433a6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"94dab8c1691ecd7c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"04f7dac70582c804\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"340c93eda8578d88\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"162e39cf1c3094f4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"161cfde8d648145f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"26e7e90399da6d34\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"ed016f9268608d92\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"a916a625745e0d23\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"e8ba8afbe122d029\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"809036fafa73dba3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"940e0b49ca9934a3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"c248e0c7987b2fc2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"ec7070e7abfce229\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"d6a9fb2a59a05500\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"50271469adae6d42\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"fd55707cae4cd44a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"4f11481fe21c9d30\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"9e8600fb2520fa16\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"2ac91de744c9863b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"24a7ad7c969fff1b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"593145cc375474d5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"ab1e27911435e08a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"9feb5139da56461d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"2f3cf37ef4e9025c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"af064876dadfd681\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"860ed43946412be8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"746554e01aa6c6cc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"3012380efcf7b723\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"d6270eab5aff0ad2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"9d0d2e5b896536d5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"03f654e3f5534500\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"0ee78e5d1a50c2ee\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"2c06f1dd6e66116e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"60a9ad68e253450d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"1235330b98863b38\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"1fccb63a77948804\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"50b1263b85c17042\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"86bcb8786e7feb2a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"97c3eeb6ddb5bcc8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"6b08a994a512807a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"3ba371d015ab74d7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"8c2a2e06cc873e0a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"883b794f8d59c1ab\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"1197428c17c1a85a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"42d81fdf763a10a1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7942828ddb04fd31\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"92afe8fef1437951\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"d933def70ddbdc0d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"1ff674550c7f9ee2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"2c22b88287815359\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"e7e1dc533c53a54a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"508a81ad720060e0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"aad158d75ace64a7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"25a35146e700fe7d\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"122dda1d4f61027f\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"60a51e24f6876f24\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"95359b32d0308a9f\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"a63a45945a4041f2\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"9bcb5213cedef31b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"bb3bd8a861d52a4a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"968e29433ac2d5f7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"e9b0e00412219c67\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"936957eb8249cc6d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"3f0d6a82d394572b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"97d445b1ceb2ee35\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"1ac48b4e8ed01967\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"06e6cad74e91bbcc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"a8d329d521feb8f7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"6481e79cbd8e8b4e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"5a5be034246f2947\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"7244be32ba630c1d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"3832075893cdba44\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"aaa6e1360d3267e3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"14235748aa57475a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"13f9e633c3feafe2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"6481e79cbd8e8b4e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"6481e79cbd8e8b4e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"1f0789988f542bc1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"b203bca7274fa4bc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"318d97e60d337912\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"358c8210298314e8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"e567495ac7ad4832\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"f98c7aa4372838bd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"8e0640515e51d298\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"66e04002094e8ae6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"6ae85d1915b9823b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"d0ab3b34902c2070\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"1dddc30b9c4dc12c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"c87ae4c3a78ceb41\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"ba8e01163c9dad11\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"4250191b38721b38\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"6c6fdd3a1791da7b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"ff91ef5ce52e2932\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"1b16345d287d74ff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"c88187d9337d896d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"66f7b3f7baecd002\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"954ee4dfb77b1ed6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"6f9a7c54f6ec97fc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"7b1358da6bf81c1a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"7cee633369c0a8cb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"83fdc80846c48978\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"77d7f3306f2fb41d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"4a032213af1ebf4d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"90feb7be30a4d6cb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"08d1b2190f9e2721\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"3605ab26db426003\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"80e95015454a980d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"7ea65c7e4b464c08\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"8c88af71778ccf1f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"6ba7e86c00b652d2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"544ceeaee8860553\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"e2886650275acd51\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"9c5650cb7fe7b73f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"a41bd3f97cd499f8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"128bd831a23922d8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"9f462e43a72b8996\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"a3ef342e8fbad7ea\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"65f4cdb93a108a28\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"73f7dd3bb06b4b12\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"9d650d89d40862be\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"5bf72067dfe26991\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"d7fa8612dd633848\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"0dd80c589d0f07cb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1892562260658681\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"fcf566008dd12229\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"0609d8d3aac13842\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"1ac01c710d76cc71\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"e4ad88f95e519c04\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"c3d21a594dc462e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"4ac24caa5f4c49b8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"06ba478858c64d8a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"509e22cd3602ac55\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"a9aec4f1340d1f59\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"d1dbfba8a3fd1240\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"85e292daa9764be7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"bd79bb69572de868\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"356c2894338c1d04\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"5d15546347897c5c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"f9c3a7d57d160f9b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"5ce345621930a511\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"8f7f1b25382bf7b1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"fcd3e5596238339d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"92a0a9546ce4763d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"e66307f0c6f9c82d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"f6a9b5c49432e624\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"1c801e881aa776c7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"7a37186daa0d28b5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"623eb1a7c8e35edc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"8b28c93aedfecf4a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"062772be85b194e2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"7dedaf26668fd2dc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"0c9d13427af387e6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"bd9ff5bfa90ffec9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"5094845bf15059b3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"2be0c3348f53b819\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"056286a23a2f08b6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"09f13549fce8905c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"7cea963628ffc2bf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"ae5b1dfeec43e2bc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"015acabc70881f0b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"50d34b50a73302ab\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"02f44f35b71873c2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"7988ece4dbba8d8b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"c9db3b63c616f2dc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"ce4efd4cb9b42dc6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"d550e5392563ab7b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"463657c2d0f47e63\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"7e6a2e7765edca0d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"197e1e3d8cb3ff19\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"3897476a80e8f9e7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"89c055cf121e593e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"c686e15b545accfb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"eefb7e38237b7cea\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"cfa1540ad9f3990a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"68e5bf7162b05bf9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"d89ae373f1701d1e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"bac70859d6be7442\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"e4fd786b1cac5a39\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"cc56ec585fbd6e71\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"2a2dd6384d2c321b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"ce907fa0bc70fb3a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"074d90fcdd59b8a8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"c213220421dd0f62\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"62fc77bc5603edb9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"81771e774a0220ca\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"edb0ac398a990a18\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"06bcb8f0f557c698\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"e1eb63ffd49194aa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"6304342ea66fb1cf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"ab90116e48dd0d1b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"12e249e780c75c7a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"e8376221fc8df776\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"a1980457d24928bc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"8eaba0bbf79e6e46\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"cec09249b56015ca\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"8e0e224318ea18dd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"d5625b8972798abf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"5fe34eab5780e9b0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"2ce1f36eba38b06f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"6f87a528cf3d832f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"6fa33e2ecf7e7bf5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"cce858de364ed94f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"a98cc964457f9b5c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"3696a2c2aef69ca2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"9887a5e8fe2ce297\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"ff56ca48dc05643f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"8fc82c375df922c0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"151983e2803af415\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"22f8097884df9af6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"c3aa9974bb2ffa99\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"0953a8e5a4a26519\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"a09820379645a391\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"139f168040594a9f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"52b14cfd081411ac\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"932c0921af2f41b8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"5e01ae4ee39d1dd9\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"e067bc27ed6f01f0\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"a8487b9a1b9c4419\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"0896e75f4ae5ea19\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"73dee820840abe3f\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"c39332251c26e879\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"2ccd7b554c82e3a9\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"e430573cf6f914e8\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"23c66905e22459e1\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"a58ed9e02fcf1aad\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"849e43c99cf4f671\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"1e5cc2f1bb400c5a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"008458d87bbe878b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"8571fafb117de0b7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"1df4dbe6748ef2c5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"68d86f82da9ebb1e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"6989ad50318a0f51\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"eee0e695afa4f34d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"5ebb16f0e269e1df\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"e34fc71e211b4643\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"4b6b4d52911cc04e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"afe398b0b8881bad\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"5f7b29da8b638c56\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"1bb3911694ff9994\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"20947fccb796c4c4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"c8d79d7610d30d0b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"3c529a669c09fae7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"d023bafdcc3ed247\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"149b8a025a5afbf1\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"87edba7b7b057a5a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"c1bd18c6e9608d5c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"175527886d8b2d03\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"e0e655da388d60e5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"a1b8ebc20a3715f4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"f5afa460a7b9f0e4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"34e89df30769354f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"e74e71c37dfee05a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"26916f49e939c7ff\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"d93493c7edec120c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"ec570ffcaf846ff5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"c131e8479811ef1a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"d26288d32c893139\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"c023c0596cbe5786\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"5af1ede19a7bc01b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"48030ada73543970\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"e4659ed5b2b9bec5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"503b32188be3a44b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"ee4a06667af4785a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"2a2dca865e373e19\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"e5640ede6cd54548\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"437e4c208203993a\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"28b1b329c9400169\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"580dcdcfdad3d313\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"3404b684d7cf1c59\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"6d89ca17dab71927\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"d14a5a0fe51455f8\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"e9a1e415ed85ed94\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"93d3220b7e644a47\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"042c1eadd66bfc32\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"0abdbe71aa27d7e0\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"4591fd5de7531af3\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"5976c4986e78ce5d\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"8512599e6ede8b4a\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"dcab5c3abe4076fb\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"ee634e068e2c18b0\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"46e61bcead3dbba1\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"7384cee41cadc2ad\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"2dd4b2db932806d2\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"285a475d92d796a7\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"f7a58da1bf06c0b1\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"9a006795e5c37e69\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"4f058e5e6325bd30\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"d730bb2728058e3c\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"8e5f7f94e7e4b1a5\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"37a6edd044caeea8\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"6526ed61796b5834\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"5b22148c29affde1\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"1403589176afa350\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"500849bcb6ca98d7\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"abf36b84bb027e1b\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"e47928491a71ab43\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"bf2a9482f92150e2\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"be1abc8617950049\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"34d295035bc718d7\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"af7e78124dafdbd7\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"0ab310161ebf7b28\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"1a0a5730ce7d0ac1\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"8465f290a028ab57\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"8004b61cb3aeeecd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"a1745bf43f89928a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"aa7918b3dd2a04b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"14072e15979f24ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"85297eef70eb73a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"2b6161ec7575644f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b36882c02998962e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"9a243062604e62db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7fff113a0f54795d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"30ffce357cabd8a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b778cc9c076dc914\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"0fd876956313e29c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5993bbff52323678\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"331fc973e5afd08e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"a737ca7c724e9774\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ef35a5b08d13ccd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"1fb1c24a20ee4e62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"e78f7daf38310804\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"609c938510419e2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"2f0f18ad4bc4af68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"be6a8e9b69114762\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"3979b44232336d7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"d36f022978d45f7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"69158491061d4b93\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"a7c89c80ff2cd50c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"d8b06026bc5b8f49\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"251215d6a93dbe30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"7b290995842780ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"b09dc542c248dca4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"24d9273251769f6c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"00e03dfe40ee78fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"4b84a17ec85ef735\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"8f6180d16ab774ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"2cc49ac8c971d2b8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"e783b567aeced80e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"79e5acc2d6590cdb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"ad0e0fb6fd2c70fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"72aa81c15c7e81d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"1aaa0b215ebfb0a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"4e1b3600ddedc73f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"1e41aa0cccdf12ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"8e54116e0dd95de6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"a9fe6346db9b8055\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"5faccd9c6872c560\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"46e0171270c6cc33\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"409a78549e508ded\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"521cfb0f79658cfa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"ffade949fec083c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"10c6b71dc69f4930\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"686c60d1dc535d10\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"1903acd27a23052d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"4a11373312eedcf9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"4702ba54c93ea4ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"0c14a2d6b566e483\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"0c7273200fe624c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"783ca95a253bd24f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"156465d24ac043ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"51ce972f00426656\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"ae474bd648053689\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"0f253da354bfdd68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"e2ad7f87654e63ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"472b439909eafd14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"05651c0d973e00dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"a3cd2c1898812b5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"3ccee38966051fab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"8a36484b82468a89\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"6d2ce1ad8b48c195\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"055a502864350fa6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"824e22b4bef518e0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"29c54b6594443167\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"126bbb00ea311500\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"70a1118e48093032\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"b50ef8b0e99901f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"df26053cdfd976a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"0fad42de08363e1b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"37f15ca2f454138e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"65f4fec648cc69c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"6d1c4c50aeadb2a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"9853bc5e8b27a9ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"f772d5ad4d384e41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"119505e88cb1f35f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"6c45cf458f533bec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"d945c79e761d945a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"ff45f73896016141\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"8ca79ae6421a65bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"1328e07cc928d28b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"a4380244fa731dc7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"7a389605be57f0fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"9d4e74fe3b551d82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"246db278438f82fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"7e6645e04793c407\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"aeb58efb6a6a92e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"b0fbe9c5f3371abc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"86dc8d540d856549\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"d3208099b96b497b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"684756dcfdeabbbf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"59a3958f447e1c17\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"b05e778484d1eddf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"97ef87f447e07b55\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"5ecf289adf1f7af6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"99085fc420f4f95e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"da749ee13b242a96\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"2601f1f2c0411f73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"f652c2e1b3f2210e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"500cff217b46f0da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7be876a4ae44ee23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"6bfaceb91d770b40\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"47378e30ccf47015\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"02f287853d9c642a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"6bd507b7805767e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"532c459de8d09a18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"dcd747bd49f3f76a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"b4a17b12992a64d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e0c552a01ba9dba4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"7fb9b8b5d28a377e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"39c401e7d9943096\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"38dc2ffe4d7167c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"a368bc100f0453e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"e90e2b66c925b498\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"179bcb0c01c4d746\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"1fc7d1c2c959a084\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"cd09e6941ec3b457\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"d47fc52af76f64c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"ba66c42953d505d2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"f3448bb7ac9cf0d2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"8aedfdf0f33874b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"3a1df74ab68adf2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"0f4f4bf3f2813d3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"cc18a619624cd030\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"6e18348a529d5fa6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"0b8d1ed3022f1396\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"4e70e2ff9c8c498c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"f31eb423c9b511d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"7ecc295f8d45320d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"9a0615b312d9e291\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"ddc24cba0417d8f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"9d5c2c8406b1b0d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"b93a2b121d954054\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"c6d8fe7195303add\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"5a6719079ecd11ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"7699e9b1223381e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5a5b1923ed16ca91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"113451b328775560\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"db7a90b44dec4133\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"0d8cac73084d53ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"8637c78b835495bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"aa784b44ce3449c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"ed9bf99d919df192\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"4649acf8c28641e4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"22172c9063912875\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"61c245cb43e2e134\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"5eee130d4697c7e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"190656556d8658e0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"ece152aebb67078a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"afd8f48d3d560dbb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f377e696cfe9ac0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"f27f9ffa175ecbfa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"8f611eba6dad9590\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a41c23bc4ffc560e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"c1e364d6e75f5baa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9abeee0a155b4aa6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"32f5ee897abe4e7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"45c16e877d4ff942\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"f633fb8a0cae5f4b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"b22e2f8f1e9333ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"fe8a8140ce6488a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"60bbc6c3fe593ca4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"ea3488259269820f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"34d675e77e4707a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8b86f6a996d07aa9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"e4dc119d57836744\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"cb45b151b6bcc717\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"c7b82897ca56cdb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"3a2b7fdf60c55edc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"b596bc044be30487\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"7dc32d7ab15b2e35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"e960772eb909befa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"4ba3a100854061d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"a7b53dc35ef23feb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"809cf325233cc736\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"980cc44d4e591735\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"5eac2a926e4673ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"f499a4bebeb33c73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"95ef5708a950aa14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"0e308f53fd7d0b8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"37c447ed1686d862\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"e72cdb15356fe0d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"66cab5b738ff4b2f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"2ece8acc3ea82e25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"7dd32509bf03a4ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"2a5c851dfa01c70a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"22dee7c49bae0198\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b7a1af2a2adedecd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d799142e527b02a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b1200ce99c593c6b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9f63accbf80a5d66\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"c9deb3bf9e1c4618\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2ec823f2fe863efd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"17567de6d27d6c3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"388c72cddd7124e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"aac19a23ce2a1d76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"b6a1075645c8c44d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"52bbab240d260825\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"92f903471d250410\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"218c0f00bdb6dd88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"f0aa550186bd7fca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"5a7c949da9328098\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"6a32007b54956aee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"7e83d5c468300674\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"a089256bbcd78e65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"6b15e9270a2db15a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"9bee140e960ca651\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"6cc4e7827a305b2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"d42f5c404d7dd715\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"30e0d168e1577a1a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"6abcc327ed56f84c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"ed1ee5cc4f18d3ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"ce927bb5c2eb21c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"f49586dc772be96c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"8f461a7c803401f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"eba237704773cf1d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"6e730ac1266d6b04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"a928e3b75dace7d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"f042712b6f904f5e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"f9183a0635e3b2d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"bf0fa443cc8b316e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"64ee350e77e13452\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6ace79706b47f310\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"ff5c398b992e06c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"12561b9b1cd56c28\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"20525978898c3ae0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"e89622f7ffa18b7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"99c9ae416f374f2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"45de4458fcb5a33c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"ffbb80b678257c47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"647d72fc2e1df0f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"9c0968d2e799e90b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"86df9dcf667643d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e8dfc3fd287dd661\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"5d143f7b933ef366\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"533b3fe1a44ff381\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"5b503bf3f4ba23bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"0775801909d99660\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"2a971960cf5cbd0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"98a81a0fb676e723\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"6b0f898710520de2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bce7cbf7f1f09cd7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1f3df9624107f4f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"1849b4a663bf46b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"54423a5a57628f4d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"6496307a0903ca58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"084770549d5675e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"7de965ed5134599d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"677a52b102d16690\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"b167241479d47421\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"f6d0f8a360b4ef75\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"7cf430f7512fd98f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"52b6e159ffdc0fda\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"fb2151ecd129a80f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"789b34ee995e2668\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3eb6485644820f26\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"9527b1a8f332540b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"455c69f73b29b4ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"5b5409e8921efe1a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"55f2bf134e1b8b55\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"aec5a854e348c5bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"61440baa676bcbfa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c8b56be25f0a4cae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"863d8e6c20279f1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"0a13a1b9bf6a87f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"55588efd728c8ced\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"9a192d89af93738d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"f3c05877d0403b71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"23a5525bf99b01d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"6369ac5fd2d76fb6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f41afd0f425e4503\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"a21307d68936fb1d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"cd4acefdebee39c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"c24f5d69c98c0e22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"39ca4bffdfc9a483\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"c410cccbb76e1134\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"76fa2fc56945c348\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"68c3708c221c8596\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"0299eb3d8bb94289\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"69d46d4b6d068b9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"384932b2e6365d90\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"4e6fe7fd3e4e9dea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"aff60bb6e4e482a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"b19aaa82d6cefbdc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"c5de03be4e12ceaa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"cad491cec51341a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"0b19c380e87d6ae8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"a4e380b0fab974c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"ca2b3020e33f5433\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"40755f9bc4fa2f1f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"96a5ef3f3a98f489\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bc5c74a801c72044\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"a64bb7fee8096554\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"7d982b69ac758602\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"4fb221fc7889ca55\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"365e1b695baa700e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"239a66678115aade\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a3300c1839f7fd8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"6bc010cb37dc06be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"cee3c6a2bd96aa3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"31390c3fe86df9a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"8619e99378e45107\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"6ad2d78784d5a5bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"bb831d5ca06939a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"d529d107e9a0b8e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"dd74ca8adbce4b75\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"0b8eba7688e36c61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"9917f4ed847b376d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"78e5e6ea1929b895\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"253a1e5f51b143dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"b0c52fcc211a1efb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"5b0850b3fe4f8d4c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"535fa9480ceaafd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"13bd35b5044a6667\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"9cb36f45a9d0f73c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"492ff2733997e4da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"a7c1b222a00716c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"39a73129c8b97f3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"5abd6bb933ed7bc4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"37e0e273766dada1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"14ace31511bd1b5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"4b3c61279428a1fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"f314324fd78860c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"f785e4c7a6b4a357\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"d7bf390d41412afa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"539b101cef0247bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"86263aef46725526\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"7af1a284373069c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"fccb4186b8358e61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d1ec4f9a1b4fe7b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1e3d40e6064782f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"db9a46a9db7ad227\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"5e8fce33704e3bd7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"459787a1af820964\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"82aad593d03ccd1a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"4a8d1a9bb4edd25a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"2f454fde04603782\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e1f676588bce0c3e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"cc3d5c314b42a8c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"7c3606af1dc10ec4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7dc7b9d8b5c2b876\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6e04ded68c628387\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"dc05c69f66a77552\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"59b836e41a0c7f5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"d2dddcc00870dc68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"376978db10b63bbc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"a5f3cad3b1f8d890\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"96db7ad021a55367\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"11c37f727256dd3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"a7659760927454a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"3c21ea10afe35835\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"410c30868d84f7e8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"deea6da591a940a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"7d30c1e1cf494835\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"5c21a0c651b7ab8c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"821fc64dbdf21905\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"70da3dc2c3c766c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"f58de81aa8dfe932\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"ec9dee71411712a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"92f3621aedf322bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"11feedc1e8474ac6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d135757e956845ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9f0c4e9734940281\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"5457b6c4db50cf21\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"fb8f3b23189295c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"20f7cf4ddbea3277\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"3b8c1000778b2263\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"c378ffa2b7359bb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"178d8981a842c423\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"1478d4dde2b9822e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b421743f87251e1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"869b85d191be131e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"d28fd0205829a924\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"6a7fde6060065340\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"c735dae20d3c483b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"428584e21aeef506\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"233c123b6f471f2d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"23e6ab4d791af56f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"615e0d0e10f5c56f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"0b2e6945ef5be012\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"8fc2f2cafed6cdf7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"25364d988acfb556\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"6fc09774bbf99895\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f4f716d14ecfccb6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"70414e8d6bf83123\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"99a77bede6d1fa41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"2497cfbdf79d9dca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8b11b42d378714d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"11107e77227f0756\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0ebed4fe596bc18b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"da838d4f97bfb122\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"4689fd1bbe490efa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7b3b472137f2b32d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8b3ce228edb023fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"45a345ee561967cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"88260a9ec6929a2d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"d869c0429aeafac3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"267882817f8b6065\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"2839e327ec327384\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"7ecaa5738aa85b00\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"31e3812c30a173c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"50ba260b5c698eb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"62233a1ff756d266\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"dea31f7961925985\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"c368592a50799b28\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"7546bfa9f7a92de0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"c4c4df1f358ea94c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"3fcdf336313fafa0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1a148640400f0287\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"c7daf05b4527c924\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"423de6601826ac0d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"bdc5fb987ab7ea4a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"26998862fe4d2b69\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"3ae9fa2868fa4b5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"b3fbfd117a6f8643\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"41056a8461e7b432\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"715198e78a5c32c2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"622d101b3e5a5f51\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"e2217702996d5015\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"7917c14393246900\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"b21a45e9b267f643\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"665f536065921da2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e69a15c51ecfd0f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"112ce90d770e64e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"f25a24dec1dac424\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"efc7c7e0c1e1484c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"bf21c89261809139\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"c583776e74586dcc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"36f825e890a787ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"5719b863ade6bd78\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"fd9be4a8f09eedf5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"30950430dfb1e9f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"72db3a0b5abde997\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"f7f4ebe79f167725\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"afa2c6d0b8da3621\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"5326107449aea627\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"ee68bebf4ec6fbf9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"39686f41dc60b499\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"c997f17ce45bd5cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"8810eb967bf8f2a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"c136334a698ea476\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"bf37e3d01aa6ce82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"401d51cddc4c89fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"d0ace5326ad16514\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"4b749df7780d85c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"30bcf538f9794740\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"3d38043225378fef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"37c20c8924a6b7f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e0d503ae1ffb3569\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"c4d3ed06b519b709\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"0de572fbbe0d65f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"0609812c90edc422\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"0ec08b6e301c4733\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"3469dc105072d8bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"6838e375068a094c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"ab5d7675ef5046a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"41a5f1fe9968f3c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"47212638a71b53c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"734702190d451ab6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"7cbcbbed24ea8e10\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cb17aff318a3f817\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"2716ba7d4057b93b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"ae83c56b11640e0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3bfa99182d31cfd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"37f1f34c67f575f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"f3fda829ce701c7f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"51d3dfc5f9e0e2c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"70ebe9e60feb37a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"080bc5768b152f1d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"bca16764822677c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"6d6f36697dbbf267\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"6f67493adb3b6bcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"e91b6db5270f94bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"4fc026381f437d20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"5c7c8b57df71ed80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"de65c56adc9e0ab5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"8e11a7f95de71de3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"54e0eed870d5a1a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"42c4f3aa95074bcc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"e2b4f192657db36c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"8f11dc11eacf2e38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"e77a967f4af6f9e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"deb6bce9a2d2eb20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"b17d9838fd72c0a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"b9dcb7bda9fc3db4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"b94dc483f935b652\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"17e6a8eb4d60d8e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"e1fccc1d7c9614cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"20c5080515538346\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"2bfa10f3b2971bc7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"dffdd3196f9f5dcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"34a64e7a972b9bbc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"32212a8b13741dd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"989f97d2631ff6ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"56ab48907cc0e5a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"1bbb7fe18cc7b648\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"99d35d62149a6562\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"1bc857f0863261de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"45862760fa7dcac8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"5c5cfc9caf0ef09e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"d03b26dd865fe368\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"4c81a0668679e623\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"887515b6901b6a72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"875ab392397f6776\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"42812024f12fc9ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"cf5f67ef2ef0bcec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"c8064992e8603aeb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f55d2d09a782cc13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"68161107206f5380\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"c07f754ab732feee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ac81967867272e46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"125634ddd2733bb9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"9451b4fc909df664\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"d3a2b4e38be1c3df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"1d958af447e1555d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f6e95b2d0a749c24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"55e998f0ae0c0b29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"e7b543ffe829d037\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"4d4590b458fe5b5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"609641339c54497a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a0f3f8e24f61c358\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"3461ba53a019e23a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"79e7a0346b31dd21\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"51a67bdd5c14fd3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"e00c9e21dc99e668\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b937f5d64dd1ed3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d646ebcec732e264\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"2894e799d4147514\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"433b43f96084c257\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9d42b983875d3761\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"706ef757fb24ffdb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"1169993669052c73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"4a60d1f19457d66b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"9fd6f83479eb2518\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"1226dbd52e54f382\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"f158d4d4c2c02638\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"636a43fa04772422\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"c5ae7acf49648723\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"7af15d5db94f0e9a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"4e8220a4a917e1a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"3d72357f5d5912da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"204a44ab16f44120\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"3934f87c8316e29c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"2c99584316f46e45\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"76306201d7a6f236\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"fa53174626f91f12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"ae3af932bf3c614a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"9216463bc6d9252c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"62a81b170370a8c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"51ca1dc47648422a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"6f0feba3b6690473\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"229aa3e0a49f2f76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"29406dea863e6e57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"a4862e4a2b82ecec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"1c87ef69610ce806\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"57c2e846d2c7f484\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"3c1b2114102185a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"8dff1329ee432f16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"78a5dd88be8e3dbc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"9cd6420a7e438746\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"703276330327cbc6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"cc8c4238ae63bb8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"0c007a0f03d26f0f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fb224f91d32fe40d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"c1c582b4f37783f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"8b2d59a49ca80810\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"293fe68b8fd4358d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"dd1edd0d6b602b2b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"39ad49acc260cbac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"be30ade5fbaf61cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"1141f07997040127\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"583dcc5d1ae2cf4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"044cc5b526292c84\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"02cfe58d9f1d73c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"f693838e94ab75fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"cfd3a3e476457268\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"afec90c03b6de89f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"2ede790f049f9ae2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"becf9f3493e931f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"eee138437067b93a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"72e3b727b033b763\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"2313566b4231e17e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/navigation.js\":\"d9ca7631770cd8de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"d5cb412e76ea9e15\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"584427b08dd0c737\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"d8acc1105f9db514\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"9c4a54485926aaf7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"d5989f1049a30972\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"b563deb1ea179b82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"af434b3aef7f8dd0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"c458114075740ced\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"30a2fc1ce740c7ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"3c20a93d6f927bc1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"a4fb70e243028ee9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"fd4249a81a82f08d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"c33378d9a39386e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"4f90b483daf08102\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"71a61e3f6d253491\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"3c3461d79b38ef01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"2fba9292ace461a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"476d44c5eb173697\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7ea0ecd8f4194b61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"a9e96eb37693cf28\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"8107d57976c74b37\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"2330af0d58c3871c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"d502cbec5ad361d4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"d485927220fe1833\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"48481a8bac6da370\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"115d3c72fe92db4d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"e799da90a47e20ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"d6e60215038da067\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"20e438aec97d364d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"9cf0f9ca144de527\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"2a2911648a059677\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"5b258d7a96ef54d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"a3911531a66fe227\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"fd22b94da0f935a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"a5b087741916d43d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"174f6512ac10edab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"d37e354f1d80b609\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"c386667a7e8c1c2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"1763dc77f7e5609f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"bdde0a6fef471e90\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"46d48a4e3ce2edb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"d0511baf71972569\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"f5d387e6736d3753\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"4b44213fed2e9c37\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"36618f0bb679b87e\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"56ec9ffb68b9a9eb\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"d455a7556dace8ef\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"6cec76e6f054ca8f\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"89a4b4784df6d069\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"c636ed3dae632366\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"d3749bf6d3d88690\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"f09ad65b8fb7a0bc\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"30af90c3fa2f1d11\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"e8aca2c5cd263655\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"a2b7005e25ed6cfe\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"be956c37bf820b2c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"ef0b046d8c9140f6\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"5e4ab5bc02925330\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"44264251da06aced\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"6a5a5ce1f626f995\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"bf484d2e1bb45429\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"96ac580407f983e5\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"af59f3703f0aa51b\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"566caaa21da0e96d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"d5b434e22d65c9ec\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"1aa9651358195382\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"484270dd4f557d36\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"1e1afc5cb67881e1\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"98fc0bc378d0dea9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"71c8fc8d86b87cd0\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"73bf3cb002d2d04a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"dd604cc460ede74e\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"4362a95735ef9e10\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"2dba827bc392b2cc\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"1651fb6db3ad6909\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"d0495b76ce333fb2\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"32d4bdcfc5b55383\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"a36325b5a37b8311\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"a836b87ced16b9b3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"ef34cae626a69d03\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"6e38afc141b7c3b1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"30448523eabcf72a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"7fe8370b86345d6b\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"d2ce640a6ba6e4a9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"3a959a685ab03762\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"95b1afec3b97b78e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"4aa7b47903a44ddd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"42f3f4559c09cc30\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"85669e2128e57241\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"edbcdd4bf74e47b6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"3950c452ba627061\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"54f6780e616e194f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"d2f43c5634a6d158\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"4ade56b8151d008d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"ad01237807345efa\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"e10c0105e33a9a98\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"efe6ecce2355e182\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"b2c0162a0cc30fb1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"113d3ae2dc5f8d3a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"d859be579db6dac7\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"e03a219507742edf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"8daf476c2b0141a8\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"12751f457ba9c48c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"81a01c441250dd44\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"a6c9b0483c79781a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"5a97f2e8a4c90eee\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"f486ebe11b4e2904\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"0a86f409bff979d0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"8c71647887b17668\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"52bd5b16c474525e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"0baa28d38c970cb9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"4a294ece977d6d36\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"07d6460d475809f2\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"e33e3b6cb8df4ce0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"e5b4871cc4f4516d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"96831d8335f67155\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"766ff89ae27b80a4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"68e6993f30478b0d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9d69b4897d0563d3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ef74a92664f2443a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"51a3f0c0cfe7c2cb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"8eb09c0ceb026bea\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"f02e884a2d572895\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"57059a01b56b8756\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"9ef220c5e5d51fd7\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"e8738a784a68f534\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"241164cc3cb2074e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"05ecaaf7e03050c3\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"7716f98a20c98d3e\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"fd1106ce165624c2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"a1f81b4084905a50\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"ee679959c52d3739\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"c328a54c77c85436\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"9ed77261769fbdbf\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"2814f8d9a7dbcb9a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"467b6b81fe8d6b38\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"b30dee2299b6c031\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"c3e305ab2209bad4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"e83e7c8ba1244a7d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"b9a7a9f4178dbbe4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"ba4d30e83c3ff26c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"36a0b97514f00706\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"3f9bb92de0ac9b40\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"4456ce36dba6259b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"b680c5a1cc7bb1be\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"78783904b252a37f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"871d2baa03c53ea7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"618a9c0a1248be0b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"725c2c4a039fcc7d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"9fb930a33a3ad6b4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"8620abb9c8318f66\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"03d15f55c406cd23\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"c2f92dc0a7ae8600\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"bd1d141db01058f7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"deb709963633aac7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"fc8717e67577d30c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"116454b6871fc6c1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"b0e77b6c52fd40de\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"be20695c0a2d6143\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"aa5f508e7aee806d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"b8ce055bb9e5feb9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"8ef1e3357248a523\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"bed251df47cb326f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"b8a2c51306ca0fa4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"de90b3baceb61f76\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"30ee26a0facf8032\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"1ef1e9aea933aebe\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"597306a8f6f1a1d7\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"fc750568ee47c192\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"f9451e378c1eb13a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"8997904dac74a3d6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"21e2c1e5819a4cc6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"f52d616ec511ab86\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"eb4001afe87e264b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"804f8132c19afd63\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"7db8e6be44f79487\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"65f16b7bc0c270bc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"de71f977ad8189d5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"e12f3631d0e7d962\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"649108f38ec8c1bb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"28a0a385fd7a34cc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"98f121e462a3c7ed\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"6fc4824f50bebaf1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"8f085511fb429b98\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"75ef1b9066a2ee38\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"f4403a8dadb86e6b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"d7a3a48597c5447f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"d67d8a71c72e7589\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"4274fb5b753ee318\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"bda944bb18195f34\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"441d4311e493ae8d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"8c789f01765b68f6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"b782c59ea30be931\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"1abeff29f8359de1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"3ab49440cc314683\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"ecaa141eeedd1a1c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"b03108e8ca11eb59\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"936b8c6aa22031bd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"c25923c1e0bffd84\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"fa00dd4181057488\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"9700d043d32bc3a9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"0e4f415c956f3dd5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"959c2205deeb194d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"5f11e07f33a673c4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"932a86c65b7c3589\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"b29f47af72fab9cc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"42604ad3899cca6e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"bf098dfaaba1db2b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"25626642ecee4a4c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"b2bdebd13812d22a\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"51b1c74542949a33\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"39c7d9c91629704f\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"f7521fda11eeddae\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"504a1df06b1d6754\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"b68dc7bf7a89af04\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"df8c1a9cc753c4fd\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"11637e159c22c0a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"8be99d517f87aa3a\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"9cec60fa53f18d54\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"dd2077b836ac274e\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
