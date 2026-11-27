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
		buildId: "506d9ef3e47b-d2fd245c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/\":\"ad4c76cb9a28f2cb\",\"/knowledge-medium/pr-preview/pr-1862/index.html\":\"ad4c76cb9a28f2cb\",\"/knowledge-medium/pr-preview/pr-1862/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1862/assets/FacadeVFS-DG3w_RNP.js\":\"cc723fb7e150265c\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSCoopSyncVFS-DVxnRA2S.js\":\"bfa3402104526f95\",\"/knowledge-medium/pr-preview/pr-1862/assets/OPFSWriteAheadVFS-k3uhbgt0.js\":\"a209378cf61495b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-DZws97BM.js\":\"e2af9f7c951d2f02\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/assets/wa-sqlite-async-B72MRZPT.js\":\"53cae5c1b47cd42f\",\"/knowledge-medium/pr-preview/pr-1862/assets/worker-BRrfRoZV.js\":\"43b9b94fd1b1472d\",\"/knowledge-medium/pr-preview/pr-1862/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1862/chunks/app-CDyLuKpP.js\":\"7a273bc2bed76a34\",\"/knowledge-medium/pr-preview/pr-1862/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1862/index.js\":\"44b815a3b0fc9ad3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1862/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1862/assets/AccessHandlePoolVFS-DqRfxT8N.js\":\"ee9345f9acffaf21\",\"/knowledge-medium/pr-preview/pr-1862/assets/IDBBatchAtomicVFS-qLOjWUYg.js\":\"6e8cbd06b2f917ad\",\"/knowledge-medium/pr-preview/pr-1862/assets/MemoryVFS-DMzVdo17.js\":\"64a854937e6cf37b\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Bri3piSi.js\":\"95d01ff3061e70c3\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-K1EecDpn.js\":\"addea3f5bffbc4b9\",\"/knowledge-medium/pr-preview/pr-1862/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1862/chunks/AccessHandlePoolVFS-DbtGhK5Y.js\":\"d001c68f9a0ec68a\",\"/knowledge-medium/pr-preview/pr-1862/chunks/FacadeVFS-B53o49ra.js\":\"de6b135ca9d00a1c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/IDBBatchAtomicVFS-D3bIs3ZV.js\":\"698ed8cd951f8fe8\",\"/knowledge-medium/pr-preview/pr-1862/chunks/MemoryVFS-qyAvZ36L.js\":\"032f4a60773ed437\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSCoopSyncVFS-DaYy0hhF.js\":\"f03f53a7b4578d6b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/OPFSWriteAheadVFS-dSRmqhgL.js\":\"d61a966544299bbd\",\"/knowledge-medium/pr-preview/pr-1862/chunks/Preview-DqhWLJ34.js\":\"9e56ea7baa852aca\",\"/knowledge-medium/pr-preview/pr-1862/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1862/chunks/card-CbOxTj6M.js\":\"284a154bf54a66cc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1862/chunks/dist-Dvx1DR0b.js\":\"48fd67d09806fd38\",\"/knowledge-medium/pr-preview/pr-1862/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-Leczzx0N.js\":\"5871093d11eb4693\",\"/knowledge-medium/pr-preview/pr-1862/chunks/mc-wa-sqlite-async-QZRWzsBX.js\":\"65f9fe3ee3688100\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-7-o09f9G.js\":\"cc287be056adb572\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-BrEpaJRI.js\":\"efe13c09ee1eba12\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-Czb-Z5FL.js\":\"969a02cdf5c329c5\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DDSbEtcI.js\":\"5a24cec9965ba4ea\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-DHA6dhVh.js\":\"87b8c33b5d15ce93\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-EKF0glcQ.js\":\"0f50c9ac8012c751\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-ZptmxVRq.js\":\"7e65f2abe188bc4b\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server-legacy.browser.production-Bnls6Gcr.js\":\"34ee2fbc5bb8530f\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.browser.production-DYcm4Ok1.js\":\"e0f059553c03dde7\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-dom-server.edge.production-BIqgGaGD.js\":\"a35441fe886afeab\",\"/knowledge-medium/pr-preview/pr-1862/chunks/react-jkFNztv0.js\":\"da84e9ae2140b0ba\",\"/knowledge-medium/pr-preview/pr-1862/chunks/server.browser-Dwv1s0Xc.js\":\"7231dfe894cfbc1f\",\"/knowledge-medium/pr-preview/pr-1862/chunks/textarea-C8JzWJjw.js\":\"ed9eba2ff873ded9\",\"/knowledge-medium/pr-preview/pr-1862/chunks/ui-CDga_QQu.js\":\"5ed38e2da72aa078\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-Dck_BAuG.js\":\"0004bbabd8adae43\",\"/knowledge-medium/pr-preview/pr-1862/chunks/wa-sqlite-async-28x3YP4G.js\":\"81ae75298f4e0273\",\"/knowledge-medium/pr-preview/pr-1862/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1862/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1862/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1862/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1862/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1862/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1862/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1862/src/App.js\":\"fd9ab14a3995c525\",\"/knowledge-medium/pr-preview/pr-1862/src/appUpdate.js\":\"7b340065c194fc3a\",\"/knowledge-medium/pr-preview/pr-1862/src/appVersion.js\":\"3e36059cf22d1296\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/initialLayout.js\":\"bccbfa193f7bd0bc\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/openWorkspaceData.js\":\"3877d268bc47c3b7\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/resolveWorkspace.js\":\"e3ee5c805f945fd1\",\"/knowledge-medium/pr-preview/pr-1862/src/bootstrap/workspaceBootstrap.js\":\"8308dee92153123e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockComponent.js\":\"c5ecbd8236d4771f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockCrumbs.js\":\"9668f9a81cbf3387\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockEditor.js\":\"718080e2d0ffd669\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockLoadingPlaceholder.js\":\"c6f3215be431db4e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockProperties.js\":\"8deeeb6a62893631\",\"/knowledge-medium/pr-preview/pr-1862/src/components/BlockSearchPicker.js\":\"deefb171f0cf0a97\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ConfirmBulkDeleteDialog.js\":\"77c57285bed03abc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DividerHandle.js\":\"e490f935668d4bbf\",\"/knowledge-medium/pr-preview/pr-1862/src/components/DraftEditor.js\":\"580d5f2e18eb6555\",\"/knowledge-medium/pr-preview/pr-1862/src/components/GutterPill.js\":\"8fa0a4002be7613b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Header.js\":\"a0d05d86ea7977a9\",\"/knowledge-medium/pr-preview/pr-1862/src/components/LazyBlockComponent.js\":\"c7b181874374c4db\",\"/knowledge-medium/pr-preview/pr-1862/src/components/Login.js\":\"6400ecbad8a135e4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ZoomableSurface.js\":\"c55e0d97195c8447\",\"/knowledge-medium/pr-preview/pr-1862/src/components/editModeKeepalive.js\":\"47b184548b7f64f1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ef68436caf29793a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"037393033659ea53\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefPropertyEditor.js\":\"633c52de893aa86a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/RefTargetTypePicker.js\":\"0a341058142d0ac6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/SelectPropertyEditor.js\":\"8c796bef09d92e80\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/TypesPropertyEditor.js\":\"85d92589e136533f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/defaults.js\":\"98e15b8cb0ad2baa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/kernelValuePresets.js\":\"b808bf7f02df6601\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/selectablePresets.js\":\"919982f7fc8b868c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyEditors/typesPropertyUi.js\":\"3a853298708531f0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/AddPropertyForm.js\":\"ce72cfe64fda1618\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyPicker.js\":\"5654e436fb5bbffd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/PropertyRow.js\":\"4ea347be97f71112\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/Rows.js\":\"a9834beea3fb2e1d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/actions.js\":\"0b4ac6cccf5a2670\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/declarationOnly.js\":\"bda415300cf55409\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/layout.js\":\"4fed61e9309ffc25\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/model.js\":\"4d55a487b1235fe3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapeUi.js\":\"731f69f07effc2ef\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/shapes.js\":\"1b4996bc46dd1016\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7d6bb87eccb2f012\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanel/visibility.js\":\"c729687a2e47992a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/propertyPanelSections.js\":\"79fd554984d8fd06\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockEmbed.js\":\"97a4463671573030\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockLink.js\":\"38fc6133aecda3cc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/BlockRef.js\":\"9d04a2390c9e4407\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/CompactReferenceLink.js\":\"172f63ba49acae9c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/ReferenceLink.js\":\"427d4bcb68aec3aa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuard.js\":\"da2e2f7ba01e7171\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/cycleGuardContext.js\":\"3b89acd6c29bc35f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/linkInteraction.js\":\"7287abb2a727c323\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/referenceLayout.js\":\"0934e1e96271de98\",\"/knowledge-medium/pr-preview/pr-1862/src/components/references/useBlockRefAncestors.js\":\"7c66896a4d1006c7\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockGutter.js\":\"f7019d2cb44cd430\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockInfoDialog.js\":\"ea73331b716ee450\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockReadText.js\":\"0d175a87efed1259\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BlockTypeBlockRenderer.js\":\"0385e932ded2a9bd\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/BulletHoverCard.js\":\"b0a177450ed8c6e4\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorContentRenderer.js\":\"ccf64af2fba9c2fe\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"80c6ca0c0dc1f200\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ColumnResizeHandles.js\":\"867e426e9ef81233\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"998c64de7d096403\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/DefaultBlockRenderer.js\":\"60e1c5547416c38c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/LayoutRenderer.js\":\"ce4ab617b4e3b803\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MarkdownContentRenderer.js\":\"343b61db5f7488ec\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/MissingDataRenderer.js\":\"12044aa2ef4ac2d1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PanelRenderer.js\":\"95ca679ea3ae2e67\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ed371886b6c40b0d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/TopLevelRenderer.js\":\"fcfd664ba103a808\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockGutterMode.js\":\"adb378ba3005aae0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/blockTitleText.js\":\"f3adf32f464b2e94\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/fieldCreationKeydown.js\":\"bf9511818fcc893b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/renderer/layoutRootContext.js\":\"a9f3b4d5d42ec169\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/TypeChip.js\":\"24a4b83489a8f05c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/typeChip/chipStyle.js\":\"bd14f196ff2eef62\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/anchored-floating.js\":\"0c0bf6ab3299bada\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/button.js\":\"82255289e9ed4517\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/card.js\":\"b524ea5f30d845b3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/checkbox.js\":\"0d379e940cae3026\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/collapsible.js\":\"651bf0a82da0dbae\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/command.js\":\"0b6832fbf4c8e75c\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/context-menu.js\":\"81a026c1fa820ca1\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dialog.js\":\"fc639552d154b238\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/dropdown-menu.js\":\"05b07327cbea9bf6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/floating-listbox.js\":\"f1b92bd7245fddc5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/index.js\":\"57fcd668297bd5bb\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/input.js\":\"188f5af73fce596d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/kbd.js\":\"73f4ee85f350d45a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/label.js\":\"e11ddc860e45a9dc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/ui/textarea.js\":\"c58f02352585b3aa\",\"/knowledge-medium/pr-preview/pr-1862/src/components/useEditModeYieldKeepalive.js\":\"1ab3db7f0a5feb63\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/BootFallback.js\":\"d682841a9338040d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/FocusedRowLazyMount.js\":\"ee7ad88964e21c09\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LazyViewportMount.js\":\"04e7f1377b045e7e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/LocalDbCorruptionFallback.js\":\"97e1ef7932e3612d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/error.js\":\"70c84d6d528aa93e\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/lazyMountRegistry.js\":\"82e2f84134286bd3\",\"/knowledge-medium/pr-preview/pr-1862/src/components/util/suspense.js\":\"eaecc91f7d436658\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/CreateWorkspaceDialog.js\":\"1a162e4de7919698\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/PendingInvitations.js\":\"f86197dd0040d396\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/SyncProgress.js\":\"c14d34435e1f8635\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/UnlockProgress.js\":\"76b32493eafd2fd0\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceKeyGate.js\":\"db23fa7f881779ca\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSettingsDialog.js\":\"a6c1d3e9961d1b0d\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSwitcher.js\":\"61df0be567effd24\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/WorkspaceSyncGate.js\":\"a718498df8b0507f\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlow.js\":\"bf8e24bb4470fadc\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/ConversionFlowHost.js\":\"4a88e7c3ffc800a5\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/EncryptionSection.js\":\"99d2ffdda32db39b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/attachmentPrompts.js\":\"b4416db0c9953854\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8cf2692461ac7a39\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowDeps.js\":\"37e3060ecaa16e38\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/conversionFlowStore.js\":\"58464af3d7eae70a\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/flowUi.js\":\"435e253a005ce2ee\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/conversion/useConversionRun.js\":\"3b968752b206f709\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/keyUi.js\":\"dcb23722ea46c63b\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnKeyLoss.js\":\"8850d704340ec063\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/useCloseOnServerE2ee.js\":\"36d54e190dd803c6\",\"/knowledge-medium/pr-preview/pr-1862/src/components/workspace/workspaceUnlocked.js\":\"9d4601190aeebfe8\",\"/knowledge-medium/pr-preview/pr-1862/src/context/backgroundSubtree.js\":\"57035da31a125dde\",\"/knowledge-medium/pr-preview/pr-1862/src/context/block.js\":\"5d50de434d3af188\",\"/knowledge-medium/pr-preview/pr-1862/src/context/layoutWsContext.js\":\"2f01256b4d605244\",\"/knowledge-medium/pr-preview/pr-1862/src/context/propertyDisplay.js\":\"ac7fe3b518cfeed7\",\"/knowledge-medium/pr-preview/pr-1862/src/context/repo.js\":\"4bc94ef1dfb98b28\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasClaim.js\":\"cf2338d04eb5d436\",\"/knowledge-medium/pr-preview/pr-1862/src/data/aliasSeatNamespace.js\":\"de1567529095cfad\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockData.js\":\"65b13f5e2a351841\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/blockType.js\":\"7a0f23598b950d69\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/changeScope.js\":\"87f2e57ae75a193d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/codecs.js\":\"ca44cd9e98e59c69\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/derivedData.js\":\"a2fc19f5790ce3f7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/errors.js\":\"5a87596543585e9c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/events.js\":\"fb84f5eac312b2ff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/handle.js\":\"3760dcd752127d7d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/index.js\":\"74952973bedd7fdc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/mutator.js\":\"41b25640879cf692\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/processor.js\":\"3ac5438f1dc00a1e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/propertySchema.js\":\"904bdf471b54ab9f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/query.js\":\"9acf33663e05cc56\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/sameTxProcessor.js\":\"e7cfa66cd461c62b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/schema.js\":\"3760dcd752127d7d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/tx.js\":\"3760dcd752127d7d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/typedBlockQuery.js\":\"e20ece16a2bf1b6a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/user.js\":\"b4ab934aadb01cfa\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresetCore.js\":\"fa7d813448a7f0bb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/api/valuePresets.js\":\"9469cbaee338c390\",\"/knowledge-medium/pr-preview/pr-1862/src/data/attachmentCleanerIOVerb.js\":\"36c88b918f06f670\",\"/knowledge-medium/pr-preview/pr-1862/src/data/block.js\":\"bd809ae9d9cb61ef\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockCache.js\":\"ce90c413af47b4c9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockId.js\":\"8ac608ff59d5a488\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockLiveness.js\":\"70b4fa6912038227\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockMerge.js\":\"518b2d9b51cab705\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockSchema.js\":\"b5e81a806467f6c7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypeLookup.js\":\"b55e0129fd714bdf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/blockTypes.js\":\"b51abbfef5a2962f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/childrenView.js\":\"5ec918004daa769a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/clientContext.js\":\"798cc57326413368\",\"/knowledge-medium/pr-preview/pr-1862/src/data/dbFileSiblings.js\":\"e858412c97c1201c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/definitionSeeds.js\":\"4573e1cdd5bd6ab7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/derivedIds.js\":\"76eef64fd060dd46\",\"/knowledge-medium/pr-preview/pr-1862/src/data/drawnSubtree.js\":\"3da1f01ea2ef2442\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facetBridge.js\":\"c426265c7954d4bc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/facets.js\":\"89691958ab39504b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/globalState.js\":\"0064ccdb6188febd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/aliasClaimRederiveProcessor.js\":\"d83d7d639e0cbbfe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/ancestorBatch.js\":\"bd2fd8b268b3b7d9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/blockTypeTypeifyProcessor.js\":\"e2e966b17026b48e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/clientSchema.js\":\"b94293b98b9de58f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/commitPipeline.js\":\"87927003f07f1179\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/devAssertions.js\":\"cf335a57609e126a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/firstSync.js\":\"54ca69907c10a682\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/freshInitialLoad.js\":\"7c277f20fdec20c7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/graphBackfillClaim.js\":\"71be5df73210d659\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/handleStore.js\":\"4b01645548ff776a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/idleMarkerJobs.js\":\"52b928b4e2bcf152\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initialDownload.js\":\"35c848091033ee6f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/initializeClientDatabase.js\":\"309e001524a146b9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/jsonCanonical.js\":\"13a2bfd5582e2950\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelInvalidation.js\":\"4c26b59fde6215e4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelProcessors.js\":\"d7c0d3cd160fc2f8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/kernelQueries.js\":\"b1487603f927e0ff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/mergeTypeMembershipProcessor.js\":\"e90aac800bdac8a8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/normalizeReferencesProcessor.js\":\"99970c39ef00006a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/poolInstrumentation.js\":\"5d58bb135d823cbe\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/processorRunner.js\":\"cbe431b76ec3cce5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyCellBackfill.js\":\"53b8d83336578940\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildMint.js\":\"e136d7bf5b6de491\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyChildrenProcessor.js\":\"6920e65a89bb0fb6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionChangeProcessor.js\":\"75ec6b8f02518b47\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyDefinitionSynthesis.js\":\"187c0b52663902c7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyKeyScan.js\":\"a3739b5b954a9e7e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertySchemaResolution.js\":\"37b8d370b43a8fb3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/propertyValueEdits.js\":\"456f5409a83e036c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/raiseProtocol.js\":\"270843f1bc438398\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/readBatch.js\":\"a668320d9436f5d7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/refProjection.js\":\"d438c4f5fa3416e9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetLookups.js\":\"b489f25cb17c92fc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/referenceTargetProcessor.js\":\"af66c70f31ff91fc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/replayMerge.js\":\"dec162b3b15df277\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/sqlBinds.js\":\"97f162ece8a64ab0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"87ddd25da50dbbd1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/arrivalProcessors.js\":\"2079c8c0d16339ed\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/invalidate.js\":\"18b510099f7934b8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/materialize.js\":\"8648d57acb7b7c9c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/observer.js\":\"cd0a119d23f25b84\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/syncObserver/reconcile.js\":\"35db0ab390dc193e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/timingMetrics.js\":\"2fee2ec6754946a8\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/treeQueries.js\":\"0ad1c2059a0ae90f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txEngine.js\":\"ada83e033594c116\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/txSnapshots.js\":\"2c1c610c30a10419\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/typedBlockQuery.js\":\"4306c8067881db09\",\"/knowledge-medium/pr-preview/pr-1862/src/data/internals/undoManager.js\":\"1b1a571212f43c56\",\"/knowledge-medium/pr-preview/pr-1862/src/data/invalidation.js\":\"3fa2962e49efa974\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelDataExtension.js\":\"4453b05f80f1fb3e\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelPage.js\":\"579a061180324262\",\"/knowledge-medium/pr-preview/pr-1862/src/data/kernelValuePresetCores.js\":\"a401c25a07a1fb9f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbCorruptionSignal.js\":\"6728dca83305cb44\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbStorage.js\":\"4b15fe619430afa7\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localDbVfs.js\":\"b631acee433ae17a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/localSchema.js\":\"c03e2e5498b1f5d5\",\"/knowledge-medium/pr-preview/pr-1862/src/data/maintenance.js\":\"a820b6358c8b2e0d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mergeProperties.js\":\"b738b8a2f5dbf50b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/metricsConsoleHook.js\":\"b0eae03cc9eebe23\",\"/knowledge-medium/pr-preview/pr-1862/src/data/migrationsPage.js\":\"231de5c18f1dbcdc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/mutators.js\":\"a0bf3572a54643b1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKey.js\":\"21f3c7a0d42f85c2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/orderKeyPlacement.js\":\"85eab3d18c40b425\",\"/knowledge-medium/pr-preview/pr-1862/src/data/outlineSurface.js\":\"40133078bd12ae7f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingEditorContent.js\":\"aa5598241e240fdd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pendingUploadsSql.js\":\"557e52c89a15290c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/pluginStateExtensions.js\":\"4767dd5c54ea1f39\",\"/knowledge-medium/pr-preview/pr-1862/src/data/powerSyncLogger.js\":\"682b6f19c25b0328\",\"/knowledge-medium/pr-preview/pr-1862/src/data/projectorRuntime.js\":\"8c72c33b2318b27c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/properties.js\":\"6ff03aeb38b302ab\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertiesPage.js\":\"1d9558ed25bf5b17\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyChildren.js\":\"a2a408433e48b46f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionFanout.js\":\"891b5dc42e2a2ccf\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionMetadata.js\":\"64644419bc90ccd9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDefinitionRegistry.js\":\"5736138366c4cd05\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyDisplayMode.js\":\"867d6c3478c891df\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertyRowCreation.js\":\"822512970b7372d9\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySchemaCreation.js\":\"bbf34498d187941b\",\"/knowledge-medium/pr-preview/pr-1862/src/data/propertySeeds.js\":\"9dfe3f3195706d93\",\"/knowledge-medium/pr-preview/pr-1862/src/data/recentsPage.js\":\"58e41b4fae3e5307\",\"/knowledge-medium/pr-preview/pr-1862/src/data/refTargetComparableProperty.js\":\"18b4030fcb8a6ed1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/referenceBlock.js\":\"b61adb26acc11b00\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rejectedUploads.js\":\"2a8737bae0fb76eb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/releasePowerSyncConnection.js\":\"2f61bc407480594d\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repo.js\":\"639627b450826894\",\"/knowledge-medium/pr-preview/pr-1862/src/data/repoProvider.js\":\"95a77810cf3fac37\",\"/knowledge-medium/pr-preview/pr-1862/src/data/rowProperty.js\":\"8f71d7b8e386a786\",\"/knowledge-medium/pr-preview/pr-1862/src/data/searchFilter.js\":\"bd671e75ad6246f2\",\"/knowledge-medium/pr-preview/pr-1862/src/data/seedIdentityLedger.js\":\"e043c1f1de748fcb\",\"/knowledge-medium/pr-preview/pr-1862/src/data/stateBlocks.js\":\"7f0874da6c78c7af\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralEditPolicy.js\":\"cffe5d0e4ed0d828\",\"/knowledge-medium/pr-preview/pr-1862/src/data/structuralInsert.js\":\"cd7039aa83777296\",\"/knowledge-medium/pr-preview/pr-1862/src/data/subtreeDelete.js\":\"6ba957afd97491cd\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncStreamLock.js\":\"a04d8ed29564f08a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableSqlRecognizer.js\":\"6ba4b4b2a366c779\",\"/knowledge-medium/pr-preview/pr-1862/src/data/syncedTableWriteGuard.js\":\"c3fa519697e8393a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/targets.js\":\"ea4defad593e6f36\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeColors.js\":\"077e62e0787fb292\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionMetadata.js\":\"b185083492c80f50\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeDefinitionRegistry.js\":\"f33c1fb995052fed\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeExtraction.js\":\"5e684d31161522f1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeInitialValues.js\":\"97a745ed9a1bb386\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typePropertyGroups.js\":\"beaad4d4c3918c9a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeSeeds.js\":\"c4d2d925212fdb07\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typeTagger.js\":\"e412d829ca8d26b1\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typedRecords.js\":\"fa3ff1be3f2941b4\",\"/knowledge-medium/pr-preview/pr-1862/src/data/typesPage.js\":\"d0a4be7dd1d85ac6\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userPrefs.js\":\"211c94896ba693ad\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userSchemasService.js\":\"76326d0db44e163f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/userTypesService.js\":\"08c82b6da88aa94a\",\"/knowledge-medium/pr-preview/pr-1862/src/data/valuePresetRegistry.js\":\"cfac2c1aec92878c\",\"/knowledge-medium/pr-preview/pr-1862/src/data/visibleChildren.js\":\"05738cef885e87f3\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceConversion.js\":\"58570f5d753a246f\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceFirstSync.js\":\"6c6e6f586b40b829\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceIdNamespace.js\":\"2cb0ac513db38bff\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaceSchema.js\":\"783f5762507eaefc\",\"/knowledge-medium/pr-preview/pr-1862/src/data/workspaces.js\":\"2917476dd84a75d0\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadLog.js\":\"8fd72f9843e35442\",\"/knowledge-medium/pr-preview/pr-1862/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/BlockPasteShellDecorator.js\":\"89d0f8c6751a1fe2\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/atTrigger.js\":\"a8fcfe01adee1228\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/autocomplete.js\":\"bc807324ce71bd99\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/codeMirrorExtensions.js\":\"2e749e7d9998e0a8\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/contentFlush.js\":\"fd5e67ddb809ec8c\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/defaultInteractions.js\":\"5c7909d5760fa21b\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/editSettleSignal.js\":\"84949440e7e30d8c\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/insertImage.js\":\"4a2580587fcf5ac7\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceCompletionRange.js\":\"9ed38def3307172e\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/referenceTargetTypes.js\":\"ff2fb4eb277537c1\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/syntaxContext.js\":\"6a5fcddb0ba4e065\",\"/knowledge-medium/pr-preview/pr-1862/src/editor/triggerMatch.js\":\"80a9cd3033935385\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/AppRuntimeProvider.js\":\"63ea57fd7bf961c5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/BlockFocusShellDecorator.js\":\"0657aa40be1e42b0\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/ExtensionRenderBoundary.js\":\"f23c668bf8868e29\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/PanelContentRecovery.js\":\"2f13212db99f48b6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/apiCatalog.js\":\"6480ffd6adb00e73\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/approveExtensionHere.js\":\"5d0a08adea331e79\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/armedCutAppMount.js\":\"537ad651c06de389\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/batchableKeyedStore.js\":\"f42a121450e1ec96\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockInteraction.js\":\"959e811405f13cb6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/blockSelectionAction.js\":\"2bd5ee235972b3d5\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compileExtensionModule.js\":\"4a961bbe6d5ce83e\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/compiledModuleCache.js\":\"87d43f38c88c9e23\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/continuousGestures.js\":\"792b4b4fe04070cf\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/core.js\":\"31887eaeb0ced1bf\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/defaultRenderers.js\":\"0e6cfffebe9a7dcf\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/definitionFanoutAppMount.js\":\"85fc1450ffa23586\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dialogAppMount.js\":\"a9f5b8c1c80bceaa\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensionSeeds.js\":\"2db7f04d878a97ca\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/dynamicExtensions.js\":\"1ec20288cd02866a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/exampleExtensions.js\":\"2e1ef9bc36da2112\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionApprovalStatus.js\":\"692a32c2080d71fc\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrorToast.js\":\"e5c1197fe4f58f74\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLoadErrors.js\":\"b166ccb86cee1b34\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionLookup.js\":\"bbffbcf9dc6d1bae\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionToggles.js\":\"cfd3d3b3ab99d522\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/extensionUtilitiesCss.js\":\"2e882c7f4e3271e1\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/kernelPageDeletionGuard.js\":\"2ac8fa4135bf3e0c\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/liveRuntime.js\":\"803fbf9bf9645025\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/openExtensionsSettings.js\":\"ed766bd692c09734\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/overridesCache.js\":\"a0b7c29daa2757d6\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/pluginIds.js\":\"3557e56c602b2686\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/processorRejectionToast.js\":\"7e74812b59f21b96\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeActions.js\":\"4eec99508e9c988f\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/runtimeContext.js\":\"2c53ff1f6e2b7eeb\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticAppExtensions.js\":\"766fc2338a53beb4\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/staticDataExtensions.js\":\"0002c52471f1153a\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/toastAppMount.js\":\"85660e0b7adae005\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useOverrides.js\":\"cbb40fd011fc7ac3\",\"/knowledge-medium/pr-preview/pr-1862/src/extensions/useShortcutSurfaceActivations.js\":\"3c75da7dcd2edab0\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/discoverToggleTree.js\":\"9f247142ad855d20\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/facet.js\":\"336c96713b8b4a11\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/resolveAppRuntime.js\":\"b69239a01b4da9c0\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/runtimeEvents.js\":\"9ada80f3bac2de65\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/togglable.js\":\"b17b0ce621c75e5a\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/variantFacet.js\":\"4547200cec1c5821\",\"/knowledge-medium/pr-preview/pr-1862/src/facets/verbFacet.js\":\"09d8a958e69a7698\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/block.js\":\"bad68330d472d93e\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/focusedChild.js\":\"9e98cfc39dcf41bb\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/propertySchemas.js\":\"15908cebd27df6e2\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/typeRegistry.js\":\"9f6fa3314e571a29\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAncestorCrumbs.js\":\"696e87a486a92e0a\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useAutocompleteListbox.js\":\"976e4f611779ad76\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedSearch.js\":\"a8360847576d7c32\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useDebouncedValue.js\":\"2e47bb0d71be5d35\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useFacetValue.js\":\"15431035247cbe7e\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsFocalRender.js\":\"4eaf9f1abc4ec4e1\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useIsReadOnly.js\":\"cbbb1a9f150c3a7c\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMaterializeBacklog.js\":\"3c275195737a68e8\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useMinuteClock.js\":\"6ea617be6e765b5f\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePanelLayoutProjection.js\":\"df429482080a6568\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/usePendingInvitations.js\":\"49617cccea9347b6\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRendererRegistry.js\":\"57c7f040ed1a4c33\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useRetainedFieldRows.js\":\"53e2e4a50b1b9612\",\"/knowledge-medium/pr-preview/pr-1862/src/hooks/useWorkspaces.js\":\"031447234614cdbe\",\"/knowledge-medium/pr-preview/pr-1862/src/lib/utils.js\":\"980243cbb769028a\",\"/knowledge-medium/pr-preview/pr-1862/src/main.js\":\"ebbe6907ea423059\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/MarkdownImage.js\":\"4d1cb2a32857cf20\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/blockSeparators.js\":\"1aec19ae60b57f46\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/context.js\":\"c80ee77d0d360ef0\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/defaultMarkdownExtension.js\":\"1cb62fb257f653c6\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/extensions.js\":\"0e9c295e1a8d9160\",\"/knowledge-medium/pr-preview/pr-1862/src/markdown/renderMarkdownHtml.js\":\"76061ef8b1b6fca1\",\"/knowledge-medium/pr-preview/pr-1862/src/minimal-editor.js\":\"a10ea95aadf984d2\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/armedCut.js\":\"335489065636e4d2\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/captureMediaVerb.js\":\"fb5366b59a610ed3\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/clipboard.js\":\"0fe59f2b1bc3c395\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/decision.js\":\"4c670437a994f860\",\"/knowledge-medium/pr-preview/pr-1862/src/paste/operations.js\":\"4e1b3c3c091355c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/AccountHeaderItem.js\":\"55960796febb0831\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/account-header/index.js\":\"45166eacc1f9527d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a605b14539d92c5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askAgent.js\":\"4618e853cf6c0bea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/askedStore.js\":\"c45986de3528fc5a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ba7030b37b3f23a3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/chipState.js\":\"b5b3f9282498edd4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/dataExtension.js\":\"37e6a76660f71e95\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/index.js\":\"6d7bee65e868dff6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"eccdad3e4064c24f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-dispatch-companion/schema.js\":\"91f6082cf1de6fcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/AgentTokensDialog.js\":\"aa2ae944dee992ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4fd743986d55bc84\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/addMedia.js\":\"61089028c8fef9cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4aed7ec286e34b3a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/block.js\":\"cdf869fe6eaa3b2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/context.js\":\"715ff81ca5394559\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/displayIds.js\":\"681566b3ce235b29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/index.js\":\"2bb01284aae1926c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/outline.js\":\"4d1c96e251f9ed73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/properties.js\":\"a92fc3268752b961\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/refs.js\":\"7be681d759debe31\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"54950e2749531087\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/search.js\":\"6f22fe1f1e1d4175\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/shared.js\":\"4f511796ca20cee7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"77d6670acb487176\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentViews/text.js\":\"cd16aedd6bca9a88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/agentWrites.js\":\"323f8410675b0c68\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/authoringCatalog.js\":\"2c965d013ec1d2dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/blockRefTargets.js\":\"2c2d239818e31909\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridge.js\":\"1c5cc70b55e99f25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/bridgeLoop.js\":\"f2f4f0e50d51e10e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/changeHistory.js\":\"b5ebba7c4760f71f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commands.js\":\"81734bfe5b67f70a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/commentsCommands.js\":\"0f324b2a9880b83c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataExtension.js\":\"f77d15ca3dfc6bf1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dataModelGuide.js\":\"6eb9c8771673443b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/dayPropertyInputs.js\":\"0d24b356a15e8dea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/describeRuntime.js\":\"7a5ce938e659de13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/extensionLint.js\":\"8f30554e51461b60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/grainAudit.js\":\"701feebf91abd8e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/healthCommand.js\":\"d1d006669127304d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/index.js\":\"9f2e454411c7ab00\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/presetIdentity.js\":\"ed909d8180dd8913\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"de0253d7d4a51f1c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/readMedia.js\":\"a54095e383f85df0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/schema.js\":\"66715d6bbeee791d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/serialization.js\":\"6fd17df7dc896f6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/targets.js\":\"bf824738805b9430\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/tokens.js\":\"06938e116b3887ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/watchEvents.js\":\"ff3f4d791396ea61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/workspaceGuard.js\":\"294ae037697224f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/agent-runtime/writeCommands.js\":\"7d51e9a7582e2d08\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/AliasCollisionToast.js\":\"5636358f9bed0432\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/DuplicateNameBanner.js\":\"477057b275844ec3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/collisionMerge.js\":\"697ff60411e9faac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/dataExtension.js\":\"02593349e373ea12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/index.js\":\"dd87994aa93a407c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/mergeCollisionAction.js\":\"998e062fb6f08c34\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/pageStyling.js\":\"bbf2a431191b6c2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/rejectionToast.js\":\"846613b07f643cd9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/alias/syncProcessor.js\":\"bc9ca0c6ab8483c0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/actions.js\":\"c8eb441b144d116b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/addComment.js\":\"aa855fa09b02a700\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchor.js\":\"945af792a9db7f3f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/anchorState.js\":\"5c681da74c926e8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/commentLinks.js\":\"0fe16f3f1799b52d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/confirmThreadDeletion.js\":\"8a397f9e67db19ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/container.js\":\"d247e69efbd3f72a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/dataExtension.js\":\"a71f4a587270abb3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/deleteComment.js\":\"ca0376d6bd05eba8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/highlights.js\":\"d705f3d68e880721\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/index.js\":\"8faa303a9ae836dd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/linkedCommentsPill.js\":\"de826f4114d3412f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/margin.js\":\"1ba7323300e688d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginAnchorLinks.js\":\"609e46780c79529a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/marginSchema.js\":\"ea43e7d4652eac56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/newComment.js\":\"70940865d7013c20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ownThreadPicker.js\":\"d26e70db389e02c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/placement.js\":\"f603531a10a11e29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/queries.js\":\"9d25f7c28aa6485e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotePosition.js\":\"da11c49329bfc10f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedIn.js\":\"4337b5687b35808f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/quotedRange.js\":\"fc1afa49f66cfd6b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/rangeRefs.js\":\"fd207f2210894f9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readHighlights.js\":\"ad13ef8139b1740a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelection.js\":\"33d4b73a3732653c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/readSelectionUi.js\":\"f5cf47cc9cce6b1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/reanchor.js\":\"4c880ab47740c41d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/schema.js\":\"4f25894840c893c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scope.js\":\"09d9efc5b2517e76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/scopeThreads.js\":\"3771e5d6e86ca956\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/splitRetarget.js\":\"8464ed92821306b2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestionCard.js\":\"9f0fe41e9477e355\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/suggestions.js\":\"b9a3c6e8a25402fc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaries.js\":\"756c06e48cc9eb94\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/summaryBatch.js\":\"1ff27577e92c4207\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/surface.js\":\"b034807e9c646228\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threadNavigation.js\":\"eae608dddc626b0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/threads.js\":\"efee4a8f1b3d009e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/ui.js\":\"ca941d9f7316f6c1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/annotations/uiStore.js\":\"4c1f63a0b4ac7678\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/appIntents.js\":\"b21c6ce58da6f3ad\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-intents/index.js\":\"7b6a0540458bd101\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/index.js\":\"1391fd5d9206f245\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/app-update-prompt/status.js\":\"768481b1e0f19188\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b9041c30393aab77\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaBlockRenderer.js\":\"2019a54f9afce5e3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8dbefa2bcbec813d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/MediaUploadReconciler.js\":\"59eb08fec090f545\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetDownLane.js\":\"03a157faa0ff6dde\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetResolver.js\":\"8c2ae1ac3bd6555a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/assetUpload.js\":\"d405d40239befaf9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/attachmentCleanerIO.js\":\"a352f41182a9155e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/supabaseAuditIO.js\":\"17b9c0d31a7858a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/blobStore.js\":\"dcd51fd298a4ba56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/browserMedia.js\":\"b66676f9e42594b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/byteStore.js\":\"2b8ae89f97be46a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanerIO.js\":\"7050b23dc6d74082\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/cleanupAttachments.js\":\"2733d7300443af36\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/dataExtension.js\":\"57ce22b46fb7fa6a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/downLane.js\":\"ce6ecec7b5180f7f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/index.js\":\"e1dc564da62998e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/insertImageContribution.js\":\"6b3412ea91ac8564\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneArming.js\":\"ea3a9c5312910f1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/laneLock.js\":\"c02d9ff35b585b02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaBlock.js\":\"675adacc3621631c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaCapture.js\":\"056cd0db883ae46c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaLanes.js\":\"90e9cd69cee8739f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewers.js\":\"221325c1c7168ab9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/mediaViewersFacet.js\":\"6750ba2c1d65ca65\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/pasteCapture.js\":\"28906b377fcf4f16\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/resolver.js\":\"824323530220f3e0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/retryUploadsAction.js\":\"00901f61c5377f96\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/storagePaths.js\":\"a9859aea3cb3716e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadDrain.js\":\"41befe472183d701\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadLaneStatus.js\":\"803619647a086f60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadReconcile.js\":\"f4eb6c85bcb7657f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadRecovery.js\":\"fac55d23189a1dee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/uploadStore.js\":\"d24f00193a5ca104\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/attachments/useAssetObjectUrl.js\":\"29d367bb7fbf25ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"06e0ecbe1c1c9fce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/BacklinksViewSection.js\":\"99bfcfa2c9509fce\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/facet.js\":\"d08e13bba324e0d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/index.js\":\"636b7fd6121d8950\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks-view/prop.js\":\"c402803b22667d88\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinkFilters.js\":\"e32d46a52d64ac72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bd3c837e6480e879\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/BlockEntry.js\":\"3721bd95955589aa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/LinkedReferences.js\":\"3026f14594143203\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"95dea2c12dca7551\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dailyNoteDefaults.js\":\"9d18b3b7d23cbf27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/dataExtension.js\":\"27b05e24a60a5e0d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/edgeExclusions.js\":\"aafb0c7448122d14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/filterProperty.js\":\"0326a113eaf4202a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/index.js\":\"161dcfb59e932cf5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f0ba9d79266d38bd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/applies.js\":\"7e38edcbe1ebd477\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/countQuery.js\":\"6bc07908ee4b8080\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f40d50773ef7a558\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/index.js\":\"a6dad010397c997d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1bbf0e78682944d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/presentationInvalidation.js\":\"c23d0798f3383b59\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyEditorOverride.js\":\"50614d034ef848d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/propertyFilter.js\":\"9b74e44925745af4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/query.js\":\"644eb9629f25aec6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/resolveFilter.js\":\"dca2732915e40a9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sourceBatch.js\":\"bef9f5a2f4a4824d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/sources.js\":\"7ef3520ebc130ad4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useBacklinks.js\":\"bfb79eb74ed178cd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0f7097d6a2bd4b6d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayCelebration.js\":\"de0096e4649f255d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/BirthdayOverlay.js\":\"861c34982f7ed59b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/gate.js\":\"26efe1d780d95067\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/index.js\":\"1d517a9584ae0cfc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/birthday/wolfTheme.js\":\"0e56e164ec653797\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/BlockDragLayer.js\":\"11cc855634d7fa3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dragController.js\":\"0cfe503b410d14b0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/dropTarget.js\":\"497f6dc04f7e5127\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/index.js\":\"e21ca70c1f4dc9ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-drag/projection.js\":\"9d42c4f815bb5a80\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/BlockMetaCard.js\":\"1e5a23d399ff8987\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-info/index.js\":\"8fb0f1bfa5d00c2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/AddTagDialog.js\":\"e0dbd97f433ec49c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"246b299cbdb52f2c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/TagNameIssueHint.js\":\"ef522ee66966913c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/addTagAction.js\":\"7398beeec06ffb10\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/appendTag.js\":\"e403e11740e904aa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/config.js\":\"f8944e64afb5c3ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/dataExtension.js\":\"dafb2a90402eb37a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/index.js\":\"9c5fd6b0f6ba1f2f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/block-tagging/propertyEditorOverride.js\":\"9191a701b3567475\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbList.js\":\"452df7af20a0515d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"63cb4f7ecfbc21ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a67b3b173752b021\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a16fa2267d7c7fcb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9933c26d8b531ca5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/index.js\":\"44aeb3d6e6ff476f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b6a6ac795a015209\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/CharacterCountItem.js\":\"253c15d5b6f2fd2d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/ProfilePropertyEditor.js\":\"867cf91541a94b72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/actions.js\":\"d1b2163b2748e238\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/blockType.js\":\"652a64a9b117a639\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/charCount.js\":\"f4048689c0a333c4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/dataExtension.js\":\"8e95c62780d84080\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/index.js\":\"d1bd08cadb19436f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/profiles.js\":\"d345824d63b80e86\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/properties.js\":\"5f340f5ce9674f9c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/subtree.js\":\"3eea7b7dc3f72dd5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/character-counter/textCounts.js\":\"8daf553a62b73d61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/colemak-keybindings/index.js\":\"2e5dfc378dbd4dba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/CommandPalette.js\":\"8428df3a705d187d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/HeaderItem.js\":\"613bf146481d924d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/context.js\":\"d78e37baad4810a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/index.js\":\"3039fe699c5de681\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/selection.js\":\"43cc2177e9610581\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/toggleStore.js\":\"d6e14fc88126efd2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/command-palette/useCommandPaletteActions.js\":\"96e74cb9ce182fb9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ContributorBadges.js\":\"18544a817585cfa9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/ProfilePicture.js\":\"a656ac21737dac00\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/author.js\":\"c3427f1b8a3c8f52\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/codeMirrorExtensions.js\":\"6292e027abe7c1b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/dataExtension.js\":\"9b716d047d4c90b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/index.js\":\"59e61ff2c94a9d4c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/mentionAutocomplete.js\":\"63c6373383277b11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/processor.js\":\"9b68169eb0fa9ee9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/profiles.js\":\"062cfcaa0d29af7c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/queries.js\":\"de0386e5edc0e110\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/schema.js\":\"00d5c27e723cf517\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/contributors/useCommentAuthor.js\":\"1aa0d26a87e304a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c425eb9dbe8ad2f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a0160d4a1b6c173e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/index.js\":\"c79d09ff7666ab50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"bf4409a7469e1cc3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5c8bfb639eed2fe4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/CalendarGrid.js\":\"ebc0bb379e6b707b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DailyNotePicker.js\":\"b5b88471f412f1ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"99bb202b6e6afa22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateNavDecorator.js\":\"1d22af572337cecd\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DateScrubOverlay.js\":\"d8028e384eb17692\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DayPropertyControl.js\":\"cf892aa60e8a239e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/DayValueReferenceControl.js\":\"7436c7fdc8ee43ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/HeaderItem.js\":\"05060306dd8464a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/ReschedulePicker.js\":\"25ba7f74f4c8afd8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bf58109ca39c616a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/actions.js\":\"f3e9aa2f8c4150bb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/blockDateAdapter.js\":\"3b63d3812d562223\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/calendar.js\":\"9e976d7c4a0b74df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dailyNotes.js\":\"d92c7fa5d3775353\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dataExtension.js\":\"d303f623ec869767\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubActions.js\":\"9e66fc71df6b31d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGesture.js\":\"16eb88c216974be9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a5fdbc0328b7cc8f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dateScrubRecognizer.js\":\"278eb4ca21b3e97c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dayProperty.js\":\"4300546d4467a3ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2a38e9b801d1d78c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/deletionGuard.js\":\"2195c4a5216ed12b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/dueQuery.js\":\"57272a9437616d06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/index.js\":\"bd37296ce763810d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/landing.js\":\"955cad780cb1ba32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/localSchema.js\":\"c7b9d9861876eac2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/referenceDateAdapter.js\":\"0c5ec55f30d80616\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/rescheduleAction.js\":\"a22ded3a2c23548d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/schema.js\":\"54d691f8e65f1dbc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadBlockDates.js\":\"ce34cc6a72c3122d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/spreadDatesAction.js\":\"13ff6eede3ec797a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/today.js\":\"f56f17f9b46fc6ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ac82eeff72e427ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"53d32d36694876ab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/audit.js\":\"6fac66608f6510f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditAction.js\":\"e9b393fbedf95644\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/auditRanges.js\":\"df3a0042a9ec60f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/diagnosticsSource.js\":\"c900a67ce1c262dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/divergenceScan.js\":\"d91f7e4b49f6ecf0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/index.js\":\"70fc81d683ec614f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5bb5f33d98be21f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/referencesMirror.js\":\"47d784c09390ef62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/rowJson.js\":\"f4d96aac1afe3888\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/schedule.js\":\"ffa25859741cb3b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/data-integrity/store.js\":\"2f5f39553f6cf3c3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/action.js\":\"ee844365fae94dba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/index.js\":\"8850ed382d03628b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-maintenance/plugin.js\":\"a2940a1d756b5c96\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"cda3cc7247cd2b47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/actions.js\":\"333efafd30ca535e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/changeMarker.js\":\"320152db212f03f6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/diagnostics.js\":\"611dec80d94d7dfe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/fileSystemAccess.js\":\"da69486623d4ec3b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/filenames.js\":\"4f68bfc13359f596\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/index.js\":\"20f9b1cdda1de5a4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/mirror.js\":\"b496b4b47af120f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runLock.js\":\"fa025132b15dbb32\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/runtimeHealth.js\":\"a10e2f1e78368da6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/schedule.js\":\"1e17139502e99f50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/db-mirror/store.js\":\"0c2c583e7815e125\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/index.js\":\"9ae59c86917e2196\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/default-themes/themes.js\":\"ed3c5e08cbf05847\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/facet.js\":\"76755dea63ae2901\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/diagnostics/useDiagnostics.js\":\"429cda29ac8ecfdc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/dismissals.js\":\"6ccaab825b3dfaf9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/index.js\":\"04588b77444b7b26\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/status.js\":\"90da224c2b5ae236\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extension-prompts/store.js\":\"6334bb1255467897\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f4d4a717fe10849d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5c983ed58772812f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/actions.js\":\"c0fe8e53eb28215e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/config.js\":\"b0d09db35ef3dd5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/dataExtension.js\":\"6c5b811a172f8cd4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/effect.js\":\"159571d623d8cfcc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/index.js\":\"7f3ae3effcf677a2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/propertyEditorOverride.js\":\"41b370cb51ae6847\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extensions-settings/useToggleTree.js\":\"769fcc987ee065b9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/ExtractTypeDialog.js\":\"3bde24b26484669f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d1a5d1b9144c5053\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/PropertyShapePicker.js\":\"07da56898865ad06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/action.js\":\"34ea84a0b5db39d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/extract-type/index.js\":\"32936e5d26e23338\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/FindReplaceDialog.js\":\"85800f58961b70b5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/HeaderItem.js\":\"4b142ea5e3062244\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/dataExtension.js\":\"72eee80ff3f6d2aa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/index.js\":\"f1e09273bc76f16d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/search.js\":\"377d43d3920dfcd9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/toggleStore.js\":\"de58d5043da031b1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/LocationPropertyEditor.js\":\"58604381dd2c54b8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/MapView.js\":\"2320d80073aa1b8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/blockTypes.js\":\"1c991d89f3bcd145\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/codeMirrorExtensions.js\":\"4bb6ff1e2fc50525\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/createOrFindPlace.js\":\"9d799b8250f214a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/currentLocation.js\":\"f7a573e6353ec8db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/dataExtension.js\":\"86278a8fb4c78052\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/geoContentDecorator.js\":\"9e58ef9ec7e17ab1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/googlePlacesClient.js\":\"451c40a8a4d6811a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/index.js\":\"866d898f178ed2f8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/locationsPage.js\":\"25589d324436917b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/mapViewport.js\":\"a3153cbbb6b09256\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/pickCurrentLocation.js\":\"b04e6338618f6b12\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeAutocomplete.js\":\"0504aa234169bb72\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/placeNameCollision.js\":\"24b1aa9de68a382c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/properties.js\":\"c1028a1cd61f1bc9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/propertyEditorOverrides.js\":\"58633087feb60ee4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/query.js\":\"83e3790024da15ca\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/geo/usePlaceSearch.js\":\"f26c9401c6c4d1d9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"026d7aeb7e5436a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"98b0b1bf19a9bb38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"46be32e39ab9ab62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/config.js\":\"6718e23743202c44\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/dataExtension.js\":\"32e67bde2bec3440\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/facet.js\":\"84251b661b0f2bbb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/grouping.js\":\"13221941066bb594\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/index.js\":\"e53575503819713b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e4b234f07b7851be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/query.js\":\"211a3e7711590d5f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/resolveConfig.js\":\"2dcff1d8cdea1539\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3c50921ddb15cda5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2c487402e4fd7279\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlDocumentContent.js\":\"fb0199108cec0573\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/HtmlFrame.js\":\"a5713e40b968086c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/actions.js\":\"d065d238fa142c02\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/blockType.js\":\"c8fd4fda1ba56a8e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/confirmRunScripts.js\":\"0134fcb810bc5981\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/dataExtension.js\":\"71ef9b249461c34a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameAnnotations.js\":\"4369b62c96dfaa9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameDocument.js\":\"755411713b401d1f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/frameTheme.js\":\"eba4b9cf0ac6468f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/index.js\":\"abfef3ab8636d9a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/scriptConsent.js\":\"55ef0d4b0e27b241\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/sourceMap.js\":\"b416b004fac4f5ff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/html-document/useDocumentScripts.js\":\"66915adcd5cab40f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/index.js\":\"98945f57c69e0b9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/record.js\":\"12fea870baf61dcf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/recordStore.js\":\"98a1549a738fa29c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/responsiveness.js\":\"754f6245e18c33d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/schedule.js\":\"43ccd9d28385dd74\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/interaction-metrics/sessionContext.js\":\"717c0ac3862caed2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b1f7d93410868ba8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"16ae505449a8c2e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/actions.js\":\"5aeef7c0de9b40c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/config.js\":\"14748f949d601f62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/dataExtension.js\":\"140ac8fa44003316\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/effect.js\":\"5c437f287c2c9541\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/index.js\":\"68185732a5fabf97\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/keyCapture.js\":\"434c5501475f8b24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/overrideStore.js\":\"2638933cb2d33564\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ac4fe9146b211cc0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/HeaderItem.js\":\"df6823eeec609703\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/LeftSidebar.js\":\"055aab767a7aeee2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/actions.js\":\"4e434a0b7266ac57\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/facet.js\":\"37c230c23494a569\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/index.js\":\"f67c5212ceb69504\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/shortcuts.js\":\"ff58916987126d42\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/left-sidebar/toggleStore.js\":\"89606161b2ba9b74\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/MergePicker.js\":\"7834a7bc587fdaeb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/index.js\":\"1ae7d6565cace5b8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/mergeAction.js\":\"5b6ed7340695f974\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/merge-blocks/strategy.js\":\"1637cbbdc35ade74\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/Button.js\":\"14c9293cce35a3eb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"13185a2d8a304fa6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6e3af26b1e60df27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/facet.js\":\"d033f5c3deadd6ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-bottom-nav/index.js\":\"b806caa13d9ccd40\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a54e476d31853dff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/actions.js\":\"672814c906dec448\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3bc91dd1b0949729\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/facet.js\":\"18bcde0493394bef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/mobile-keyboard-toolbar/index.js\":\"0b2145942c252f1c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3472f2d2d4fa821b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/blockSubtreeMembership.js\":\"784bbe831d5606ee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/contextMenuItem.js\":\"93b0d738fe63c6ac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/index.js\":\"8e76089a885e5b66\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveAction.js\":\"1e8d2a08522127b7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/moveBlocks.js\":\"8d0825a822baf414\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/move-blocks/selectionAfterMove.js\":\"acb0944952593c5b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/TutorialBanner.js\":\"88482c6be61fbcb4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/action.js\":\"cd9b81ba898c0faa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/bannerDismissal.js\":\"c911e77bbfc60b92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/documents/cheatSheet.js\":\"c3eee8a631c63b92\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/index.js\":\"6304accbf64bc566\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/keys.js\":\"d7aa3c0630ddb67d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/landing.js\":\"9f87ed0b612c998d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/outline.js\":\"5ccab79d43359ae5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/onboarding/seed.js\":\"5f3fe2b647e92b56\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/PerfTrendDialog.js\":\"811146271e99671e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/analyze.js\":\"981cf1385e4fcec8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/diagnosticsSource.js\":\"344020fddd0edc64\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/index.js\":\"801de5a2e0233b06\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/load.js\":\"aa56c4e8068d0df6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/monitorRun.js\":\"aa23c8e78d32b0e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/schedule.js\":\"393b891a6923ab62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/series.js\":\"d3c4c9155349559f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/store.js\":\"adc97ecbcc7adeff\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/trendAction.js\":\"22b58752a8985099\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/perf-monitor/verdict.js\":\"42416add6882985c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/clickToEditAction.js\":\"91c874f039b87adb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/index.js\":\"2558bbe221289b25\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/plain-outliner/interactions.js\":\"8dfd4543fda24cf5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0d9bc42ccf6d32f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGate.js\":\"faeb428394fa0aa8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/MigrationGateDialog.js\":\"964166f2241d64c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/action.js\":\"9014065efb27d079\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/index.js\":\"4ca02a50d8e9d673\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/localRunMessage.js\":\"1e546f07be0443a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/plugin.js\":\"2bf21be18e171324\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/progressReport.js\":\"28286d1a07eadb55\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/properties-migration/sweepProgress.js\":\"311d0c575e5159e9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/FieldRowRenderer.js\":\"cb5253af5f0d4cec\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/ValueRowRenderer.js\":\"4ca0c0c5cf2f1662\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/actions.js\":\"cc428e024951d909\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/autocomplete.js\":\"030b90d4c4c04a50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/fieldRow.js\":\"5c8df51e43ec3537\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/index.js\":\"89520086e7d07199\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/referenceWarning.js\":\"4b687a85dd735cba\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueAutocomplete.js\":\"7e241427c0b7c376\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/property-rows/valueSchema.js\":\"d00b7597491c8278\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/HeaderItem.js\":\"0b8805dbad280db6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/QuickFind.js\":\"28e617c13de126dc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/index.js\":\"6757a3506f5292ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/recents.js\":\"c20c0d642dd9c2db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/resultItems.js\":\"0285eb419e008cd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/selection.js\":\"8e1f84e0259ae965\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/quick-find/toggleStore.js\":\"bb3cf2a9be074eee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/HeaderItem.js\":\"011608c4d5baa4e2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/RecentsPageBlockRenderer.js\":\"fa8ba334502880a7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/grouping.js\":\"f02779d742beb118\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/index.js\":\"e879c5b7796be226\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/recents/target.js\":\"131284121a68e043\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/codeMirrorExtensions.js\":\"ff2da01065cea357\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/contentPrefill.js\":\"3f7110a047ce3e7a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/dataExtension.js\":\"adb018eaf4adb16b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/index.js\":\"95ef0d61dd7245fa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"be037b740ea72404\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/invalidation.js\":\"72a321b08c374181\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/localSchema.js\":\"8fbfb68e67e38574\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/index.js\":\"704a0fa4b0f20067\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d9803d7658fe5451\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/index.js\":\"930acb8c41116510\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/referenceNode.js\":\"796c04a2921657b4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/remark-reference-occurrences.js\":\"edd9d589d2361d27\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3ca9c716735177fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/index.js\":\"585174decde1f2d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"88728858f582b25e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ec4933861f26e54f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/mergeRetargetProcessor.js\":\"373fce27479bae0f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/parseFence.js\":\"2111d67c5f180d24\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceParser.js\":\"1448474aafd00aac\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referenceProjection.js\":\"49db9272e30cbb6f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/referencesProcessor.js\":\"19b209e7d93d8626\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/renameProcessor.js\":\"abdda3918f3e4453\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/references/spanReplacement.js\":\"7ac564479274d89f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/htmlToOutline.js\":\"717b61206eeb66cc\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/index.js\":\"6fee2f0cc8943fed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a9acc3247a80c853\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/rich-paste/pasteDecision.js\":\"f94f68bda5ab2ab3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/action.js\":\"0c472d0ed883eb60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/blockIds.js\":\"f5c5cd2280c7e199\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/content.js\":\"5ce43ab769a7b3e1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/effect.js\":\"aed8731d8dd10272\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/ids.js\":\"c32d58f2ebd4932e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/import.js\":\"1236c2dd9239590f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/index.js\":\"55e93a7adabc9c73\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plan.js\":\"a01c2ed4d7d78046\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/plugin.js\":\"91eec91f583bfc05\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/promotion.js\":\"cf997afbd3c49e9b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/properties.js\":\"7f5e4fd0b9525c38\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/references.js\":\"ff8fca497891a65b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/report.js\":\"df341bb8bd62ad13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/roamMemo.js\":\"2c26ce4b4019a89e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/runtime.js\":\"601682d2d1673b8b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/schemaReconciliation.js\":\"85d8d12709d54b0c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/srsMarkers.js\":\"b267f9309547802c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/todo.js\":\"eb938caae9953aee\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/typeCandidates.js\":\"825409a2673ddf3e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/roam-import/types.js\":\"3b8900a2c25ec754\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/index.js\":\"979d306e3be6eb48\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/search-health/store.js\":\"030e168d13f3a734\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/HeaderItem.js\":\"c51d0645da527bd1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6b8d5dbcdf6665b3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/index.js\":\"819a0c4422584328\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/model.js\":\"e954e6a5c48327be\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/toggleStore.js\":\"abcc775d287484ed\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/shortcut-help/useKeyInspector.js\":\"801ac34338076496\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ca78fb930ded1168\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/ShellDecorator.js\":\"08f4c969410fe242\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/actions.js\":\"f2ff2911619e82a5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c407ac32348ffe7b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/index.js\":\"698c52fa02c20e61\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/shell.js\":\"d773f7ed74be4b7e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/surface.js\":\"acf34e616e29f2f4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/spatial-navigation/walker.js\":\"f8e116c4b188a777\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/RescheduleToast.js\":\"48d1ac72b1d3f654\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/dataExtension.js\":\"ade9e3dcb949af50\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/index.js\":\"ad7fa2e53e2d1c62\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/indicator.js\":\"40656d38b8259e42\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/moveSrsState.js\":\"488b92fdaa9b503f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1fcadc7e3c00f2db\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/scheduler.js\":\"6fc7170eb85cd44e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/schema.js\":\"4ab5830aad9f2dc4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d8070840c4096ad6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/srsClipboard.js\":\"3ae01045135a0c9f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4e8d4b19ec1aafa5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DailyNoteReviewHint.js\":\"50a938a272eb7f42\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/DeckPicker.js\":\"78bb34ed6cb1da13\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewControls.js\":\"667cd180633cd6ea\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3623da8ce9694b76\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/ReviewSession.js\":\"c19c2691bea175df\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/actions.js\":\"93920d3de893f79b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/archive.js\":\"3196a0ed847f5b46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dataExtension.js\":\"607cd277957f8cc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/deck.js\":\"df2548912448076f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/dueQuery.js\":\"ca09993ad975cda4\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/gradeDecision.js\":\"cd0adf333e187795\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/index.js\":\"aacda6d0b909a5f0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/keyHints.js\":\"8fc9446a3cc19d5d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewCardLayout.js\":\"dbe093aa615be5f2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/reviewProgress.js\":\"a547a21b53803614\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/schema.js\":\"92c13a61c19983ae\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/srs-review/useDueCards.js\":\"3301596172a27823\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/index.js\":\"ecd8a025d2b750a8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/startup-metrics/record.js\":\"4bf0979cc1aaa681\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/index.js\":\"f1946634708ee722\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/persistenceStatus.js\":\"644b70476ba81fc2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/storage-persistence/requestAction.js\":\"14d8955639b70014\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/TypeChipsDecorator.js\":\"33ea5b8167dc6b4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/codeMirrorExtensions.js\":\"5753c3987d2f70cf\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/index.js\":\"c6eaae2559753ce0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/supertags/typeAutocomplete.js\":\"37ebbee1aeee27fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ae1a10a15c5717fb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/actions.js\":\"e83adbe378aedb8c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/anchor.js\":\"54995f14a3c4ee54\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/events.js\":\"0f68ac46d4b6653f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/gestureActions.js\":\"2e1325e54b6ce061\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/index.js\":\"479b8a22f15c634d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"115a9e2343abd37c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/collect.js\":\"810ed5aba137b2d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/index.js\":\"15d7060fd9d6dc91\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/sync-metrics/record.js\":\"601b706a4410c7fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/RejectionDialog.js\":\"20a902a7d701fa47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/SystemStatusHeaderItem.js\":\"576315c65b3e2d9d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/index.js\":\"f409dceae0d9d5ef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/model.js\":\"c093cf3cef0bda1e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/queueCounts.js\":\"bcf5299edc692497\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rejectedHelpers.js\":\"cce2e4a49c398de3\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/rematerializeAction.js\":\"59df5e78c5f081c6\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/system-status/useHysteresis.js\":\"fa1fb76fba16ed2a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/ColumnHeaders.js\":\"4ea56056b6ca5d0a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/QueryUi.js\":\"3ecac1f09a74042c\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/TableLayout.js\":\"ace12c0556a914d8\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/actions.js\":\"254e6b20874d0fb2\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/cellEdits.js\":\"ea5e8df9904b4493\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/childrenViews.js\":\"aef5909b7119c49d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/columns.js\":\"666ff20f762e3ef0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/controller.js\":\"0d322d9075899cab\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/convert.js\":\"813cd3c98202b21f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/dataExtension.js\":\"919760a9785a4d0e\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/index.js\":\"7641b70c0028eec0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/keys.js\":\"44ffe0bbfb3570c7\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/model.js\":\"77785458919d17f9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/QueryText.js\":\"2ceeaea286ef3d22\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/backfill.js\":\"b400464e3269b10f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/completion.js\":\"60a8ccdb05f2ef7d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/format.js\":\"91c4fd40f8722071\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/parse.js\":\"e00ccc8ebae78a46\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/queryValue.js\":\"7041089f25489e4f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/registrations.js\":\"77a31c9466b5efb1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/query/source.js\":\"9fb63b2e1d23dd8a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/registry.js\":\"9032d1eaa37a3655\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowGutter.js\":\"3d2436133efccd1f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/rowVerbs.js\":\"118d0fa3a0182d85\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/schema.js\":\"2fc73210397d6e29\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/tables/sort.js\":\"0b33007c4539f1a0\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/effect.js\":\"7295eff161a850aa\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/index.js\":\"f67881d5213639e5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/theme-toggle/theme.js\":\"2711f45224fd908b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/actions.js\":\"432ac81d909cf3a9\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/dataExtension.js\":\"2846b3028e7916f5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/index.js\":\"20619b9dd94b4439\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/todo/schema.js\":\"76d86db8668dbe0d\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2020047023ba2f35\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/actions.js\":\"fa0c1397d0fcab20\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/defaultItems.js\":\"fd0d5ef960641de1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/facet.js\":\"86e436ba5a4a6c60\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/holdRecognizer.js\":\"e49f4a9b30991397\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/touch-selection/index.js\":\"d005dd0a2cf5fc93\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/UpdateIndicator.js\":\"3c74b06598411451\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/index.js\":\"4c63a004db569397\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/update-indicator/loadTimes.js\":\"c4c0778bd409ce11\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoNotesRenderer.js\":\"88bc3152faac54d5\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoPlayerRenderer.js\":\"8274efe0a9a521da\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/VideoTimeStamp.js\":\"37031530b6a89b59\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/actions.js\":\"f3b8553560c82c82\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/index.js\":\"d78a3d1d57d25095\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/markdown.js\":\"f0c317e8b67092a1\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/notes.js\":\"276349bce6eca69b\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/registry.js\":\"ea85eca2502940cb\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/remark-timestamps.js\":\"9960da7701973fef\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/video-player/view.js\":\"ef23bcee9104c362\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/LinkHints.js\":\"c252b1ead80f5940\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/index.js\":\"ef13b083b4a006fe\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/model.js\":\"9ca77b8450b1d02a\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-link-hints/settings.js\":\"14b311009f5a928f\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/actions.js\":\"297d823be3424d47\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/index.js\":\"f799fe7082845a36\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/vim-normal-mode/interactions.js\":\"92fb334a66d8cb69\",\"/knowledge-medium/pr-preview/pr-1862/src/plugins/workspace-header/index.js\":\"b2b3380ae9ebbca6\",\"/knowledge-medium/pr-preview/pr-1862/src/registerServiceWorker.js\":\"a21f7592433b5f03\",\"/knowledge-medium/pr-preview/pr-1862/src/requestPersistentStorage.js\":\"9ecb3ce890c23bfb\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authRequestDeadline.js\":\"94a868d6e448289f\",\"/knowledge-medium/pr-preview/pr-1862/src/services/authStorage.js\":\"6c68dee7c253d055\",\"/knowledge-medium/pr-preview/pr-1862/src/services/powersync.js\":\"6f16482e8b69a19c\",\"/knowledge-medium/pr-preview/pr-1862/src/services/supabase.js\":\"a17e27e22dec406c\",\"/knowledge-medium/pr-preview/pr-1862/src/services/uploadErrorClassifier.js\":\"df59c1af650326ea\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/ActiveContexts.js\":\"15909606a18e77e9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/HotkeyReconciler.js\":\"acda584a597b05ca\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/WipeLocalDataDialog.js\":\"a65a8940c8c25ac9\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionDispatch.js\":\"2e9a8d69a1d37e6c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/actionRefItems.js\":\"c39400f4d7678c06\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/applyKeybindingOverrides.js\":\"99413f2b73929801\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockActions.js\":\"967f96d3d1ee066b\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/blockMergeGesture.js\":\"f3eb9e186e31db00\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/canonicalizeChord.js\":\"5722b5e24a357905\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultContexts.js\":\"b653d0d81ce64f77\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/defaultShortcuts.js\":\"52e9ea7afe92aea4\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/effectiveActions.js\":\"c622b2710c1d7d9d\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureAction.js\":\"959d9181746dd34c\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/gestureBinding.js\":\"adef389b1ef8040f\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/holdRegistry.js\":\"9353eab944fb6908\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingConflicts.js\":\"7c2b56d9fe9bea4e\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/keybindingOverrides.js\":\"af6ec8768338fe03\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/pointerAction.js\":\"b661f146ad697823\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/resolve.js\":\"4c18f9d3570ff5a1\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/runAction.js\":\"da3da14fb89d347a\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/sequenceMatcher.js\":\"0582744edb4b77b1\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/types.js\":\"eba13f167d62215b\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionContext.js\":\"5de6c336e7c2eaf7\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/useActionDiscovery.js\":\"d50c9469d37c2a13\",\"/knowledge-medium/pr-preview/pr-1862/src/shortcuts/utils.js\":\"118083bd4023c09c\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/bootStore.js\":\"3418ea7c5d70b804\",\"/knowledge-medium/pr-preview/pr-1862/src/sw/previewDatabases.js\":\"02440b995b8b359d\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/byteTransform.js\":\"069e5ea423d53dff\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/attachmentCleaner.js\":\"114bbb736f0a5db4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/attachmentParts.js\":\"42eed0de2458cb15\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleParts.js\":\"f63527df85e3cbc2\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/bundleRecord.js\":\"dc65118fd83bb393\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/manifest.js\":\"4603717650b80648\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/takeBundle.js\":\"76cfabc5f59959f1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/bundle/verifyBundle.js\":\"ef8abae687d0a37b\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/cleaningStage.js\":\"2879623c9dede72a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionKey.js\":\"2d6dfe202b5b602f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/conversionServer.js\":\"d611b73c0961ecaa\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flip.js\":\"f29e599f3017183c\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/flipAttempts.js\":\"dbdfe91d4e0114b3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/pages.js\":\"5145a591596a6115\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/preflight.js\":\"fade1f7618a60916\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/reseal.js\":\"551918c400f9297a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runConversion.js\":\"09f6a7dbe22afae9\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/runLock.js\":\"6ceb20b37de655eb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealing.js\":\"782edfa7adab1fcf\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/sealingStage.js\":\"0ec226d93f0e9cfd\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/stage.js\":\"8c8e1ff7dd633577\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/conversion/verifyReseal.js\":\"f3cbfa8a68550368\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aad.js\":\"15b6b9b80120575a\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/aead.js\":\"0922cc2b5dfb55a2\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base32.js\":\"032b7d39e11c4348\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/base64url.js\":\"fa9d534eca71f767\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/binaryEnvelope.js\":\"908730ec0ff7c9b0\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/byteAead.js\":\"0e45c49e2b7a9c77\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/canary.js\":\"2fc3a76a5c2ac1b1\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentHash.js\":\"6e1147dae23fc891\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/contentKey.js\":\"5c0051c9c0e78d8e\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/derivedIdNamespace.js\":\"36b92400443ea015\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/envelope.js\":\"57553cac17dc00c4\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/hex.js\":\"979ef7f31f3dc924\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/sha256Hex.js\":\"e069950d1484a680\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/crypto/workspaceKey.js\":\"215d958ac5246a04\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/conversionState.js\":\"40646192bb29e494\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4c269c8bd9c3ca20\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/pastedKey.js\":\"1fc13a79738fba74\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a57bd34d177a0986\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/flows/upgradeWorkspacePin.js\":\"aa429abdb02266eb\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/keyStore.js\":\"bcff7c8a16aaf2e3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/mintWorkspaceKey.js\":\"af261803562f5b75\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/modePin.js\":\"a01078120db15c01\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/openWorkspaceKeys.js\":\"dc642f283a7490dc\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolveWorkspaceEntry.js\":\"ea8d08f2fb672d8f\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/resolver.js\":\"07f4e62267b02dd3\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/keys/workspaceAccess.js\":\"0fc9e880c2ce46ee\",\"/knowledge-medium/pr-preview/pr-1862/src/sync/transform.js\":\"fa41e1f67cd6274f\",\"/knowledge-medium/pr-preview/pr-1862/src/themeBootDefaults.js\":\"685007b6454b108d\",\"/knowledge-medium/pr-preview/pr-1862/src/types.js\":\"2c1182886421b246\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/ClientLocalSettings.js\":\"6aeae5ac9dd209ca\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/abortableSleep.js\":\"e8779359a88e439a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/array.js\":\"21225c09c4f19437\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/backlinkAutocomplete.js\":\"3ae1b6ac33a6ae4f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockCrumbs.js\":\"5aa20ba4a27070ed\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/blockrefAutocomplete.js\":\"0995fab4b2991bfa\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/cadencedIdleJob.js\":\"9ac318cfda1561b4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/callbackSet.js\":\"2509944ac18edbbe\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/clientId.js\":\"a0a6cb9ed3374b83\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirror.js\":\"cd72779083254619\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/codemirrorCompletion.js\":\"4f52b8053d38e8b1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/copy.js\":\"3a1c8f4e52dcdf43\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dailyPage.js\":\"0cc768c559219702\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensics.js\":\"b7747b32509886d5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dbForensicsHooks.js\":\"576b5ecd09462520\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/deleteBlockThroughUi.js\":\"57435d3dab80a279\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dialogs.js\":\"462edf20a2667feb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/dom.js\":\"ab6de15870a14730\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/downloadBlob.js\":\"836be58598df1aae\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/drawnWalk.js\":\"27fbf8c89c51ac04\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/exportSqliteDb.js\":\"4353c203ed79fcae\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fileSystemAccess.js\":\"3df5c9b84af27f37\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/flipSlide.js\":\"79fe90b3d412170b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fnv1a.js\":\"ec3b3553e139249f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/formatBytes.js\":\"f649a5db533b93f5\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/fuzzyRank.js\":\"37a04093fedb10b9\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idbKeyedStore.js\":\"e221122a19b4be61\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/idleCallbackPolyfill.js\":\"725628c39156ce00\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardAwareScroll.js\":\"ee5ebc6bf4d8a2ea\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/keyboardViewport.js\":\"1694009002df6dd6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/lastWorkspace.js\":\"8917c6de3db04ccf\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutColumns.js\":\"4e91f3147dc5c416\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionDom.js\":\"aa087152b5472be8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/layoutSessionId.js\":\"8fc7ad57daa44b99\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkClickGestures.js\":\"514eb7569fdf43d4\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/linkTargetAutocomplete.js\":\"2a81b8e20d0d142e\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbCorruption.js\":\"edce078bb6f2b8b6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/localDbRecovery.js\":\"dce385ae4f6f1b69\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/markdownParser.js\":\"9a2ce1502811191c\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/memoize.js\":\"0efb8e66149bdbd2\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameFieldCommit.js\":\"6e510399ee4de193\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/nameList.js\":\"68ad6f1e17d7bbb0\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/navigation.js\":\"1853d926c402a1ac\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/omnilinerNamespace.js\":\"349905ba307dfef8\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/opfsPageScan.js\":\"8c0967457e30db37\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelClearance.js\":\"73d7e8624ace7a08\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelHistory.js\":\"5130a7457be69349\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLanes.js\":\"f50ef9aea0b76925\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelLayoutProjection.js\":\"e49840abb800e346\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelScrollAnchor.js\":\"ee7eba33358b697a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/panelUrlFlags.js\":\"817d7109b08e8d55\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/platform.js\":\"e4e5fcf9677a8e88\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/pluralize.js\":\"9e2b69c81f21233d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyCreation.js\":\"7af2c4af47ec104d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyNavigation.js\":\"49ac20fa7dac386a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/propertyValueContext.js\":\"982a781377a16f7f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/react.js\":\"f55dc346cb11e01d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeDate.js\":\"89d28c36da5f0114\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/relativeTime.js\":\"e68b69561cb03928\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/renderScope.js\":\"31028201ddbb698a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/resolvedThenable.js\":\"85a54d4493d089fb\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/routing.js\":\"d33b22595e218264\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/safeMode.js\":\"30ddcc9c7310d997\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/scheduleIdle.js\":\"2d12f100ae313e8d\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/screenWakeLock.js\":\"7c137e6227e0dac1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/selection.js\":\"68d2f7f3ca6f802f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/softKeyboardGrab.js\":\"135bc20b3c573b39\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/startupTimeline.js\":\"8953fa49a9030fbd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/state.js\":\"0ac7ccc6d4476963\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/string.js\":\"6c76114f0d70ddb1\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/surfaceZoom.js\":\"f8c16b1b652e68c3\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/time.js\":\"f89ff9780440f95b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toast.js\":\"2d7a79b38b14ff2a\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/toggleStore.js\":\"2541296e51c3bcdf\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/untilStopped.js\":\"cb2b4a22af04e547\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/userActivity.js\":\"fb7a0bef9d10395b\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewTransition.js\":\"8a6c66ff574d09fd\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/viewport.js\":\"56c028205a3a7970\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/webLock.js\":\"846473d871a53b0f\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceRecovery.js\":\"02c13934ecec5cff\",\"/knowledge-medium/pr-preview/pr-1862/src/utils/workspaceSnapshotStore.js\":\"51d3655121fa27d0\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-compiler-runtime.js\":\"4d346e3684e14e7b\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-client.js\":\"0880857a9919a034\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server-edge.js\":\"c8d5f2e742782e28\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-server.js\":\"ee7dd11e9781656d\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static-edge.js\":\"5670f6533adc84db\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-static.js\":\"53a7a680acf7fc4b\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom-test-utils.js\":\"923289d4895b1b5d\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-dom.js\":\"605852806f09937f\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react-jsx-runtime.js\":\"6e98c341142a9086\",\"/knowledge-medium/pr-preview/pr-1862/src/vendor/react.js\":\"fecb45f1601ee8a3\",\"/knowledge-medium/pr-preview/pr-1862/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1862/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
