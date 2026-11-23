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
		buildId: "d24b34279a99-43591338",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"f893e0f019f2e5f9\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"f893e0f019f2e5f9\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-Bmm-TDll.js\":\"7a7c8a25b6b54a73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"8e41c02c1514fc57\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-CrWybCGW.js\":\"18f3648dd215768e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-D-ir4MXu.js\":\"3e7447dcf7a1fc18\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-COvWGY9y.js\":\"d02d2c5150a67f36\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-B51soLtP.js\":\"660c034f6e4c043b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-TVo4MaDt.js\":\"354ff65d49952695\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-0pbjKoX2.js\":\"42791e439ec35c25\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-Bq05EWYT.js\":\"97040958355de01d\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-Bk8XLFSX.js\":\"61ba56c357db19f2\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-CIhTpewZ.js\":\"19adc3235f60d15f\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-4LEkHnCZ.js\":\"f77904ce105c5d21\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BbfKklPq.js\":\"c42d598716c19f22\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BggfVfIs.js\":\"2dec39e17600c2ff\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Ca7455tp.js\":\"df0bec6ce42ffcd1\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Ccuvuw9x.js\":\"a4a20d1059fabc47\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DTrKwhWu.js\":\"29107aad6a90a7d5\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DdPrXT2l.js\":\"7d132582cb6c55c3\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dCcSiBJ9.js\":\"7fadbbbc72cd6141\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-BBpjb4gz.js\":\"6d1ee1e12cf36214\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-CXYOmGyr.js\":\"2f52d993ff813b9e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-QtPd-C-O.js\":\"c58c16a97caffca6\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-cSreAOff.js\":\"a8149a9071e40db6\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-Ba6JBdVn.js\":\"858ee30ca5213737\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-twVSc_VI.js\":\"5c27100ec8d1d194\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"01c7140243b63e6d\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"2f744bbb41738900\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"458f6476bbbab038\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"0b09448a190f613a\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"142b1165a76ada1b\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"f0df77ab8d0a6b50\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"76400599a78fc9e1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"cfa2dcfebcc7c396\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"6c3b824643fdbfda\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"b6ded6af035dc9a7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"a072b4d5c88a2a17\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"073c9185fc524208\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"a6f4bdb13c332816\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"340808f2c578649a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"51b039ee2f4246b6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"869a24eeda6453ee\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"506bb25d964a20a8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"580e1e575b22fd89\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"6b36df87adbd3c08\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"99fe90361d09a8eb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"819b5484a58b0c5d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"f43afea2b1965ab9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"292341df6b414c75\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1dc7e487106abf5f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"5d092e793e89ed1f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"cbc3d658a523f59e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"50e6b98835fb9532\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"5fab495deca8fadc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"4b88f7e83927df77\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"c58a673b7b2040ce\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"361c8aa100c20bb5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"84bd55b1ce8e6fb7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"e2a97bc3e4cbdceb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"c496923cb33292ea\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"81c16849f7699ab8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"6ca8909e01dc5759\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"b249e806c5fdd71e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"9b8a19ff29aff1b8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"5505d64e4b88437f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"adffa0c55f0dc99d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"46b90c99d33b4382\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"303dc3b5ee47aef1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e168fe0538521c88\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"271cab3a56401a92\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"32c57e6947730b7e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"579eedd09825184e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"0319cf3339bb3eb9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"e8ff33e0bd473575\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"4dff72f56736c6d2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"0eafad34e5ddd324\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"eb3089f2a712d8d7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"e433c32a57eb184e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"87bd2726c1d985d2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"cdd89883e95c3550\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"28d6155a97da351f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"d8d66288c1fa5257\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"ac47fb03f9f6673c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"4650fd4099e9fe84\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"70396b130f4c9ad8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3e2a172550cf00da\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"b7aa41460e2236a2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"92baa285b377d67e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"15ef68d20086b3cb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"e166b8bc17d15106\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"a97c35f9b82cab37\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"5eb2eab204ce9b44\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"7fcdc670c84cf4fb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"266708e62d50b3b4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"8f4dfa4a48ec192a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"82515813cd08fb24\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"8e78d6ec6caf42d1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"b7537f2edd0b8947\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"464ef2bdbd444be7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"fb04a270a2a968d9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"24058c30f56b60f7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"91af53ec9ec57657\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"434e8e696171a16d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"ce17c81f826e8177\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"1757a574b6a71889\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"d4df1c6ff979b1f8\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"fb6fb809c84470e7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"085fc730678c1057\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"7d3dd4246e776565\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"da806677152a37e4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"71966019b28f0503\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"1f07658de4205e0e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"f4f9fb88422620b1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"07720341666a6591\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"7a3954a1b81b6b4a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"e974e86719e59bde\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"e24a0bff84b8edfc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"08ef2eaabbb508b7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"7bc056b239b91c8e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"737bd349bd69a974\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"ae4f4fddafb1f07b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"d0336a078b41b165\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"83e4599607243520\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"0dd107651e594585\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"ceee8a3a7e3582fb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"e085a8aa0a9be088\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"51f83979b8e0adc3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"ad3a2a837a3147ae\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"28b212075237c0fc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"c2063d8b6d62daab\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"79c00aaf1827d168\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"606aa8a9460a341f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"50dd5869197bd046\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"49801afc52c9bcc2\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"4acbb7a9f24c9c2d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"0b1eccfbc9e7ef15\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e52257f48c8c3e2b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"570f602038751b7f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"b04cba5a50c552e7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"b5cb3df59c57fa0b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"7f8635c6bc243acd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"a9e8b9d8f7b8133d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"515bc1589d349da5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"c99c7cac0f2361f6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"8d697d2eadaf5cfc\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"77152a043d78c9e4\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"c6eb8b52280d3f7a\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"568b173a50094b46\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"ce3375d326daf2ff\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"53f8a86a1462dc61\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"794c89be756f6a08\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"1a56de7d62988a81\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"47bae2af2d54199c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"41537a512d233038\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"9745c075e19f23f4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"6d7911e22000b0dc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"87b318f494bd2aab\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"434099dce8c102fb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"48e1f0c13189bd89\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"018b31022f1fd445\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"bfdd492adaa73bf3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"9b878717e27db2d3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"a5abdf562fdb83c2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"7e76751615c8ed56\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"32f4d9970605d39f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"9b7e3adaf322c374\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"018b31022f1fd445\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"018b31022f1fd445\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"ff1bc4f52a9cb1ff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"ccd4548648ad85c2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"05f6698b13ece56b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"23da0dc3439662bf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"7ac5354024077110\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"614f06ed32af1df2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"f8ac66e837a4f460\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"ce6627c44701102d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"c13ffde1cf409171\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"fbbbe6e8fbf2af91\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"2671720cbe9190d7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"87ee7e39eea41e0d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"c01b11c2d209a193\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"d5712b8772adf42d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"d3309ee959bd3477\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"7949b46e6eecaa50\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"ccd7ab9aebb35db4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"1fdb9d42b77fb54b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"d046a1ba5f0660b2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"148a22faf36be7cb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"988bfef1559617f4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"eac062a750d8fbbe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"38b6e11065f4728a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"acc3903a70447388\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"11c902f38fcdb0d6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"aba3e5b277a910d0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"ca88651b69a7c32f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"f7a1d8bc1bc6c39a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"4a0172c5933817f7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"8d1dec4295df5e3a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"909d01e125ee13f1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"f22aefc6ddbbba01\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"93800673d113d990\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"19541a4d133c6f8c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"e41531db3e8b40ee\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"bb10248477148601\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"d0fa13550b776d1a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"d78c32913bddc0ad\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"d1e519f2e2302ea5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"3cb00a558a0461ed\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"d06a72883b063efc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"a574ae4ef42de541\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"f936f8a9f3324035\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"dfd026182fb3cff2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"3ce8150d1408155b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"0a9986fb6b696071\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"16866956e18f3daf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"109d6401d8938675\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"98918b65c31d480a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"006827743fdc355f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"d6acd8d8bdf37a7c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"9bf842abcd5c4f4a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"8624760a418f4a62\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"4950810b7e0bdf78\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"51d05330cfa7d595\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"f16d57e91184f939\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"1df21a60c299f2af\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"6aaf9ad6bddb6409\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"53208153165bd88e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"336adabf284c5c6f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"8b7367cbcc9bd7f2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"e83734a37d08fce7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"b38d1ea79cdf0d89\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"dcd8e210ea22408b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"eb6bf84be28e00b4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"9f0e2c8e25372d95\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"e66de60039f6b517\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"402be1b01e3c5c04\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"8ab7b14dbb9799ea\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"4a50471c97437921\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"bc8d2ecc7102f1e3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"2ddccf5a38f229c2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"b872eefcccd69d1b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"50d9ed95a97dcbd3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"e0b3399a5fb01df5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"9c5debcd95e1a2c6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"71f524d65c015882\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"761f10b41c2421ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"23517c4108ffcb3f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"19bd4fd2477df190\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"0ba0af0324cf84ec\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"55597a59efd7b519\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"5a9e08a981609dfe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"3d79e09b945a0fd3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"9b2ce2eac6b8ce1b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"51a4a9cda5f78b10\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"4de9a6b381d04e60\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"7ecb5e9be0021152\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"c1553a5ccaef93aa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"d2f24fdd7bf7c484\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"95af3a1a6cd4379c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"0c17146e28d64197\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"0085ac6144801e07\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"83eb8f125ab140c8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"039a2354b35fbebc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"f1ecbe9b651bff57\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"d98fe89c3a0c945f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"ff1a96bdabea5029\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"13c1d632705cabc2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"77034c10e1862147\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"62c30afc5d6a23f2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"685b4320008e9163\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"7f261e18671f97f2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"aed8653c21be099f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"24f7839654a07e06\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"136e32e18e8ca586\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"6e771c3d1510b404\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"28328dfe0636e55e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"211cd30e12f4e8cf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"6330653df5be5b4d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"448e37997dd5268f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"d93d2f390e37a03d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"5b90a27fe0ecfaf1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"8d507f39828160f5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"e1fb4a23fc03407a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"d590e54baba16bd9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"874e7abd30626d78\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"feec9080c42a7ba5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"df408782ce272548\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"6d850c55a20584fc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"09ff82e8599d5c8d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"aff52ddd4c4899f1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"cfa4da71520d7656\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"c9502e4fdd94147e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"add78dd63a168a97\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"5cc2a895b22ebaf7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"7077974816b17fec\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"4bd758eeb8b2319a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"eb81be0569b1c433\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"2f901be6a1351561\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"a42351ccd1fcf920\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"b0e59df5d669307d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"a8f587de293a4faf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"7fa4a0f3bb7ae6bb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"84aa9efd80852be9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"eb4193e6622e03a8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"9ca2ff35ff636361\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"a50284610130664e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"57a2d2787c01100e\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"3bf55267e89f9c6b\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"07d8bd5bd445a462\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"1e48385f11a1cb44\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"1bb0c1c46479fd3c\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"fb23e23826819ec8\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"13ddee60fe50dc92\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"85ce98277292d20b\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"51a92691f6c99fc1\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"00aaa67d3348e50a\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"22ad5244ca268e40\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"49d789165fb3babe\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"5782bd737f8ae910\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"dc3a303bfd302f99\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"4515a8e6dabb731d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"5bebe97b23f84565\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"28429b2aecd6fdee\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"3ca4aa3c22268da9\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"4c1ac6440cf99919\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"88460319312771ee\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"ca5a74e21ed4a23c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"749e237e63f46c2d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"f6e66b05b7c603c0\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"20584777a5782291\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"7023bfffe9946c8d\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"cdd2f6972de9eb20\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"10f16f2e71d8d6a5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"3efe79bd5c353490\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"a5a6dcb2d4b9d163\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"dd4be508b0a8451e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"8cb6c5beba42fa8c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"6b7bba7cda6de59e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"725d3d02dca7a418\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"fd2a5acdb3642eeb\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"370efdc99257acc2\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"cfb485f3b7317154\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"e74255fbc0c3cca6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"27f6491a34d5c49b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"c9d7a9e9a2a7e0f2\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"c375a8e291a95efa\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"d167dc5e4b8a255e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"9f9b576b293b8cb7\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"6f90047ce682494e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"a23509c1df4876cd\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"5c2ab4c9293e5d52\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"e30a3e614f0b980c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"47a370b9151a452b\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"d5f44cd90f269128\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"d8e6c9ca86494dda\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"abb66519b5ccf66f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"781cb3608a422c9f\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"073b8e434fa57b19\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"124b2fe49dfce2e0\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"59dbf1d32c4ac463\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"31612b0a08cd6f3c\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"05672f3dd8df3eb9\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"23e02413556e9ad6\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"db6474a6eb7932c5\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"7667a7426aa25e58\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"862742e86e96892a\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"827e7a6ea391c202\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"26d92e7ceb83e525\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"ed01bc88f5c3d9d9\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"1b9c726c759d211a\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"5c3659a7d43074ad\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"347fb4a088755b83\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"a4a1a9d7259071ec\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"679947234b4a63c8\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"6ef500046d2252c6\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"ff3581daa2fc65a6\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"a020081ad75b5dbf\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"df11bcc124080095\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"f9092d9ebe6ba933\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"4e516468cf49ad2d\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"bbff0f9c2e1bd0c9\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"5cba2d101ecbf930\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"0941cbf488e37c84\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"51bb66b76ac467e0\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"633d3ea59bd52223\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"842e3baa20f8b66d\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"38da5af07840749b\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"89816ddd05552553\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"42923f077188e0bf\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"76adb04282ceea9a\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"de3fc669a228b2bd\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"08d738822800d004\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"a0117b2473c0a266\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"edee0cf03c833bc6\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"642ca756d27b52e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"7ff8592385f62753\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"245c773215a5a2da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b1fcabd031d2bf0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"ec03df496dfe246d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"eb3e44d1ee7d8245\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6e48bd058f12f9d3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"dbd17bc375c2b319\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e5f8995b971dbdfa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"419fb8d7fc17b836\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bf89b8eda740e7da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"0b371750fb16181a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"08824388a0df4356\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"285120c0360336e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"3b92abf36f90c4e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c72c991d291d5795\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"4d832f4dad2f7d3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"3192644fabf41bde\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3160344f98537517\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"714023fe79decc80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"c7c36c67691835d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"5ef7e6aa22e158f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"7a55c01e09156749\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9455f0029c087778\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"2fb7214f90326265\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"9cddf167f25e6041\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9e2a1161880ca463\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"c4f39e3239e107ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"9d7cc8b82d1f7cd7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"77a6b4ee79374bdf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"a8bf49997f18248b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"ecea55dbfd4c0d04\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"19c8e81726b7ae92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"6c16ad77e25b4a12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"0389494cfcdbd613\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"6b7b0ab9950947fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"356f3951c6e936ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"62b3fb50a44d3b0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"683218f399ed0c3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"9e162558d140e965\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"d30bf8d2379b5144\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"3048abdc27a7c94c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"f15d7b54a5d018bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"b86231f641e22d2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8f10a745f65f661b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"b44515c1cb0cbd13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"446dcb9a5fd4f809\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"437eafec1fee09db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"66764b1c39783eb6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"1cf1a032b5fdd785\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"90aaec393f5acde9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"a092a066c960e8f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"9d518bbf5b5e3c31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"3adc6f39f3dcee2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"464268c1af9d39d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"4e1b2cc559309762\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"3f31ca655195f39e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"f64558b127e9e31c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"330860b863f5267e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"eef0856916be8ad4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"0061f4b0461e6a5e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"ade0704c2e4875a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"c797ec8b1ea05877\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"4e6e7da1f444c480\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"9178521a2a03c5dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"e02124b0fb3df99a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"b219c5eb44a0828d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"609d5ee1e7e43c89\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"ee36c8bd3f57a949\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"3d846a52d509ff80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"a019734cc65c4468\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"20c1d182f524658b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"0cdcfb13deb037cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"e964e67625cd6bb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"b32bd15e7140ae68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"40b04c63b135bbb8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"0e029d3c0567c776\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"420573ad21f69218\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"17b3f8784f45dc37\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"7f5fbe2b179c95b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"adffcae43065f54b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"1c8390a0bb3ac5ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"1281e1d4f546fd88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"bc6bce87ba6beb11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"3f61db6b8f8c954f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"3959da06ca3737ec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"88c999b2dd18874a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"db47a50b9d76fac0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"641b939cde2350fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"bb1acffa9c166689\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"15bd7357e9d01494\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"ec007ef13532df4a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"acebade00ed82ee7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"253ca0e161f7b556\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"c229d554385806ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"6ed7e76641400df9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"2132e585db5c35e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"c039f80a37e0a8e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"c79c46b68ee083c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"300a95d72f1b2d7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"d6dc17da65b4fdb8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"d27cbfac67bc1e8c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"1dbf7c7d5355f803\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"490c6dce61f95ffa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"27a52d083e5f1352\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"77ff168b1c89b81a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"8fc6507c07bf35ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"be229b5b67e790c9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"1c3d09978bce6479\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"e91a182e48891cd6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"0a4834553370651e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"30a2c5aa544e6afa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"2c40a7c6af9dda94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"34ba559c84437aa3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"8e6ad9c81a484191\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"002773f29ae13770\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"c17c11c3c995865d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"21a417ab03263205\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"8b3b3df6befd6b93\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"3c2dfccb0ac6bf3d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"ef547ab8ecc547d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"bfc41dfebcf27e38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"ee534b1558e874e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"d9a9f2ac62386588\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"9557b32700200a03\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"9aa20e6964da3c45\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"03556f7491dc55c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"5dabdf503a1d72e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"b926b7a25d1aa930\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"d9a6bea39e262b0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"dc878432d1d6cb83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"045b859865920df2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"597d7695af10ffe2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"0aae1e5182aec9da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"089af67f34689dea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"210b4cc3e1fc7919\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"b9599cefb4b89c72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"583a5fdb3a571b0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"81ec0c942b0f7e99\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"fc9384b7217b1e25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e94838d7c8a6a1bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2f85332d31647b6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"7be695e9d1cc80c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"194535fddd47a0fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"d693ac4c1ec04796\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"8010ef7d3101037a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b77bb40009d86b44\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"c7778ba97025de88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"0d4609ef90221d24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"75c83fded4f048bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"c1bdc319bf0c7131\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"ba53a2efe384105a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"7e1cd040ac96b865\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"7fcbdfee8e0977f3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"ddba19dc1cc876c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"35892981983c6d14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"2ba0f4456e18bde6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"8ebbe35194b8790a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"21d82ea182a538ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"a65fd39afac92f40\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"935e428370e071e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"abaeaf125cc97b2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"845b9ecf182ee6b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"3827270b04be53de\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"4b14d706f12d318b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"0312624a5067dc29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"cbc1909168da6bb5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"461118213c46e6fd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"163114948d534762\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"637b262453834fcd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"c1029a7570b036b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"37a0decd20e54359\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"0aa4168ef57e601b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"56a5e60fecdecc8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"8ecbf192295449b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"759f87a78fa22472\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"0adb84dd0f626f0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"c8631a78d1e7891f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"59c5844b34a34f8b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"f92d3f3103c0ec6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"d8b61c88a8772f5e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"0918603cef56127a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"c7461f8d0d5d0231\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e87956f3787758d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"adb716883788ac0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"b9f18f99126bfe5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"76d9d156e4b0e25d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"2b5d90733b12bab5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"ac32188199bda5bc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"b8450113a17dbc79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"41802af9ff9e0355\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ec0ee7abaa6fa997\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fe7ef37114569261\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"745c61721074ae83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5e4c17bbda7f6f58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"cf9140c14463be8d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"40af04414f722da6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f827c2abd39846e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"afc10144a3df3714\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e54699c73fe27019\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"981ed4d36e2372fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"1be251c43948250e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"9e80c6e7cffc1778\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"456ac0efabef3788\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"bfbddb0254b1b70d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"13b95614c9a9b48a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"7a80cf2cf92e20d1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"1ead2fcf698cb556\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"b738248f6ef6694d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"75b8614aceaabb65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"baef545bd023ce24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"ce9a95721339199c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"0ac61e93f847374d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"b142354eddbd3b6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"69f295aa625ca920\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"81cdf5169d3bd107\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"4eb97456ee71231d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"02bfb3b6e5f9d5c5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"ef2d9ed1e5380a91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"42168288693ea6b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"520cdf2621559204\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"368e8b64153d01f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"e6c98af4b7c942c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"32ebb7b45685ed41\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"8e4e6c0554c43bea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"dfef1076d81c8396\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"300c682e7991fcf7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"65dfcb364e7658e6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"79b2921fe49be3c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d956a48697157297\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a0bd6f66fb4c6df2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"edb5748ebc835da5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"354690ef798ef571\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a8fad8e59d87ec37\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"7b8837c713b92be2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"849997d9d456b5a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"840077cef8c7bac7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"68f4de0eee5cc113\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2bca33ef4854dc6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"c416881e3d6ee663\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"82da526df3661a23\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"fac22f01118f254d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"2ef7c418a1f34de6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"fc60057f72fb114f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"c0f29201265938b6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"179cf543bd9ea3ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d40ba8416d07eb0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"438b3032c8c4116f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"2b1489536f088c8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"6f30aecb607fe0cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"bba13a05e98769bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"81c0c0511e1be65a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"49f7f7e665b2ea65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"b6327d160370c424\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"9c1ac63ce03bc5fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"f4d44a19bb4ee88d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"3b70f8744f786da5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"aef44068cd119fdd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"ece37593c0e3fa7f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d792154547884666\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c544fdcb01593d54\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"fe534855b880370b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"72f9e93aaccf02fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"d8d7d3f5b3c34c1f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"d28a8c86cede024b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"8e636d2c6b360f69\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"c7b269768972354b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1c2892e1c7cc2175\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"2e0ca150ee09861f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"5d88b97d79f1166f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"f29254d08120be58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"116fc5618258172f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"dc135973cd55f884\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"d5c99a76555d80b4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"ccd0e248f20df27e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2221658407324544\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"8873e376f26bca71\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"2a194c6f5d638a75\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"55ebc3603e5fb191\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"0c8aba0e973c8499\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"8318ce8b3f2bd9ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"cb16e94d610f4e73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"81393c828ca7c617\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"3bcbd8aa3ab6f260\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"0292e2b81cd11cf2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"fa5ed768f5a4748a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"29945edce7ca063f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"05d0c2bc3b5e8062\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"0fab70f2a6b83845\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"df5988afcdba4598\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"606f52c262621345\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"1e11429b417b6add\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"cb968d994a6e38cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"26e7f1ffd93d1fd4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"1fee57f5edaf24eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"51c00e6120e85690\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"be217b157adeeb4e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"f43097410f050a5b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"44a8dacf85cab5c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"f6c99803ee60f8c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"684f907012e7ef17\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"9c202d4681704452\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6f6009500dce8d11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"3f62a04adc7676c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"49a73eb79a511697\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"810804090d2d04bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"32d7b87d89578902\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"44030e5cdaef3d27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"78c3b160553a53fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"1e539989bfdb6dd6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"c815a5d0f0f608f7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"2a94b500967ba22e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"a47474ac8d607b02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"67c2e5b0d90908f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"034cd2bef0e91d87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"1c3ee50bba90cf3e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"6569ee37da97206f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"af122c83563b75c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"ec90f88a744b9455\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"17775d16ae246efd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"b7b7fd4ef903ab2d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"217fb933a1615ed9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"403e9e8ff7c8b569\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"3a2318621f82a776\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"965d0b0684fd645d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"9bbbe7f332dce386\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"11c3abfb510be803\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"fc1d1dadd0f2f8c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"57f5503ae24e982d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"c23e130dad621ecc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"766bb2d1dbb49f31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"5d17befb6f9ad005\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"f4e0e2c9a3959918\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"ae9392246ba1eea6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"97fca359258ee5a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"bc2cbf994a220b33\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b862a4777f03aaed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"9e6716e4dffcd0f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"faea204a1d447c64\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"06ae688c6cc0d70f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"2ffc73449bf3a353\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"e88e2b087c97372f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bd276894593d7a1f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"b16c7472cf994167\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"5ae77bbb9a04a820\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a5755dcac3986efa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9d4d28d608d27aed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"1a90774265255cc3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"468e224083aeed80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"013888b76008df79\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"c123eb1a486aec3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"bcfa583c4039180c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"123e49e68dfce959\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"8b7f59b7c52788d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"dbfb68175514aa29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"12b940e92011bd6c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"fa07330d17ed3dd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"77d31b776c528daa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"baa3b4c7cb292b76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"08855179d8d8d2ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"45baf094358cfd59\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"165b6e469b050db3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"2b419b22eda30d11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"5a50721758112c19\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"fc6f8763b84c97f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"62044414124bfb4b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"25c1726fc89514ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0545e981e4f0cea8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"d1d0da4459d02bd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"9af7c5eba858f885\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"4dde64066e0bc9bf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"66963492594d7c93\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"5cdb60ccf6040f17\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"671d71c89d3939dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"7781b0fa2bbfb810\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0decd161cdce8fe9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"700c2abf824ce254\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"adb5de914f57ea4b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"c9c9693393117ab2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"1274c43ff16df577\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"3dc260166b3f06e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"258b60f326818131\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"82ca310266e4fdc0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"9de6c79016eabe53\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"e82370834fbec39c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"bf56c30ad3c53500\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"43fbda64e2ca1c0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"0d67630b99226aae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2c5c2d0dc7afae18\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"37612cf44539597c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"c974eb141ed147f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"64d89fc87cae5d0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"000ef1bb79a8b8f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3e09df708e1c6df3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a3b8526a4e923757\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"031209ac22ec33b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"92ecb8b4a77370da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6cf336abb9ddb459\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2c51954434cb1687\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"b58da6510392db59\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"8a0fe59b946af338\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"8f68273d82cc651e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"6e3e9f9840cf7cba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"04f0fd92bb464584\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"32bd634c45e793c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"7192ad01aad041da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"429e7229eb016f01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"90dbdfe1bc00f481\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"5d4f1faeb6980309\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"da55ea18e8a29caf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"85544b042341fadf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"91a385cdc21344c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"fc6af51a51d33f16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e6431ebf0ca11568\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"5fcff890eede5f73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"239790711472ed96\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"46a6555733a0c72f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"5029689bfe3e2ecf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"ee97c993bee7f42e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"1fdc718ff9708549\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"e423a7637d01a690\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"6c8ec46f08a48753\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"5efb0812d2618d22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"e2f215741a16ef83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"ecd636947abdf204\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"f1a795d337b69ada\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"291f5bfcf978f63f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d54c80abedc89130\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"834581e4ce61b278\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"bb32f214bea83441\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"6d0f8dd44ad69f15\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"451340c5ce54258b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"c0760c3e59bcd7a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"40d7d28b8f9a0192\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"56b15a4afada153c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"17e250f6970b86b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"ef079a9cedb5eacc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"0fe77fbd92c95b0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"63c09a8aaeea8f4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"b9650564bcbcab49\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"4b42343314b8bb89\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"971aeac3a07b0bf8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"50d828a1c53f063d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"2989668158cd8eab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"811c0c2287e6690e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"35759a2ad527eaf5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"d582ed1798f746cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"463fbf419ae64f42\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"48e95175607e19c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"4d517fc4cad5c108\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"ac3590c4fbe352c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"563915f07728698b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"3df145a9ebea45fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6ba6c26b251f6b15\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"eb3a414fca15a42b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"7d9484c8c7e1b554\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"1e0614e9608798a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"c8b9fa9357d22416\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"8540b17761960016\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"3e8adf198172a68c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"ea11cdd067926665\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3fe3d880d235aca0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"477c19b05d4e6752\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"c555bb5cde7fd365\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"74c978b96225694c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"27abd178e4a2d45f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"ffa5f6a533077fd2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"ff3558487d05ddd3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c49687b1f654553a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cd4d2c2847b11833\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"118377b8baf866be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ea78dae3be38d85c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5f6212ec9c9f7076\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"d831c3d373af9deb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"b7bfc3cbb7c4c69f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"11ea7bb3a69e2aa0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"22480337470dee46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"22b2e09bbe1dedaa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"d096e42444d7f370\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"28097409d5a39e5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"28e63afe47b4f979\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"e347bb0c1b8a5aec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"52df132ebb7bb62b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"9ecd34213e471642\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"db99204e04d51283\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"94ce69bcf3bf7462\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"eb50fbf17b9603e7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"56cf8e6f041ada98\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"279e3030bf2f779e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"f643e23b65024e85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"de2f16184ddb57d7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"6100eab71a7f71d0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"e5a1602b078d4c56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"72920210795d0a94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"08b3df8da960832c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"37b6daa136e87c7d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"77dbcfa3ab2e86c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"2333a023743a1c7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"b20957eae0ac69fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"3f2dbe43f7588af9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"43a99dcff5981610\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"2e2b52ee3626d767\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"85045ee1c93e796b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"709b91115efa62f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"398edda44b4b8b46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"a1b0008945c9c421\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"78d11c09e9bc156c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"046951aba0f004f1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"4061f665cf9dc943\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"2bc510cd81c5111d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"3f3b9ceab4852629\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"537c6379e646dbd7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"377414bbb976c733\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"c6a4568af0c44033\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"fa30305a889865ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f42f2cc38d56a744\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"44cc70f12a0d0c2f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"e4c2c3d64d10f40f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"9c7e3434fbf2b5f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"347027d42067cfc0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ea39f898fe15df83\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"10af8f40d997dd30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"1ae8bdd21e8ce4ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"a3f291ff1f8abb27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"4e08bfdca068a1c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5ad5bb505b773229\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"cf208293fc6ec00c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"9f0d51fb13b9a69e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8f90f846e638c7ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"d645d75866a67c9a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"908eefb5a358a4a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c84a6eea57ed3762\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"95aab2a0199788ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"dc7611c2ce3cb1a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7f2b424b77e73be8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"a2b658310186f555\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"f267430d1d1f56a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"d3eca68363bf3012\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"7dd8bdacc0b1ad34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"2b717e0670b59586\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"80f6f32e577a3a5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"0edbfb07da4f6e7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"9a0fb90eacc02a8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"a6ec93592d883671\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"64b9b8a5162156c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"5eb701366c8fe628\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"80e1f2df8ede5a02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"3061fd07a3c61c16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"569f952c8f8aa585\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"2e7ab779147c7063\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"5a7c973a5c3b4858\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"0ce0d4a13468a23f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"2ac5d5e4564b7d8b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"dd8aaa433e6d8e30\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"fc42372586e2a5fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"69d5637b9f3890ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"028d0e0ea98d00fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"bbeb34185cf651e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"d612fc3c1a01b0ce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"da64f3bb0c521801\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"887df866e85e649a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"abf1467f74222be8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"a99439b4a86fadb8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"38931928ede05635\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"ef500e61bc327c57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"928bdab39044c6cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"1648cff1c4fc1904\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"06ea4b5b3695dbfc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2296d55a83da7cc5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"eb443814c96f7e53\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"386f4c9c67405a5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"8822981eb91cc1ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"a8a4afa1209c89ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"b7a5174b7a7fd095\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"14c17aa55a8c9e6e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"52b0ee6381eb20a6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"4c4d1b80c449d97b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"4afdad41e8ceddde\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"b748b97e88ceba0f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"6e83f140204e9f75\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"214fe177f23a3633\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"0e05a6d827b480a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"1efd8582a6a7709b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"d4619fe8be2e3ecb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"e7b74819ee3a6b9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"7596fa45b2169318\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"2556f87b35711098\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/navigation.js\":\"e4b0bea38bdb0b7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"e0c7cd7297ac6844\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"015633b566e68872\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"c1da174f1de14804\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"29aa7ef474e57869\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"45b9bd738e46edde\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"eec5ceaa04a20218\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"0623e2ae2512c585\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"af272b620eec1138\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"db3338f8a4139d58\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"dcc09905d08e1e2e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"3da2497a244ebe01\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"0080376959a46549\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"328fe3d553a51724\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"83cdfc7d78890c8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"6d76e870ff42645a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"56df6d145a4209ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"5c0e30b9d4af9b56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"7d05562eccdce1d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7cbcd55d6541a8b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"049822260152fd85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"5d9bbab27c902a87\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"d7aba6f8483f2e1c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"b1c01bcb2584a8d6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"b80bd45c7bcf1fee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"5d8898791667d221\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"29acf85323e30ea9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"9641a1bf21b0eecf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"05ff4e36a652ebd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"dd3226613ae33ab4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"1ee36fcb5b562088\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"142a3d8b1966cec9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"4a8afba3b987e344\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"c38d826f3c234b3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"83861eb5382741b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"51e7f1d6ea9615c8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"0bddecb75677a82e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"3f7b10c728de4f84\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"2243e48000c63694\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"0023281978e8da7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"eeaad44e017e2be4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"0be0b7e0c35bcf5b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"bf7be4637d95ff57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"98959a374e1aaf66\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"bfc88ee1be21d93b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"a05ab5c738753fd1\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"377d4b382c061fa1\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"e549ee83423188e6\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"bf0a718dea690006\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"4150c3089fbf45e1\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"41e66ecc248b8af4\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"1cc2352c6b07600a\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"02dec16a093b70ff\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"85adf14263891ba1\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"8fc8b26d10806269\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"d65f4f54aafa4dad\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"22dff452ceba7e38\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"00525d81c726c866\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"116b80540aef569d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"f992197e55106326\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"cc28aa8b4f49e26d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"c7468883cd6d03dc\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"d694dafb6f4c1929\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"1000f31f358be68d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"ad15e32c2620df8a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"c1a0d575b12b5749\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"0ca5649c4e02b152\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"330d9860d91620dc\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"a8158b1723ea9c33\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"683e9a02ebb55737\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"14ab89312d08e3e5\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"a9a734228eb6d19e\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"34ecd5ae1f34ca2c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"b0f85113fcaec7e9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"75b95c00f6ae158c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"8589b96b42f1bb4c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"31db918edbf77d03\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"c032a2327f26291e\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"414bffc94d6c7a62\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"7d327f31a11bee7e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"4814bdaf29311e7c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"ec8d4ef1e9a55dbd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"83f9d4a07cbca171\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"7c2c06d158baad84\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"96bc7c3652c1f1f1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"db380d0a677de9e9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"1c316c023d55f6d6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"24ba89cb71860442\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"13b25deefe072806\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"c48922dab17f7900\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"8465be8ba1257c0b\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"946dc304b2332b15\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"7094ed9530ef4ac6\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"c92d623bc710db21\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"8fa2df355b5e8bb9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"9889bb6e3deceec8\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"8690ea6cd2ae7735\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"f126c28cff236c55\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"b223d7c44d39be69\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"83ac8923cf90fcdf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"588e8c7504bb5233\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"a57675f8f698cb4c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"74e175d71333c527\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"c13c649dea278d54\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"0698dbee1b8e019d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"e1bf0570291a7d2c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"3b41f7549f8617b0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"96c51586e98c49e4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"b0f967aa1101a68f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"318aeb979b6a4c76\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"f4430f84ee1b497e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"9d7d7cb409e13f75\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"163ff375254956b2\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"5369ee6a2f492808\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"94acbf40f60fc567\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"826b26bac3c9dd4d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"16c6566031df7e6f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"95f75b64f1ffffda\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"fd75b8ed1b39c528\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"08f96a3316b65077\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1803e3f6897507b0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"9327818cf53ba8eb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"a0f26dc65306ad22\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"b970a136ebfe0acf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"4b3c0c02d03aaa21\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"507019a83dedacc8\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"5181c770e6f4294a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"f51d1ab858c5d561\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"4db03ef33207412f\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"68c9a53fbdd957b9\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"0915ab8c21894ed5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"b067f7ef1e8a516a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"fc63b66ae7bf8306\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"b661f920023a15ef\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"fbde925f872c6df9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"e6ecd0c6a8eacd48\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"9e28eff7394310ba\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"93da88a988a3294a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"069a80211e51a20c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"d77c70da01128946\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"14974332b168eff1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"e8eb66e9c4852400\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"14986355d2b7cb10\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"ec3cbe20d8e9276c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"ff556d3c0d54b949\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"b9d012c136d4ef8d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"85353d7669ec0eca\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"5d0aecbc381f3df0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"9d528f8db0d7e977\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"d4adf49317c2eaa8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"79d82ea8d6cfb086\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"62472d6fb18fe549\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"b94ed91de2bd6cfc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"a24151415ab7b404\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"9b6d314c3f6b2622\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"3ba0ec850d570a46\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"c4b5756471741c87\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"633808c1f2d5b16f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"dc88dab543ac1b41\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"5e410e532a4f9a2f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"8737135555d7a2a3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"54a2754f351709d9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"a49a3b122f6c9481\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"2ec0879e05e5ed94\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"a8c7b5ee5a3e74cc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"44f266304990c54f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"d574f5bfa245b515\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"ba87a5a4227ca4ba\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"197ce0755a333cd2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"eb4f55f62a41f0dc\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"2b3605154aafde8d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"c1db17e7617ae9e1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"63257ef6254a3c92\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"802774deb4c53696\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"c63273263025b7a2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"a61ac162e8f2d327\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"143eb00d27ceff65\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"c6f2da01ca15dfbb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"520fa3a665cd4d10\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"8eb00b6d69d4fb52\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"98a1f86157f3c12c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"18abb4532da069ca\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"c047b58627605c64\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"e36f1d55837a71a6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"c15e841434e162ff\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"ea1f8f78b9c81b9b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"90fb303031506e81\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"f3bcc03609dc9152\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"5a14c10fb3a3db7e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"df3070a6bf9e25ec\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"2e80d17178209087\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"d335a0b32fedd5d1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"42ca49e8cc9deeef\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"11393f4b893e26d4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"12d3ac39b2a85e2c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"2ffd781ca19cbfa6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"e33b3681ab06b032\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"ae708f7f0674d915\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"f6a7f3b151683ffb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"227141a5dc63c314\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"9982e5d33b53118a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"8e494d344a1f9c93\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"fbab42786c728703\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"f676a51971b9a986\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"f0629368326322b6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"bfe6f9df8f70a952\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"2a4ad11a43cc7060\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"df85d99c7ae50034\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"4008a8b9b29e4525\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"d2674b1e8e10a395\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"752c63db6745d594\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"1fd5e6ea650f9256\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"6ed39b03e3b9600e\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"7ead334cef587999\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"20953a26793832e8\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"42c5e0ac7f0a028b\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"af18aabe857c8cca\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"566cd98d702be58b\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"d87a71d3a5fc3fff\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"9fc13e3cc025e8a5\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"056877eac9363dee\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
