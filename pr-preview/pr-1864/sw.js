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
		buildId: "f4c979dc354a-94a30a03",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1864/\":\"c6abf237a62a18f9\",\"/knowledge-medium/pr-preview/pr-1864/index.html\":\"c6abf237a62a18f9\",\"/knowledge-medium/pr-preview/pr-1864/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1864/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1864/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1864/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1864/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1864/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1864/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1864/assets/FacadeVFS-B0NVfCFB.js\":\"4e670a27cd469cab\",\"/knowledge-medium/pr-preview/pr-1864/assets/OPFSCoopSyncVFS-W9Y-Rxiu.js\":\"ff99377e151d271f\",\"/knowledge-medium/pr-preview/pr-1864/assets/OPFSWriteAheadVFS-D1vKOs_a.js\":\"889629d3350cdcc6\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-Afk3xCD0.js\":\"90d9c104a6cc685e\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-async-BdmlUoHa.js\":\"6c56f174ecfd25ea\",\"/knowledge-medium/pr-preview/pr-1864/assets/worker-BWk925FV.js\":\"79a3dc64295839dd\",\"/knowledge-medium/pr-preview/pr-1864/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1864/chunks/app-DGbU54eU.js\":\"95d67bbb30719d65\",\"/knowledge-medium/pr-preview/pr-1864/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1864/index.js\":\"a44376aadf55474b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1864/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1864/assets/AccessHandlePoolVFS-BSplSlZN.js\":\"cc97e2a86a9d0695\",\"/knowledge-medium/pr-preview/pr-1864/assets/IDBBatchAtomicVFS-BBOO7Eqz.js\":\"965fb512d56f6e31\",\"/knowledge-medium/pr-preview/pr-1864/assets/MemoryVFS-0PcxEftt.js\":\"811bf195f6aa4ba1\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-CsKKkxjg.js\":\"0991b257ec91a887\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-async-DEfdM9Tk.js\":\"cfa85338822fb926\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1864/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1864/chunks/AccessHandlePoolVFS-BoH5_wHo.js\":\"2bbcf268293175b3\",\"/knowledge-medium/pr-preview/pr-1864/chunks/FacadeVFS-DTsG6WxA.js\":\"90acd6a713407b48\",\"/knowledge-medium/pr-preview/pr-1864/chunks/IDBBatchAtomicVFS-DcEl94kw.js\":\"5fa6eca4c487d35a\",\"/knowledge-medium/pr-preview/pr-1864/chunks/MemoryVFS-HOfaf5xy.js\":\"1df70396f4d02f6a\",\"/knowledge-medium/pr-preview/pr-1864/chunks/OPFSCoopSyncVFS-DlUNFI-l.js\":\"6f6c3541a1952485\",\"/knowledge-medium/pr-preview/pr-1864/chunks/OPFSWriteAheadVFS-Bznt-eet.js\":\"1fa0dec6e6512e15\",\"/knowledge-medium/pr-preview/pr-1864/chunks/Preview-CD1_X_ja.js\":\"ca7af281fb8b06a0\",\"/knowledge-medium/pr-preview/pr-1864/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1864/chunks/card-lP0lgE-8.js\":\"224b8c23d756d93c\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dist-CLwFX-wU.js\":\"f88a275bd7a4c594\",\"/knowledge-medium/pr-preview/pr-1864/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1864/chunks/mc-wa-sqlite-async-DcjImBYp.js\":\"8e4376a0a262d58e\",\"/knowledge-medium/pr-preview/pr-1864/chunks/mc-wa-sqlite-j-QsFVVQ.js\":\"d2e9fcd5d163efa9\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-BEM1gMFA.js\":\"a376e5578fbfff4d\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-BQI_YLoo.js\":\"944bd6ffcb651041\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-BXdio7GW.js\":\"bd879923c088e345\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-BYK0SQVy.js\":\"a5ebdcd84c1aa4f1\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-C1EegbPK.js\":\"0672daa8443bc3f5\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-CFAYUWE1.js\":\"038161a25d08bb04\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-CjfoI-iq.js\":\"da33cfa0d758c5e2\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-bvbXmOT5.js\":\"f3cab8c60276862c\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dom-server-legacy.browser.production-DXg0vvs6.js\":\"a06d65fd3ad9ed04\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dom-server.browser.production-Bo_rWdku.js\":\"779abeae79576374\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dom-server.edge.production-DeLvIFEX.js\":\"7c8e73eb0150180f\",\"/knowledge-medium/pr-preview/pr-1864/chunks/server.browser-DyXr5m_P.js\":\"a4bafcc854736ef1\",\"/knowledge-medium/pr-preview/pr-1864/chunks/textarea-Bw14eVjI.js\":\"83555a15308c93c6\",\"/knowledge-medium/pr-preview/pr-1864/chunks/ui-Bx-jqn_G.js\":\"abe3d78ccf64bcac\",\"/knowledge-medium/pr-preview/pr-1864/chunks/wa-sqlite-Dq03HU_w.js\":\"a62e35fc62cc5399\",\"/knowledge-medium/pr-preview/pr-1864/chunks/wa-sqlite-async-C_79kuCW.js\":\"03938aa3096686f1\",\"/knowledge-medium/pr-preview/pr-1864/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1864/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1864/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1864/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1864/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1864/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1864/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1864/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1864/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1864/src/App.js\":\"fa3e9f494c286a28\",\"/knowledge-medium/pr-preview/pr-1864/src/appUpdate.js\":\"05283953e7e9e03f\",\"/knowledge-medium/pr-preview/pr-1864/src/appVersion.js\":\"6180d1d91bc5874c\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/initialLayout.js\":\"2bbb806966908cbd\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/openWorkspaceData.js\":\"3eeefb03c229f4a4\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/resolveWorkspace.js\":\"fe91cb1242892fc8\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/workspaceBootstrap.js\":\"2b5c802b119370fa\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockComponent.js\":\"6ac7724a223ee59d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockCrumbs.js\":\"29fe0cd102a968c4\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockEditor.js\":\"e9d1b981004715dc\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockLoadingPlaceholder.js\":\"fd6d220025af5269\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockProperties.js\":\"0641bd6983ecb8de\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockSearchPicker.js\":\"fadcab32f3d3707c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ConfirmBulkDeleteDialog.js\":\"767a00574a244201\",\"/knowledge-medium/pr-preview/pr-1864/src/components/DividerHandle.js\":\"3559878f90ef9508\",\"/knowledge-medium/pr-preview/pr-1864/src/components/DraftEditor.js\":\"f63054c5f2308d03\",\"/knowledge-medium/pr-preview/pr-1864/src/components/GutterPill.js\":\"ef34c1bcdc1b7292\",\"/knowledge-medium/pr-preview/pr-1864/src/components/Header.js\":\"338c15969c3b7fa3\",\"/knowledge-medium/pr-preview/pr-1864/src/components/LazyBlockComponent.js\":\"4c81d97220131e6a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/Login.js\":\"116e2d1ce9cdb5dc\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ZoomableSurface.js\":\"8228ad8c099ce1cf\",\"/knowledge-medium/pr-preview/pr-1864/src/components/editModeKeepalive.js\":\"7991b8f4b4734eca\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyDisplay/PropertyDisplayScope.js\":\"23c40b8c40cc6282\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"186eb1eae9abb6ca\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/RefPropertyEditor.js\":\"66796f177092b76c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/RefTargetTypePicker.js\":\"adc82c01f0f8b26a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/SelectPropertyEditor.js\":\"c02e9728aba10630\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/TypesPropertyEditor.js\":\"4d6b77b8d1b44091\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/defaults.js\":\"d9ed6afbed62f3e4\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/kernelValuePresets.js\":\"f4d2b5b6e68f3cd9\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/selectablePresets.js\":\"4344331a90ba8888\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/typesPropertyUi.js\":\"8a81996c388cfa31\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/AddPropertyForm.js\":\"86f4bf9c5da23657\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/PropertyPicker.js\":\"3b17ed101ec1428b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/PropertyRow.js\":\"245dfff1e982db33\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/Rows.js\":\"d2ca61ada7af776a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/actions.js\":\"7a1b7b183e56df0d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/declarationOnly.js\":\"d476fda165b88cb0\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/layout.js\":\"e228e39401e6c1ba\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/model.js\":\"6648c3576ea24fab\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/shapeUi.js\":\"c7211eddfd61efda\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/shapes.js\":\"8249ad8347ee5cee\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/usePropertyEditingActivation.js\":\"78ec706d30d46f99\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/visibility.js\":\"6c5091066aca336c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanelSections.js\":\"4f1d9e72cd7438af\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/BlockEmbed.js\":\"3366331194d52bc8\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/BlockLink.js\":\"480f952e461c0eb5\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/BlockRef.js\":\"63ddffde8214cb2e\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/ReferenceLink.js\":\"399d2ec21bd48e64\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/cycleGuard.js\":\"5ad90518bfc42d93\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/cycleGuardContext.js\":\"855c8794852c561d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/linkInteraction.js\":\"d45925b73b2ae9c1\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/referenceLayout.js\":\"a6014bad1a2ce39a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/useBlockRefAncestors.js\":\"ba9c4f191cd913e6\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BlockGutter.js\":\"50a65193d6d0bf30\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BlockInfoDialog.js\":\"66ac9dcbcf40828a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BlockTypeBlockRenderer.js\":\"bdeaa10ccf7ebc93\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BulletHoverCard.js\":\"55a754244ce1fb2d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/CodeMirrorContentRenderer.js\":\"61f189f4b759406c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a4adf34abf2da4de\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/ColumnResizeHandles.js\":\"362c883523359042\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3094e8bcf3dd06c3\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/DefaultBlockRenderer.js\":\"f30e0f47678dd7f4\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/LayoutRenderer.js\":\"611be51703789f63\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/MarkdownContentRenderer.js\":\"a82da0fcd7388346\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/MissingDataRenderer.js\":\"f807a950e99edbcf\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/PanelRenderer.js\":\"250a6a4481f7a618\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/PropertySchemaBlockRenderer.js\":\"93bb3a4be3ef53b4\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/TopLevelRenderer.js\":\"bb26b6bdfa20541a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/blockGutterMode.js\":\"12ea06a9adca4f7b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/blockTitleText.js\":\"ca31a18a9f32c42c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/fieldCreationKeydown.js\":\"38404c488995b630\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/layoutRootContext.js\":\"d68597fabd454b19\",\"/knowledge-medium/pr-preview/pr-1864/src/components/typeChip/TypeChip.js\":\"827da128a5903acf\",\"/knowledge-medium/pr-preview/pr-1864/src/components/typeChip/chipStyle.js\":\"9ec63b4190193c70\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/anchored-floating.js\":\"7de9fbcfb699d471\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/button.js\":\"e28c393c3a86ccb6\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/card.js\":\"2bfeca19c44ee764\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/checkbox.js\":\"5053f3f56d589d2b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/collapsible.js\":\"55fcabdee21bf26a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/command.js\":\"d3d13f50d652fab0\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/context-menu.js\":\"10d2e8396f0fc32a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/dialog.js\":\"15be247348381b54\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/dropdown-menu.js\":\"9c814e6dda0cae02\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/floating-listbox.js\":\"e07e7ab9a23be993\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/index.js\":\"05be5bbf52b83f04\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/input.js\":\"fc97d81f433b9f3b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/kbd.js\":\"79a10904b2f4781f\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/label.js\":\"e6b44f0da1c1407b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/textarea.js\":\"ef8e0b4c44000329\",\"/knowledge-medium/pr-preview/pr-1864/src/components/useEditModeYieldKeepalive.js\":\"0ec859831ce6fc30\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/BootFallback.js\":\"6a8deac0b66e5715\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/FocusedRowLazyMount.js\":\"9b968c291e5b8972\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/LazyViewportMount.js\":\"bcc240c5e50797e1\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/LocalDbCorruptionFallback.js\":\"419bfdf7d01cee03\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/error.js\":\"45d096b29e876601\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/lazyMountRegistry.js\":\"1b3e9a93553a7505\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/suspense.js\":\"a92ec955ec59bcf6\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/CreateWorkspaceDialog.js\":\"106f599d52876e3a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/PendingInvitations.js\":\"ba8ba87f24ef373a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/SyncProgress.js\":\"b0202766c5c3c609\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/UnlockProgress.js\":\"eaf17705732e611a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceKeyGate.js\":\"c78261cc6609fec5\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceSettingsDialog.js\":\"23aa512e39d3cdee\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceSwitcher.js\":\"908467f9a4762a96\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceSyncGate.js\":\"9b01c959aed50dc4\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/ConversionFlow.js\":\"1301969ba6251dbd\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/ConversionFlowHost.js\":\"e5d3b5dc86fce1f2\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/EncryptionSection.js\":\"58ad81a50c083f8b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/attachmentPrompts.js\":\"0b77691897de4b9d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/bundleFolderPrompts.js\":\"536726de30f0b781\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/conversionFlowDeps.js\":\"4fa7a6bc47bd36e5\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/conversionFlowStore.js\":\"a08db2b35e457931\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/flowUi.js\":\"74c473b3e8ca0c41\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/useConversionRun.js\":\"1ab9693810cba018\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/keyUi.js\":\"fcf6cff6db6dcf08\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/useCloseOnKeyLoss.js\":\"d18e67a88a0a28d2\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/useCloseOnServerE2ee.js\":\"918285565b3c925a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/workspaceUnlocked.js\":\"c3472c498f79af96\",\"/knowledge-medium/pr-preview/pr-1864/src/context/backgroundSubtree.js\":\"2bb4c56b12e42ab9\",\"/knowledge-medium/pr-preview/pr-1864/src/context/block.js\":\"ab25d24a3a20b92f\",\"/knowledge-medium/pr-preview/pr-1864/src/context/layoutWsContext.js\":\"c6309125d1b1be50\",\"/knowledge-medium/pr-preview/pr-1864/src/context/propertyDisplay.js\":\"98650d9330fdc9ab\",\"/knowledge-medium/pr-preview/pr-1864/src/context/repo.js\":\"0b243e911ccf29a5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/aliasClaim.js\":\"46025c87b99acb62\",\"/knowledge-medium/pr-preview/pr-1864/src/data/aliasSeatNamespace.js\":\"64336f35502da126\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/blockData.js\":\"ebef9efa3d9f9457\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/blockType.js\":\"4f7595033a5161fe\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/changeScope.js\":\"0c30631687e062f7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/codecs.js\":\"567b9b2ed3bd1996\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/derivedData.js\":\"179a511d491c10ea\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/errors.js\":\"c55b66cb10e22127\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/events.js\":\"08006a90df3ca441\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/handle.js\":\"52d220aecd823491\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/index.js\":\"f5675a6be54db4a6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/mutator.js\":\"e323912bfadf8c27\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/processor.js\":\"aec0f86e61dcb5be\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/propertySchema.js\":\"1b81dbb1f724097b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/query.js\":\"efce280df249cd86\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/sameTxProcessor.js\":\"4be825d103b02bcc\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/schema.js\":\"52d220aecd823491\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/tx.js\":\"52d220aecd823491\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/typedBlockQuery.js\":\"9cb92362443dcad3\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/user.js\":\"adaaa88745ccf1da\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/valuePresetCore.js\":\"16612c55d8eaa341\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/valuePresets.js\":\"391101ced5e640af\",\"/knowledge-medium/pr-preview/pr-1864/src/data/attachmentCleanerIOVerb.js\":\"64273a85153473d1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/block.js\":\"d021a2b77c5f4b0e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockCache.js\":\"ec8f12fa1bac98f7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockId.js\":\"e88a9a81191a35f2\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockLiveness.js\":\"43b9640ec681ec6f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockMerge.js\":\"f4ca2bb048660fc6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockSchema.js\":\"736e0b4c49f7bb8f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockTypeLookup.js\":\"6ad1a8e75b6e9b65\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockTypes.js\":\"c7e3774eadb7b9da\",\"/knowledge-medium/pr-preview/pr-1864/src/data/childrenView.js\":\"3361a88b32090a06\",\"/knowledge-medium/pr-preview/pr-1864/src/data/clientContext.js\":\"d62f2fc19a8d6848\",\"/knowledge-medium/pr-preview/pr-1864/src/data/dbFileSiblings.js\":\"a2973c5c4a8357ef\",\"/knowledge-medium/pr-preview/pr-1864/src/data/definitionSeeds.js\":\"8b8c49b457ea4f9c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/derivedIds.js\":\"8542f318dd7b55f5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/drawnSubtree.js\":\"9e2269b164d3e648\",\"/knowledge-medium/pr-preview/pr-1864/src/data/facetBridge.js\":\"2b6d5003f4dbd263\",\"/knowledge-medium/pr-preview/pr-1864/src/data/facets.js\":\"7a312b76995607a9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/globalState.js\":\"26bbd349f2fc72ca\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/aliasClaimRederiveProcessor.js\":\"d72bd9fc24740cda\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/ancestorBatch.js\":\"09f626ecf56113f4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/blockTypeTypeifyProcessor.js\":\"2c990b4cda669e93\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/clientSchema.js\":\"d2f5b031ecc21af4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/commitPipeline.js\":\"36471714e0860b0e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/devAssertions.js\":\"dcbcc835b0268a5b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/firstSync.js\":\"5f30cb2fb8bd365a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/freshInitialLoad.js\":\"7c2096dcd583464c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/graphBackfillClaim.js\":\"e39f1dd5a2792f46\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/handleStore.js\":\"39f0a35b9fd0c1c0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/idleMarkerJobs.js\":\"2ccc89d062be9b0a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/initialDownload.js\":\"3468f70e2f4e219c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/initializeClientDatabase.js\":\"5eba4046eb036753\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/jsonCanonical.js\":\"b280f70b1eb086e7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/kernelInvalidation.js\":\"16c422135e531966\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/kernelProcessors.js\":\"4f264e947ae7fa4f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/kernelQueries.js\":\"2383fcbc73278f27\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/mergeTypeMembershipProcessor.js\":\"c8881e7a69119645\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/normalizeReferencesProcessor.js\":\"d569179ce5c811b3\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/poolInstrumentation.js\":\"f32b85f3e79f03d9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/processorRunner.js\":\"ddfbfd9bba555022\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyCellBackfill.js\":\"b51119616869f1f4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyChildMint.js\":\"4a041f62f6a4e0e6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyChildrenProcessor.js\":\"613526dd8aa885de\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a2cb35ac00c45430\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyDefinitionSynthesis.js\":\"627b870c8749e9d5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyKeyScan.js\":\"9c997cc10d3e76e3\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertySchemaResolution.js\":\"291635acaa5acc27\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyValueEdits.js\":\"ba28ff4e30d74e9c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/raiseProtocol.js\":\"72a350b570641965\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/readBatch.js\":\"b58f8bdf37f6b54a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/refProjection.js\":\"df2d7961aa4f3092\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/referenceTargetLookups.js\":\"8ae8c2908ab9d9f5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/referenceTargetProcessor.js\":\"bce6d2be67462e99\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/replayMerge.js\":\"bb9f62af9571daf6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/sqlBinds.js\":\"cf714e70a4519925\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"117e5276d6dc1eff\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/arrivalProcessors.js\":\"570fbd7399b79a20\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/invalidate.js\":\"7a6cf3ed268781ab\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/materialize.js\":\"56b4a4d871433311\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/observer.js\":\"73b39a5aaee86f9e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/reconcile.js\":\"93e270f002963bf0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/timingMetrics.js\":\"e4a776b56492fa4f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/treeQueries.js\":\"3ea9a13e88e6e42c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/txEngine.js\":\"280d3192d608bf0b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/txSnapshots.js\":\"ba796f2c00a1da8c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/typedBlockQuery.js\":\"2a789786b59fcf5c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/undoManager.js\":\"047433e6319cdf68\",\"/knowledge-medium/pr-preview/pr-1864/src/data/invalidation.js\":\"83e8618df1af9b88\",\"/knowledge-medium/pr-preview/pr-1864/src/data/kernelDataExtension.js\":\"b906f1257aae51fb\",\"/knowledge-medium/pr-preview/pr-1864/src/data/kernelPage.js\":\"3ffede6380decb72\",\"/knowledge-medium/pr-preview/pr-1864/src/data/kernelValuePresetCores.js\":\"e0914806515914dd\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localDbCorruptionSignal.js\":\"d22dade6658a929c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localDbStorage.js\":\"b2931779a898ea0c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localDbVfs.js\":\"740d349bb8fc9faa\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localSchema.js\":\"7f1f6136cf5327d6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/maintenance.js\":\"401c8d7183daff57\",\"/knowledge-medium/pr-preview/pr-1864/src/data/mergeProperties.js\":\"7e529ee256fdaff1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/metricsConsoleHook.js\":\"26960cc2e0d40b8f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/migrationsPage.js\":\"012c7ad92a56081c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/mutators.js\":\"c1d678d8109a765d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/orderKey.js\":\"940f0cc13f49319d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/orderKeyPlacement.js\":\"56754f26643ae9bf\",\"/knowledge-medium/pr-preview/pr-1864/src/data/outlineSurface.js\":\"f8bef19da08c2232\",\"/knowledge-medium/pr-preview/pr-1864/src/data/pendingEditorContent.js\":\"06f4c4d3fb9aeda9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/pendingUploadsSql.js\":\"b5d4fc7b69a2128b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/pluginStateExtensions.js\":\"83013b3d16143368\",\"/knowledge-medium/pr-preview/pr-1864/src/data/powerSyncLogger.js\":\"96e68739891dc8a7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/projectorRuntime.js\":\"029c2a261208661e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/properties.js\":\"d8e8a32cfb4bdcc5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertiesPage.js\":\"21f40e1d715a6d57\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyChildren.js\":\"22ff992ee9eb209f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDefinitionFanout.js\":\"ccc959e448e82354\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDefinitionMetadata.js\":\"3f6ccef2dcc60e93\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDefinitionRegistry.js\":\"2ab6fbfbc4987a25\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDisplayMode.js\":\"85130638a448a048\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyRowCreation.js\":\"5d60089d10dc1724\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertySchemaCreation.js\":\"bb382ddf6f62e6e0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertySeeds.js\":\"01e0e22549f44eca\",\"/knowledge-medium/pr-preview/pr-1864/src/data/recentsPage.js\":\"99cf65e37ce21886\",\"/knowledge-medium/pr-preview/pr-1864/src/data/referenceBlock.js\":\"1d24daec474fd6da\",\"/knowledge-medium/pr-preview/pr-1864/src/data/rejectedUploads.js\":\"aa06bac06c50afc6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/releasePowerSyncConnection.js\":\"04367a8a850f8695\",\"/knowledge-medium/pr-preview/pr-1864/src/data/repo.js\":\"c404caa5db002dba\",\"/knowledge-medium/pr-preview/pr-1864/src/data/repoProvider.js\":\"e11fa84cf9321ff3\",\"/knowledge-medium/pr-preview/pr-1864/src/data/rowProperty.js\":\"b9bc1f978c1bea30\",\"/knowledge-medium/pr-preview/pr-1864/src/data/searchFilter.js\":\"84341e758adb434b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/seedIdentityLedger.js\":\"490c2cb461496816\",\"/knowledge-medium/pr-preview/pr-1864/src/data/stateBlocks.js\":\"ff0cc1b9cf3b1772\",\"/knowledge-medium/pr-preview/pr-1864/src/data/structuralEditPolicy.js\":\"e20e4d48a22e6c4e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/subtreeDelete.js\":\"7a2a122e45bb7977\",\"/knowledge-medium/pr-preview/pr-1864/src/data/syncStreamLock.js\":\"4be8fc7736166673\",\"/knowledge-medium/pr-preview/pr-1864/src/data/syncedTableSqlRecognizer.js\":\"9286b37b1f171846\",\"/knowledge-medium/pr-preview/pr-1864/src/data/syncedTableWriteGuard.js\":\"4daf84501a905cd7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/targets.js\":\"5e6124f340ee431b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeColors.js\":\"fec2da030614a71b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeDefinitionMetadata.js\":\"01e0be43eb330833\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeDefinitionRegistry.js\":\"e6dc705f82899f25\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeExtraction.js\":\"9f28966063f38bce\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeInitialValues.js\":\"843a851979d6e7e8\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typePropertyGroups.js\":\"b65a32e9bcad76a6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeSeeds.js\":\"9046fa6647d4365f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeTagger.js\":\"f32df09220f819ca\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typedRecords.js\":\"e250861cc1962fba\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typesPage.js\":\"9face01f52d1b72a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/userPrefs.js\":\"d48e7cd04a173f01\",\"/knowledge-medium/pr-preview/pr-1864/src/data/userSchemasService.js\":\"655dbf715a4ba4ce\",\"/knowledge-medium/pr-preview/pr-1864/src/data/userTypesService.js\":\"a4d2beec0184eb83\",\"/knowledge-medium/pr-preview/pr-1864/src/data/valuePresetRegistry.js\":\"1831a2142c20e455\",\"/knowledge-medium/pr-preview/pr-1864/src/data/visibleChildren.js\":\"f5dde0c797d527ad\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceConversion.js\":\"068b4189e4eaf77f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceFirstSync.js\":\"45198c94c741cc30\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceIdNamespace.js\":\"a376cd43220ab634\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceSchema.js\":\"df49dd4ab8ed2205\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaces.js\":\"0cf41b02adb0f930\",\"/knowledge-medium/pr-preview/pr-1864/src/data/writeAheadLog.js\":\"53affd8cdc3e9997\",\"/knowledge-medium/pr-preview/pr-1864/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/BlockPasteShellDecorator.js\":\"d824a953559be207\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/atTrigger.js\":\"1f97d8017eee4759\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/autocomplete.js\":\"382cf6472a807f2c\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/codeMirrorExtensions.js\":\"756091c8e4e5e626\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/contentFlush.js\":\"5d59598344214e27\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/defaultInteractions.js\":\"b04a6b8662cc03d4\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/editSettleSignal.js\":\"7743f77c57aaa5be\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/insertImage.js\":\"203f9a8c8b376cc8\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/referenceCompletionRange.js\":\"40a55b73e8d66eef\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/referenceTargetTypes.js\":\"5baf59aa6fc80c66\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/syntaxContext.js\":\"9a4c29f1e394cb98\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/triggerMatch.js\":\"a713c4c3a4aaad6b\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/AppRuntimeProvider.js\":\"b398abf30a14b4a1\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/BlockFocusShellDecorator.js\":\"408e28c0da0359cf\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/ExtensionRenderBoundary.js\":\"075eeb0939006b21\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/PanelContentRecovery.js\":\"bc68cbc8442ad237\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/apiCatalog.js\":\"1314f6e8303f3201\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/approveExtensionHere.js\":\"366a027a60bdc8f4\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/armedCutAppMount.js\":\"2ebd77e8982bdacb\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/batchableKeyedStore.js\":\"bbc41f8d61f04492\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/blockInteraction.js\":\"294e413343d5cc90\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/blockSelectionAction.js\":\"bf22d3d0ed67b8c2\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/compileExtensionModule.js\":\"064adc2fa9ce2fc2\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/compiledModuleCache.js\":\"4feb79b957b1f993\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/continuousGestures.js\":\"ebc8f174c2736b9d\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/core.js\":\"821f1d3227683f78\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/defaultRenderers.js\":\"f9e563ff03843fc1\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/definitionFanoutAppMount.js\":\"a84f888eae5c9bec\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/dialogAppMount.js\":\"9e0a56ace4112e82\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/dynamicExtensionSeeds.js\":\"215ae5803c925477\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/dynamicExtensions.js\":\"80e52afa5728af07\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/exampleExtensions.js\":\"84b7bbcb425a74f7\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionApprovalStatus.js\":\"5608d9fee31494f0\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionLoadErrorToast.js\":\"15446937ce867c51\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionLoadErrors.js\":\"2f9a5010f35c4e7b\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionLookup.js\":\"ae56817a832d36de\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionToggles.js\":\"7e43321b989af99e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionUtilitiesCss.js\":\"03ddd60ce4bf5114\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/kernelPageDeletionGuard.js\":\"dfe8304b8266529d\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/liveRuntime.js\":\"77816f4659c69f0c\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/openExtensionsSettings.js\":\"6a6adc369d36de6e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/overridesCache.js\":\"08657714c046988a\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/pluginIds.js\":\"28dcd2cf662c3800\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/processorRejectionToast.js\":\"e8c3501cff9dc062\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/runtimeActions.js\":\"3a3db9dd56549590\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/runtimeContext.js\":\"650503dde18bc255\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/staticAppExtensions.js\":\"9fd200fc2cfa1611\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/staticDataExtensions.js\":\"bef62f6ef0ebad70\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/toastAppMount.js\":\"138e0f6134142611\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/useOverrides.js\":\"8ba75d3966dc5c3e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/useShortcutSurfaceActivations.js\":\"4028e9b4ace68ac8\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/discoverToggleTree.js\":\"fb396f4079b7582d\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/facet.js\":\"871e615a5f7b1cf8\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/resolveAppRuntime.js\":\"493b3c04bbc75376\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/runtimeEvents.js\":\"585bfedc8ebf81b0\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/togglable.js\":\"a4c99be2bd518446\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/variantFacet.js\":\"7ad22405ce288058\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/verbFacet.js\":\"a0b22416af8172bb\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/block.js\":\"c9a0d6232c31480f\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/focusedChild.js\":\"8d57decd254a13da\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/propertySchemas.js\":\"58cfeefdc6cd9b29\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/typeRegistry.js\":\"c05cd81635f57dff\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useAncestorCrumbs.js\":\"7e6329a245f0ba07\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useAutocompleteListbox.js\":\"015cf7f8da838ad3\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useDebouncedSearch.js\":\"1b20511865a7b321\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useDebouncedValue.js\":\"469ad2b2361de530\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useIsFocalRender.js\":\"0bac99aa776ddd02\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useIsReadOnly.js\":\"793d8c2b8aa7130e\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useMaterializeBacklog.js\":\"59b69fd2dbe9b932\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useMinuteClock.js\":\"d758d7f49597c29b\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/usePanelLayoutProjection.js\":\"b9de34b30832509a\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/usePendingInvitations.js\":\"0912203007039f87\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useRendererRegistry.js\":\"7d4c6f3f1143d2e7\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useRetainedFieldRows.js\":\"7406bcaedd585a8f\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useWorkspaces.js\":\"615d97210e54622f\",\"/knowledge-medium/pr-preview/pr-1864/src/lib/utils.js\":\"891b1ad92416a189\",\"/knowledge-medium/pr-preview/pr-1864/src/main.js\":\"b6bb840415406d4f\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/MarkdownImage.js\":\"21e1dbec4acf8660\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/blockSeparators.js\":\"5b1f32a5b4d1c9c2\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/context.js\":\"fd5610e68335ae5b\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/defaultMarkdownExtension.js\":\"808697125c6de997\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/extensions.js\":\"2a343ff57c099dbb\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/renderMarkdownHtml.js\":\"3688493ad0af9aec\",\"/knowledge-medium/pr-preview/pr-1864/src/minimal-editor.js\":\"b3ac052702b1bf9b\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/armedCut.js\":\"fe64930085f651c7\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/captureMediaVerb.js\":\"c3898cd2a3b9ffc9\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/clipboard.js\":\"2c7790b943800639\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/decision.js\":\"66748499df9ee19a\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/operations.js\":\"10368265599cf525\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/account-header/AccountHeaderItem.js\":\"af45016b7a085698\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/account-header/index.js\":\"979cd6b367522d88\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"320278802fd66d70\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/askAgent.js\":\"1c2a6b3b68076724\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/askedStore.js\":\"4be289183fabe343\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5b95c7e925c5ceba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/chipState.js\":\"9a07910175181dc4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0acf6525fb79e8b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/index.js\":\"4aef3ccf22663389\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7cb3c55019d94316\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/schema.js\":\"7464dda276924e40\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/AgentTokensDialog.js\":\"da0990fd1ca86f73\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9403a9926fe02af7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/addMedia.js\":\"279ea2e23ad404c3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/backlinks.js\":\"214f3059cc65da97\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/block.js\":\"078a284ee8ab5dfd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/context.js\":\"8b3eca575efd5369\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f75ec570478fa2c8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/index.js\":\"188f2ca84008ff1e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/outline.js\":\"8f52cb07216f5fb7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/properties.js\":\"63f400d036c35a0d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/refs.js\":\"4d849f9e8bf6931e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9d26a6543f6ddbea\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/search.js\":\"964e3d1b93693151\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/shared.js\":\"5c6d49daba25c65a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9c09405a1a9d497d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/text.js\":\"5b7aa5fe8ab3a90f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentWrites.js\":\"107dd728ddccf095\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/authoringCatalog.js\":\"89cea2d0dfd2cbe9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/blockRefTargets.js\":\"86ea85af301981da\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/bridge.js\":\"c10d89eca97e3c6e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/bridgeLoop.js\":\"3b18c7c6bf8491a2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/changeHistory.js\":\"68f3391d8ecbb828\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/commands.js\":\"5ce65bd28d4acd47\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/commentsCommands.js\":\"262dbc78dfeba98f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/dataExtension.js\":\"b413c114ce2b1edc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/dataModelGuide.js\":\"82e7cf5880b28730\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/describeRuntime.js\":\"39916bd5c9618f72\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/extensionLint.js\":\"f499f632e67a755a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/grainAudit.js\":\"4a59b97517add341\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/healthCommand.js\":\"814abe22647b8560\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/index.js\":\"7e229107da0619df\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/presetIdentity.js\":\"6574a3d7f033efa9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7694f0cb3d9b1f2d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/readMedia.js\":\"2ac0cb07610662f1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/schema.js\":\"14e86102d6b91426\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/serialization.js\":\"77c6079f4099f00b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/targets.js\":\"cec30fb7844cd3f4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/tokens.js\":\"774ad8ceda8b5fd4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/watchEvents.js\":\"3d149e05c85d686f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/workspaceGuard.js\":\"a2f097c61c424480\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/writeCommands.js\":\"807166ff364b1196\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/AliasCollisionToast.js\":\"004252252dec43cc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/DuplicateNameBanner.js\":\"5c78926e210638f6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/collisionMerge.js\":\"92be02dc528216af\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/dataExtension.js\":\"930da3845e15d26e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/index.js\":\"9b53a7b4feaf3f76\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/mergeCollisionAction.js\":\"121fc16befe116d6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/pageStyling.js\":\"939be5a35253d523\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/rejectionToast.js\":\"bb4e86eafa90a4e7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/syncProcessor.js\":\"b05b06bd5fe9efd2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/actions.js\":\"9b549e7252951fb8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/addComment.js\":\"89e040595a8ebfa1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/anchor.js\":\"dbf76dc93a967096\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/anchorState.js\":\"8f879d0795fccfb5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/commentLinks.js\":\"df286c4099c1cc5e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/confirmThreadDeletion.js\":\"dd4737843a889e66\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/container.js\":\"5215e7497e51e864\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/dataExtension.js\":\"021104e3247044a1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/deleteComment.js\":\"02ecf48bdd0221de\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/highlights.js\":\"f4f5f0324892a4aa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/index.js\":\"2db330739899f9c1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/linkedCommentsPill.js\":\"85dd3658e5a4dcf3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/margin.js\":\"7743d49a04627529\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/marginSchema.js\":\"b48eb49ab79ecbb7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/newComment.js\":\"84f9b9263a5caadc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/ownThreadPicker.js\":\"1d937ce3888b22a1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/placement.js\":\"b92f1c0335c840b6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/queries.js\":\"113d27d6585d011a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/quotePosition.js\":\"17e4a14705b57d08\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/quotedIn.js\":\"b1df5a887f990cd5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/quotedRange.js\":\"eff98d97a9b487be\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/rangeRefs.js\":\"7301cb6154317c74\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/readHighlights.js\":\"a3d5a4a60fd992a5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/readSelection.js\":\"b5e419544b7befa6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/readSelectionUi.js\":\"92f159d3f1deb73b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/reanchor.js\":\"0b68fa26046b834d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/schema.js\":\"6ee1ab7e524af390\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/scope.js\":\"347d280e06706bd4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/scopeThreads.js\":\"9eb6fbec8e455ac5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/splitRetarget.js\":\"c4769a7f7683fb61\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/suggestionCard.js\":\"03ba033ec2b75c91\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/suggestions.js\":\"3c0a7ca368e11a54\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/summaries.js\":\"2b2a2c8174fbdf64\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/summaryBatch.js\":\"762d169cc370c34e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/surface.js\":\"a959e412419dc987\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/threadNavigation.js\":\"c378ccfa89232d4e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/threads.js\":\"984bc49627f83519\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/ui.js\":\"b874826542934768\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/uiStore.js\":\"b083bc93470631ce\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-intents/appIntents.js\":\"5a78063b7a9362a0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-intents/index.js\":\"5ecb8b5601a82d65\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-update-prompt/index.js\":\"15edd160be2f75eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-update-prompt/status.js\":\"8b343b2c878b4787\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e243d0fbf328a726\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/MediaBlockRenderer.js\":\"e60036bcb70ac08b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/MediaDownLaneReplicator.js\":\"cb4e2909c62642f8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/MediaUploadReconciler.js\":\"709956d18318c6eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/assetDownLane.js\":\"461532b6e45d8bc2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/assetResolver.js\":\"6add6e91b91ee48d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/assetUpload.js\":\"9e7532e0ee679be7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/attachmentCleanerIO.js\":\"2d5a5d0cbbbb7e64\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7fd9b527093355e2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/blobStore.js\":\"13053c97ba1bf389\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/browserMedia.js\":\"726f95eb9725357c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/byteStore.js\":\"fef64205e39ccb2f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/cleanerIO.js\":\"785ced009588e176\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/cleanupAttachments.js\":\"f820135663ff3538\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/dataExtension.js\":\"52c7727748dc037c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/downLane.js\":\"07bdc483b92d7c3e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/index.js\":\"8e2b485dfab7efa1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/insertImageContribution.js\":\"cc01c372eea62c57\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/laneArming.js\":\"5637502c67f19708\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/laneLock.js\":\"9e909f1b6ac5ec47\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaBlock.js\":\"4c46884acf703e15\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaCapture.js\":\"10d005acd4e5cef3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaLanes.js\":\"f7de4342a5a0d3d1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaViewers.js\":\"8f94c4f1cdac1b57\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaViewersFacet.js\":\"66c9b69e0e19cb90\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/pasteCapture.js\":\"74f9eb8a57e14d73\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/resolver.js\":\"72b0147c08353f42\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/retryUploadsAction.js\":\"38a0ada00f785dd6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/storagePaths.js\":\"c218963f6700e901\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadDrain.js\":\"7845a6d86bb571d9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadLaneStatus.js\":\"5d7c171d81ec5dbf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadReconcile.js\":\"d1a7c11e2e9c9a30\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadRecovery.js\":\"97c73598aa4d8090\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadStore.js\":\"0d830f8129cac3a9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/useAssetObjectUrl.js\":\"5bb62ddd5adf3c38\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"52020800a241310c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b2ee65dba7233cf0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/facet.js\":\"1bb34628af950a6b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/index.js\":\"c81805fe7008c7b9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/prop.js\":\"f012b71762dd677c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/BacklinkFilters.js\":\"9351b0218a342379\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"df60a5560cfe75d0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/BlockEntry.js\":\"d8c04bd253a04014\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/LinkedReferences.js\":\"5a2ab7c4c5a078d4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"aa7a9620a2a0874b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/dailyNoteDefaults.js\":\"d2cb9514281817fc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/dataExtension.js\":\"cf5cebdd467a635d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/edgeExclusions.js\":\"53b5eee9a8c5a164\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/filterProperty.js\":\"8923841195c868a3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/index.js\":\"b74a53b5ff3b7844\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d1a149b3efb104ab\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/applies.js\":\"34ff5290c1d10298\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/countQuery.js\":\"90e77e1f6158dea6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/expansionStore.js\":\"98345c3e3a530f29\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/index.js\":\"f9229e6930dda10d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1c275ba289e7522b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/presentationInvalidation.js\":\"db185e3d13c2c0bd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/propertyEditorOverride.js\":\"3e556904611b740a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/propertyFilter.js\":\"1c35ea13a6c56bdd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/query.js\":\"b029a33ccd64ea8e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/resolveFilter.js\":\"7132b9fcade8bce0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/sourceBatch.js\":\"8f0b7cc79110a494\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/sources.js\":\"ad3649e7e111989f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/useBacklinks.js\":\"cd52a7e520a902c4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2df0cd249033a6a1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/BirthdayCelebration.js\":\"0d35b17351e6079c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/BirthdayOverlay.js\":\"7dfdf042280cb7a7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/gate.js\":\"1e00d5d1c4068b1b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/index.js\":\"dfa5ef7c3fceeeba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/wolfTheme.js\":\"bb09e25810410432\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/BlockDragLayer.js\":\"44261bb07222056c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/dragController.js\":\"791d506f7d848ed2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/dropTarget.js\":\"22d9029cbe1bcc33\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/index.js\":\"335d2e092aae4362\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/projection.js\":\"06b27132f2fef116\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-info/BlockMetaCard.js\":\"e9a0b8d5e2ab6446\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-info/index.js\":\"03f6077b0e567c58\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/AddTagDialog.js\":\"32c2463c8e366cdd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fd4a5516d2323a44\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/TagNameIssueHint.js\":\"57ec6a49bb5b2073\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/addTagAction.js\":\"c7a28b6228c39a0f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/appendTag.js\":\"ff686a3a5220e4b8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/config.js\":\"4d3c425cabeded59\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/dataExtension.js\":\"b730295b39017fca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/index.js\":\"67a97db702624fbb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/propertyEditorOverride.js\":\"9bcd348c6c4aa051\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a7b54de04170f694\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cdbd3f4401672d39\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a4cb287137f2278f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6478b55a36fd76b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"114cb0ae3ee22908\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/index.js\":\"dc62a0c4dd52115c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4755a3d33ff1c901\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/CharacterCountItem.js\":\"aa528e1e2e1ca816\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4a713c543f5993b9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/actions.js\":\"6bc15a02036a6737\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/blockType.js\":\"710f8a34fbffb098\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/charCount.js\":\"8e935b77d6e8889c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/dataExtension.js\":\"f88eafff1ce1056b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/index.js\":\"dc379bc9740881ae\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/profiles.js\":\"32973ec2368d2267\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/properties.js\":\"28964bf29fe9cbdd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/textCounts.js\":\"318e4b618c00b2ec\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/colemak-keybindings/index.js\":\"14033490f8d10457\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/CommandPalette.js\":\"73a232ace4f90567\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/HeaderItem.js\":\"88c5daee6e86bfaa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/context.js\":\"b08f0fd12e9ae648\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/index.js\":\"85b506c06d6002b9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/selection.js\":\"a09bdb53e081c4e5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/toggleStore.js\":\"d596447fc7c6712a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/useCommandPaletteActions.js\":\"e6fcd9aba8efa945\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/ContributorBadges.js\":\"eb15f5e7afbb0fcc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/author.js\":\"fec252f1b10f43d1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/codeMirrorExtensions.js\":\"6b84d71feb15e80f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/dataExtension.js\":\"dede240711725fd4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/index.js\":\"7ff6fffb6089ac7d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/mentionAutocomplete.js\":\"c1dc398156197b30\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/processor.js\":\"3c8fddfb7c532142\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/profiles.js\":\"b0231c44f6f581e4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/queries.js\":\"75c45fd9173f7ae3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/schema.js\":\"e3d4fdaffe0a337e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"388ee735926445ba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/followOrigin.js\":\"eeda5b21a45f5300\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/index.js\":\"89b7b564e1c3c92b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a29f61ca30763155\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7740b5a49898dc19\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/CalendarGrid.js\":\"19ed0e96e64eaca1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DailyNotePicker.js\":\"1d855f764d210ac3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ea2a732b82e107c3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DateNavDecorator.js\":\"6ebcf1e16416554d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DateScrubOverlay.js\":\"525a4f99dd2355f3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/HeaderItem.js\":\"d14b5a8f5a24e2f3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/ReschedulePicker.js\":\"096133e7f03c6006\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5dc01ff768919ba5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/actions.js\":\"4d1cfe6cc87f8518\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/blockDateAdapter.js\":\"28964e665e55286c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/calendar.js\":\"3fd111aeda64431a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dailyNotes.js\":\"5c860c4efa44de6c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dataExtension.js\":\"cb82d72960a617d1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubActions.js\":\"94e86b4ebf81fd27\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubGesture.js\":\"155801255a41cff0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fc653c19f86fca79\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubRecognizer.js\":\"232a4b870fa901b2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/deletionGuard.js\":\"2d662cfbd39b00cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dueQuery.js\":\"3384ab46e92073b3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/index.js\":\"fb12985cd405e013\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/landing.js\":\"c8233f51b440ec0e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/localSchema.js\":\"711e8f99068e9a3a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/referenceDateAdapter.js\":\"729c506bed1db107\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/rescheduleAction.js\":\"7a2adee5b03c0126\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/schema.js\":\"bee2b70045507608\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/spreadBlockDates.js\":\"8e17bca5ba6aa380\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/spreadDatesAction.js\":\"7d2f4935a32c47eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/today.js\":\"056a8d53c73e950e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"38b6386c61f33d1e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e518cae58413261e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/audit.js\":\"2a0fdfa0fa74e4fd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/auditAction.js\":\"51db6e6bd7de8efe\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/auditRanges.js\":\"05809334509ffd7a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/diagnosticsSource.js\":\"4fe27d997ca7e0b6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/divergenceScan.js\":\"dd776a36ec93db8b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/index.js\":\"d1cf0559d8292828\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/propertyChildrenChecks.js\":\"abf98eff5d79072d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/referencesMirror.js\":\"6d2731c93fb02012\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/rowJson.js\":\"6b50362cbbf64dd9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/schedule.js\":\"1592b2b47cc11af0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/store.js\":\"987d60907ded0aca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-maintenance/action.js\":\"06df181709955670\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-maintenance/index.js\":\"00f92c683a08411b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-maintenance/plugin.js\":\"625a5986ee4dfc10\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"908c98dc3277e1cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/actions.js\":\"9248ee3cec8d823d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/changeMarker.js\":\"4716d1f53e304ac9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/diagnostics.js\":\"693f4aa6ff659e1d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/fileSystemAccess.js\":\"4d9ca7d9fc2a111e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/filenames.js\":\"5a3e43e97b51ab99\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/index.js\":\"a146d2c63385ff34\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/mirror.js\":\"720ffab2d78a7928\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/runLock.js\":\"47a4779077c75c71\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/runtimeHealth.js\":\"219c965256888c35\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/schedule.js\":\"b6675eb6d0cea2b7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/store.js\":\"5ccf30ad0cd74cb7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/default-themes/index.js\":\"78ecb1d7100d32ad\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/default-themes/themes.js\":\"c538902ecfb99aac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/diagnostics/facet.js\":\"d3f75e92d68745bf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/diagnostics/useDiagnostics.js\":\"58962af7ba1ca15f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/dismissals.js\":\"5aba6dbea9d90858\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/index.js\":\"e8bc54ffe054e9b6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/status.js\":\"7c71f6c33180dfea\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/store.js\":\"05c6ebb5b2915dce\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"794a48cbd6b1c7cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e3f4d2e65a41dddb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/actions.js\":\"48a66690063f2f3e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/config.js\":\"8154c4f48216550b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/dataExtension.js\":\"e6eef2e4a09892b6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/effect.js\":\"672d73ede5e258b2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/index.js\":\"e05f13b7ae4abdca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f90fd56ed1aa6333\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/useToggleTree.js\":\"d4bdd206cabceef9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/ExtractTypeDialog.js\":\"7b9f74f782df7097\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ccf83743cb25cc66\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/PropertyShapePicker.js\":\"46ad2c15f23064a4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/action.js\":\"6ba590e44d4a2a9e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/index.js\":\"13df5e7a0690c2a6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/FindReplaceDialog.js\":\"60d11ce135784339\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/HeaderItem.js\":\"cfb858d02f06008d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/dataExtension.js\":\"2e92ebe483829d0d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/index.js\":\"9fa2556c43b1b303\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/search.js\":\"4c9eb1b36db5361f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/toggleStore.js\":\"cbf1985c9ae7a0a7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/LocationPropertyEditor.js\":\"84e312a06684f99a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/MapView.js\":\"5ca23bf4c4b832e8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/blockTypes.js\":\"ff3f111a336db1b3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/codeMirrorExtensions.js\":\"e1961c5190f0024c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/createOrFindPlace.js\":\"7451889ce3b48080\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/currentLocation.js\":\"87dff3cff5e006e1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/dataExtension.js\":\"cd1ad138d72dea20\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/geoContentDecorator.js\":\"3ca5154001cbfeb6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/googlePlacesClient.js\":\"828164ffc4f23ad8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/index.js\":\"032b8cb10be59e78\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/locationsPage.js\":\"4520d2ddec7f3a27\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/mapViewport.js\":\"0ca456516dc375c1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/pickCurrentLocation.js\":\"7fcf3cac9447023c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/placeAutocomplete.js\":\"f6f6b6492fd87c92\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/placeNameCollision.js\":\"9733609071ec5128\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/properties.js\":\"549a4b087b34751a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/propertyEditorOverrides.js\":\"63cda6adf6b8030a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/query.js\":\"10963308aded4a47\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/usePlaceSearch.js\":\"89a1c2b10b927899\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"78d18806c42bc77b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c844402693599c3c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4bd4734b67e2aad9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/config.js\":\"73d0430147e02a4f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/dataExtension.js\":\"6bbad00008a610ca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/facet.js\":\"8db166254d4e602e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/grouping.js\":\"47e840feededd0c9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/index.js\":\"6a380be13fc77079\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9046eff5fa732061\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/query.js\":\"fcdb9e74ef3d22fc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/resolveConfig.js\":\"e0b83a675f775ca1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2ded4a0bf77d23ae\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"381faa39274f31ed\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/HtmlDocumentContent.js\":\"f5b7cbeedf1adfcc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/HtmlFrame.js\":\"38a5520ec5934225\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/actions.js\":\"7535bdbe821ed347\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/blockType.js\":\"efea81f6e6a5e692\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/confirmRunScripts.js\":\"cc87b12a6f2e80e4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/dataExtension.js\":\"1ef23680a7612ebe\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/frameAnnotations.js\":\"a0b8bc48e4b14074\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/frameDocument.js\":\"890dc7f441ebe520\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/frameTheme.js\":\"327e1f09edbe0db5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/index.js\":\"30d281e1c44e1dee\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/scriptConsent.js\":\"3ebe0ba8d4bbd9ff\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/sourceMap.js\":\"eac70daa908e67a0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/useDocumentScripts.js\":\"3d5ed5be7b2d6f1d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/index.js\":\"5acbe60b0b3c8fdc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/record.js\":\"3043dbdf1337dd8f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/recordStore.js\":\"4fe9e6f9070d3ce2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/responsiveness.js\":\"300997ca02a5725d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/schedule.js\":\"e770388ffdc3559b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/sessionContext.js\":\"133dfda236247ea5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ea7d67fbce472afa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"43674be93df8aa1a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/actions.js\":\"3ef2d46fab36881f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/config.js\":\"003ba61c0c534808\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/dataExtension.js\":\"bafa25d633e09c77\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/effect.js\":\"ffb75e7fd0cb8dac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/index.js\":\"fd4ea95a6fa43271\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/keyCapture.js\":\"e3c59af5b04541cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/overrideStore.js\":\"2edd6e2929e2f484\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ca2478c3d706143e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/HeaderItem.js\":\"0939cf532b5acda2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/LeftSidebar.js\":\"085131f42bd33e46\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/actions.js\":\"df1d8479fa6e1c91\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/facet.js\":\"e4a8009a55e62a74\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/index.js\":\"2b62210018ebeffd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/shortcuts.js\":\"aab013ef39bf6ac0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/toggleStore.js\":\"47a8e462ebda4c6d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/MergePicker.js\":\"62a9db7c352ee78d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/index.js\":\"f31add33532c5f36\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/mergeAction.js\":\"8bd04bb7ead2eb64\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/strategy.js\":\"f776dfc8f2074b13\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/Button.js\":\"8e790f47ccc0ad37\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"eae9d65a7a69bb98\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b69718d5585b4b60\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/facet.js\":\"170543ac2ce0157b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/index.js\":\"c712a3d6aa32f3b4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"359fc901efba684b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/actions.js\":\"17cd2eae594de1a2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"174a24b4a9df362f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/facet.js\":\"185e2b679f079809\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/index.js\":\"8818ae743d16ba8b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b4f33eeab3486c72\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8b788e07180e5bd4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/contextMenuItem.js\":\"ca404c815f89d552\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/index.js\":\"d62f952b7bcfccc9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/moveAction.js\":\"825e53bf091e71c0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/moveBlocks.js\":\"da983a18f6a1aa84\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/selectionAfterMove.js\":\"2afaabf4cbe7be14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/TutorialBanner.js\":\"ff58b6ccb1ba15d0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/action.js\":\"22d79042bff1dff4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/bannerDismissal.js\":\"9d28566b2f6184b2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/documents/cheatSheet.js\":\"1898787f8d1ce285\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/index.js\":\"a3c21c383ed69a84\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/keys.js\":\"977b027fc5878608\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/landing.js\":\"dcfb935442d06ca7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/outline.js\":\"71be086e786c1e13\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/seed.js\":\"426b72c5f35791c4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cbb50b19eb1648f8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/analyze.js\":\"d99dd9260ddf6901\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/diagnosticsSource.js\":\"0ead6851d0ed291f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/index.js\":\"9613563bf02157ba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/load.js\":\"0a271c4e3325c0a3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/monitorRun.js\":\"6e8ec9565f51f7c7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/schedule.js\":\"5aecbe10ab91fefd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/series.js\":\"478a88cc8bbb9dac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/store.js\":\"f6853c292c0c637f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/trendAction.js\":\"984f7796b0fa2c93\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/verdict.js\":\"8ced779c243ff9e9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/plain-outliner/clickToEditAction.js\":\"1c26c20175502363\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/plain-outliner/index.js\":\"dfb365372842bb31\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/plain-outliner/interactions.js\":\"c392551253912408\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"12884ce0aac84b25\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/MigrationGate.js\":\"8da5e11776a8f39b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/MigrationGateDialog.js\":\"9546ca88bdcd0c3d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/action.js\":\"9685e4eee4d55e20\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/index.js\":\"6d654d53456c6790\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/localRunMessage.js\":\"d263bfb2864cf17c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/plugin.js\":\"5930608c47e15975\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/progressReport.js\":\"6b7cecd0070e5d6f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/sweepProgress.js\":\"d56fcc4be73b38f9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/FieldRowRenderer.js\":\"37b9506148efcd29\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/ValueRowRenderer.js\":\"aefcb29b7ac45d42\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/actions.js\":\"0e93207170277d0e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/autocomplete.js\":\"ffeb571d06cdbc1b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/fieldRow.js\":\"1ee9ddb6a3912008\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/index.js\":\"626da462f1d81d80\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/referenceWarning.js\":\"0001633249a0761f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/valueAutocomplete.js\":\"754dbaee857171e8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/valueSchema.js\":\"4550e99f44e47b87\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/HeaderItem.js\":\"bf8b67fb64a34a4e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/QuickFind.js\":\"344e85c2cddccfe3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/index.js\":\"3a044dd7ddd67b84\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/recents.js\":\"510b94d9ae3a23cc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/resultItems.js\":\"d483f0b4050df617\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/selection.js\":\"0dbfc22a5771f50f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/toggleStore.js\":\"18b53138adcf4740\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/HeaderItem.js\":\"fa99885bc31b98e1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f98596943198ac46\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/grouping.js\":\"528ba34a85f0a22a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/index.js\":\"143c2e8b7ee9dfa8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/target.js\":\"a88c81d6907c40b6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/codeMirrorExtensions.js\":\"121cded63590bd98\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/contentPrefill.js\":\"49545a84d709d684\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/dataExtension.js\":\"671fff6d92d7feaa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/index.js\":\"1065bb63ccffb086\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"1094346c2e45a182\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/invalidation.js\":\"e1e841a56328286b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/localSchema.js\":\"19038c25c7aeea77\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/blockrefs/index.js\":\"4b2974d690d249de\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"637d912d30207d83\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/index.js\":\"13a2dea78d8c883b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/referenceNode.js\":\"36d754a58cf67be6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/remark-reference-occurrences.js\":\"719a196d5a4d13d6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"584b2a140d796102\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/index.js\":\"7a77c5e15a8c555a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a1310570018be19f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2aa423a9b148d207\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/mergeRetargetProcessor.js\":\"3833df0e6f001ac3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/parseFence.js\":\"0ba22feeeab3b942\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/referenceParser.js\":\"1e056ba24ee8be3e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/referenceProjection.js\":\"a8197e356718b516\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/referencesProcessor.js\":\"f4e587458cea993b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/renameProcessor.js\":\"e679dd296159096e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/spanReplacement.js\":\"1856b00d6f84a066\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/htmlToOutline.js\":\"80d6dd41be0c590c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/index.js\":\"6bcd7978d7bbc387\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/normalizeClipboardDom.js\":\"215f9407ba168542\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/pasteDecision.js\":\"d06e647b8504e30e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/action.js\":\"9c0a0992eee0a8a1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/blockIds.js\":\"19f297780209c096\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/content.js\":\"d286ec82712115d4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/effect.js\":\"857431f32bed75b3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/ids.js\":\"186a7f3cfa481451\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/import.js\":\"46172d4a7c4078e9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/index.js\":\"ab6aae52985adca3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/plan.js\":\"f1e5c592b1d02587\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/plugin.js\":\"343b9dc201ef4edd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/promotion.js\":\"93f5521a46ea347c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/properties.js\":\"133caa9ae9597345\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/references.js\":\"a2cc626512a765bf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/report.js\":\"5da41d0529e57833\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/roamMemo.js\":\"2c223c2e4f42464f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/runtime.js\":\"ff0fb8ee6a481eac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/schemaReconciliation.js\":\"8cb38ecc0abbc9a8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/srsMarkers.js\":\"1482af9074818af1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/todo.js\":\"1597922120a5c7dd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/typeCandidates.js\":\"dba64e1361c058f9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/types.js\":\"026b4ffa26719329\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/search-health/index.js\":\"3345e0875fe40614\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/search-health/store.js\":\"5a5b06e3d3a17a81\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/HeaderItem.js\":\"eef2bf38d3a5a357\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2b2b60382938ab79\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/index.js\":\"b0c9cedcd2d9b835\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/model.js\":\"08575a0f5bdb3070\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/toggleStore.js\":\"2984e171049a5b41\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/useKeyInspector.js\":\"a40b7610df34f199\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f4141e92b1ebad70\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/ShellDecorator.js\":\"1ab2b739716488ba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/actions.js\":\"4a13ded081e6ce10\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d9a343660a29d183\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/index.js\":\"c23ef74130092063\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/shell.js\":\"32315ed6c4091a14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/surface.js\":\"02a5a3fa7bd2093c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/walker.js\":\"a1607383f62bb309\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4784149013e08cfb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/dataExtension.js\":\"726f42387c22145b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/index.js\":\"b4b6bd88a4077be1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/indicator.js\":\"dd24ed3027a688ed\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/moveSrsState.js\":\"ef975dfc93d5a9a3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5696b32ad3438d62\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/scheduler.js\":\"9025b23f7f076087\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/schema.js\":\"296e13bfd5559c92\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"decd916a4f397385\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/srsClipboard.js\":\"a79170a13fc2a0e0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d61223e2b863a03b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9a48551e4c89941d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/DeckPicker.js\":\"063c5b617fc0cd91\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/ReviewControls.js\":\"103ed256a632b395\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f3f9045ea2aa024d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/ReviewSession.js\":\"c4f383a685264879\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/actions.js\":\"a68af2c6088ccb5c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/archive.js\":\"5ca0acbb997c9206\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/dataExtension.js\":\"d8aeba1d5d965585\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/deck.js\":\"38eabae9d03eaa60\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/dueQuery.js\":\"747da41ec2be4a74\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/gradeDecision.js\":\"77fc25b13cf8348b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/index.js\":\"78e24e251a817475\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/keyHints.js\":\"d7b2dfedc29c1577\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/reviewCardLayout.js\":\"ba9495cf14af02a5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/reviewProgress.js\":\"ea503cd8a0cd60f3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/schema.js\":\"e7b3fca654cc65be\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/useDueCards.js\":\"54ac5aa4443806b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/startup-metrics/index.js\":\"12a00e1c53b3a902\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/startup-metrics/record.js\":\"18197e7e674d6453\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/storage-persistence/index.js\":\"3742f218da6d2ae5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/storage-persistence/persistenceStatus.js\":\"4e2771a6cb86b890\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/storage-persistence/requestAction.js\":\"84069142a6648175\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/TypeChipsDecorator.js\":\"aa644ace80144560\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/codeMirrorExtensions.js\":\"ceaa156591298a70\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/index.js\":\"bfe6869873e2efdc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/typeAutocomplete.js\":\"8954ff8265398692\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1b5d1dc9504ce8d1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/actions.js\":\"0a28a2e32dc07a70\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/anchor.js\":\"75298eadcfe5cd8c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/events.js\":\"08cf96936e2e461a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/gestureActions.js\":\"cf3cbd8171ad92e6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/index.js\":\"75de5b84551f3642\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1037ffddfc40667c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/sync-metrics/collect.js\":\"f4147ddc32bb1c9b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/sync-metrics/index.js\":\"26732fefbba989e4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/sync-metrics/record.js\":\"ac33dcc6097dac29\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/RejectionDialog.js\":\"f622657b4b4eb99e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f9c2e3ea36ef3d1f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/index.js\":\"29efdba998387e83\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/model.js\":\"122ef3a4074b7794\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/queueCounts.js\":\"a1e01fb604d9aebb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/rejectedHelpers.js\":\"0b8c2cdad4bb87aa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/rematerializeAction.js\":\"8525eaa72f70dec2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/useHysteresis.js\":\"1c224cef0e112027\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/ColumnHeaders.js\":\"161834f5cd1a7d66\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/QueryUi.js\":\"1328b4afd134936a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/TableLayout.js\":\"f500fc6a4d2d3981\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/actions.js\":\"2bda6f8d67cdb1cb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/cellEdits.js\":\"cbdec4611e3fe482\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/columns.js\":\"a2bf6c03739199fc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/controller.js\":\"78b73867fe63c269\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/convert.js\":\"fdc1fd63f1055a63\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/dataExtension.js\":\"e21eb083ca83b3a2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/index.js\":\"b645d870be56fc9e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/keys.js\":\"0b20a7280d2aa1a5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/model.js\":\"8a6da4c9fab5810e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/navigation.js\":\"4c30d3632f4d0f30\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/backfill.js\":\"36da5f79b5f53bbc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/completion.js\":\"03f30c67f2828f00\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/format.js\":\"edee2d487a88a77d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/parse.js\":\"5be6acd4ee431e97\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/queryValue.js\":\"0daf69410188f05f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/source.js\":\"16155c4d534347b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/registry.js\":\"9e14a34815c928ca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/rowGutter.js\":\"c6b099a136fd7d62\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/rowVerbs.js\":\"eaec23cf4d8d725a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/schema.js\":\"e22326f0f639b734\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/sort.js\":\"65af93bbf9c8c418\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/theme-toggle/effect.js\":\"107e21db73a332ba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/theme-toggle/index.js\":\"b8d241f42d5e0ea2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/theme-toggle/theme.js\":\"c48886a2e0cc4c09\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/actions.js\":\"dbc02b30917d3cf1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/dataExtension.js\":\"a63f7476bba49b49\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/index.js\":\"88afd56d82a448e0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/schema.js\":\"18c45cef17420c67\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f3e7449b890be079\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/actions.js\":\"e6ebafaef6ba793d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/defaultItems.js\":\"6581e26f58b8d1c8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/facet.js\":\"f7d41071e744b5a6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/holdRecognizer.js\":\"28678c5fb2b3f478\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/index.js\":\"7c9fb2f804fe0eb9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/update-indicator/UpdateIndicator.js\":\"df2a695e8b2a2342\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/update-indicator/index.js\":\"8584493bed35e0a9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/update-indicator/loadTimes.js\":\"046ab13fcb2ee444\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/VideoNotesRenderer.js\":\"8ad905f3deae557c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/VideoPlayerRenderer.js\":\"db9dc32162ffe6bc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/VideoTimeStamp.js\":\"3af77f68fde53611\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/actions.js\":\"234340084ed1681b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/index.js\":\"9651ba97c7718e9a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/markdown.js\":\"23b3779717b48c3c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/notes.js\":\"c30acd9850238c11\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/registry.js\":\"10f0fbe98ccae81e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/remark-timestamps.js\":\"b905f64875697bb3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/view.js\":\"c61e661d9b0b8787\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/LinkHints.js\":\"fe1e82992a478a41\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/index.js\":\"9e760ac39c8a1162\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/model.js\":\"947fb1946fbc82f7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/settings.js\":\"37c3e8dab794869b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-normal-mode/actions.js\":\"1b9c6e8a6e4a3068\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-normal-mode/index.js\":\"05e486b848d16531\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-normal-mode/interactions.js\":\"092363f2a07b0661\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/workspace-header/index.js\":\"2b012c259ab61af6\",\"/knowledge-medium/pr-preview/pr-1864/src/registerServiceWorker.js\":\"25d529d7e6637f7b\",\"/knowledge-medium/pr-preview/pr-1864/src/requestPersistentStorage.js\":\"623dc3f5d21bc360\",\"/knowledge-medium/pr-preview/pr-1864/src/services/authRequestDeadline.js\":\"b7e1d49bcd2684f7\",\"/knowledge-medium/pr-preview/pr-1864/src/services/authStorage.js\":\"9b24f6d361e77a82\",\"/knowledge-medium/pr-preview/pr-1864/src/services/powersync.js\":\"394227c83f05644d\",\"/knowledge-medium/pr-preview/pr-1864/src/services/supabase.js\":\"65b652c0c9298096\",\"/knowledge-medium/pr-preview/pr-1864/src/services/uploadErrorClassifier.js\":\"e412f2f2b745c0ac\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/ActiveContexts.js\":\"d7b1fa0b268890da\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/HotkeyReconciler.js\":\"9fb2d1b39b84a9c4\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/WipeLocalDataDialog.js\":\"5d9b2bbfbc9cd61d\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/actionDispatch.js\":\"465dda779e949876\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/actionRefItems.js\":\"f8197b548c10d56f\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/applyKeybindingOverrides.js\":\"c72d4f9ab0e8a3b8\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/blockActions.js\":\"4d8733ebe606e6cc\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/blockMergeGesture.js\":\"5af4b39da132b918\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/canonicalizeChord.js\":\"1be6bf2a0769f46e\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/defaultContexts.js\":\"68cb2b153837272a\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/defaultShortcuts.js\":\"3d5b0b784ca9f61a\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/effectiveActions.js\":\"4a349f789e8531dd\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/gestureAction.js\":\"1945ced786f7e76f\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/gestureBinding.js\":\"e1ff15eeca92c09d\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/holdRegistry.js\":\"a9406d232dc67be6\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/keybindingConflicts.js\":\"37ba7eefbc0ae9af\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/keybindingOverrides.js\":\"f58e0a3edc9d43a2\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/pointerAction.js\":\"99fb8f64630fe03f\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/resolve.js\":\"4b6395d9e54d9c04\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/runAction.js\":\"633451699c02a011\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/sequenceMatcher.js\":\"52bd93336c525385\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/types.js\":\"e4ee961e538b313c\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/useActionContext.js\":\"cd8cb0a08ec4fca9\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/useActionDiscovery.js\":\"c3630629666ac881\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/utils.js\":\"bcc6a5c465a3c01d\",\"/knowledge-medium/pr-preview/pr-1864/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1864/src/sw/bootStore.js\":\"59c38b25ee574758\",\"/knowledge-medium/pr-preview/pr-1864/src/sw/previewDatabases.js\":\"bd63c2a58983c3ee\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/byteTransform.js\":\"e515021ea2a1d5b1\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/attachmentCleaner.js\":\"839648ced27f894f\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/attachmentParts.js\":\"4a756395b0eacdbe\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/bundleParts.js\":\"624e5b9d292b4ebc\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/bundleRecord.js\":\"d3b81aaa13071406\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/manifest.js\":\"7a880d4066b663ed\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/takeBundle.js\":\"c8eeb2ea11bc92a1\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/verifyBundle.js\":\"4f62e343474f7ea1\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/cleaningStage.js\":\"9c2136cbc9c0d702\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/conversionKey.js\":\"a23fa0bb7069c3a8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/conversionServer.js\":\"683f9435d6e1e885\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/flip.js\":\"6b15ff26b4a17064\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/flipAttempts.js\":\"efe86b04d922d54c\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/pages.js\":\"64fe1566f2a86eed\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/preflight.js\":\"1133b9b4cacb307b\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/reseal.js\":\"5ce53ec06d8fce76\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/runConversion.js\":\"5a3eaed5811433aa\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/runLock.js\":\"8f36c17f06cd4cb2\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/sealing.js\":\"43fb9fdba3632a5e\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/sealingStage.js\":\"5202d36eab09f84c\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/stage.js\":\"55cb96e3e9082697\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/verifyReseal.js\":\"ba9afbf6e15fbf73\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/aad.js\":\"38fc78ddd6139035\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/aead.js\":\"1e67dcf7aa1a6c37\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/base32.js\":\"1025ebc16049d0d5\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/base64url.js\":\"42a91ee589eaae99\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/binaryEnvelope.js\":\"7fab12e233cf7488\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/byteAead.js\":\"0b255eb61eac8907\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/canary.js\":\"dcd8056a11f0051c\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/contentHash.js\":\"a5c8ccb15724707a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/contentKey.js\":\"a8e204f727efb82a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/derivedIdNamespace.js\":\"ebbf5360d2f06ce8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/envelope.js\":\"4cfa155c4e33c37f\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/hex.js\":\"3264c78614c3b14b\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/sha256Hex.js\":\"3c9f972b0822ec04\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/workspaceKey.js\":\"906566c1e251606a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/conversionState.js\":\"5c5a2e15e858f897\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9ff2be75bd28ccc7\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/pastedKey.js\":\"bf38b3aff6a2a2ae\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"902ea52c085cda23\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a418b16e1f2c05d7\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/keyStore.js\":\"4d0782b606f56000\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/mintWorkspaceKey.js\":\"51d413ae0980f488\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/modePin.js\":\"5c3cbda016c32cc8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/openWorkspaceKeys.js\":\"8a5022e87fba21da\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/resolveWorkspaceEntry.js\":\"f334186b7b10743e\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/resolver.js\":\"ea6867947e54261a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/workspaceAccess.js\":\"b5bbbe80228f68dc\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/transform.js\":\"05c5ae451c138065\",\"/knowledge-medium/pr-preview/pr-1864/src/themeBootDefaults.js\":\"3c72f0a28293bede\",\"/knowledge-medium/pr-preview/pr-1864/src/types.js\":\"95594cdf1b43b8ce\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/ClientLocalSettings.js\":\"e1b0cb5b50029541\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/abortableSleep.js\":\"629401a3bf54e68c\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/array.js\":\"e575a0b5fbd19023\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/backlinkAutocomplete.js\":\"0c3bc8a77b22f40f\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/blockCrumbs.js\":\"481844acf5dc7b60\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/blockrefAutocomplete.js\":\"92dbace6cec8332a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/cadencedIdleJob.js\":\"31e3d2b8e513a9f0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/callbackSet.js\":\"910e54795ee9ca28\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/clientId.js\":\"e2bb4880682c7c73\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/codemirror.js\":\"f1e77def0156ed03\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/codemirrorCompletion.js\":\"a7ce72fd01efdce1\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/copy.js\":\"bb9279b7b66981bd\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dailyPage.js\":\"9b481d35ef529533\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dbForensics.js\":\"e8538eebd5bc2285\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dbForensicsHooks.js\":\"e61cd6cdc201b28e\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/deleteBlockThroughUi.js\":\"51c0b4a0cb7789f8\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dialogs.js\":\"ed8e3597b96efe75\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dom.js\":\"aaa2580f4394daec\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/downloadBlob.js\":\"16cbddb159eeb690\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/exportSqliteDb.js\":\"bdf57861fe41ddd0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/fileSystemAccess.js\":\"4b9baea602d48a66\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/flipSlide.js\":\"049a66601618957a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/fnv1a.js\":\"30589af6dbb6684a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/formatBytes.js\":\"01a599f8c618d445\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/fuzzyRank.js\":\"a691be75e9b944bf\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/idbKeyedStore.js\":\"358b7c80cd09aa18\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/idleCallbackPolyfill.js\":\"dceb9c6d73a9fd14\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/keyboardAwareScroll.js\":\"2d7455c461e17439\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/keyboardViewport.js\":\"734756d14017ea1f\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/lastWorkspace.js\":\"dce84b52e5168162\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/layoutColumns.js\":\"e6b6d36ac3cfedd0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/layoutSessionDom.js\":\"b472ec83be98d266\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/layoutSessionId.js\":\"8b959d67e0a35022\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/linkClickGestures.js\":\"230195c9524f407d\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/linkTargetAutocomplete.js\":\"2372352157b72d5c\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/localDbCorruption.js\":\"568cf37a7b117b09\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/localDbRecovery.js\":\"6ee6a33d049986de\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/markdownParser.js\":\"898295f3b2dcdb00\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/memoize.js\":\"6a92514ef7874877\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/nameFieldCommit.js\":\"e5af6e76bd5f248f\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/nameList.js\":\"653a6be992c47df7\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/navigation.js\":\"f335076024110397\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/omnilinerNamespace.js\":\"6dab428d869e1928\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/opfsPageScan.js\":\"12570b094ede4e66\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelClearance.js\":\"2e3fabf378666883\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelHistory.js\":\"af3fe0fdf6acbcf7\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelLanes.js\":\"5736dff3229433f1\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelLayoutProjection.js\":\"7728cf76ce308cb7\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelScrollAnchor.js\":\"32ca4624243dc1a2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelUrlFlags.js\":\"6783181b1cb6e56c\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/platform.js\":\"b6dedc3c7fcf313b\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/pluralize.js\":\"fc4a07bad10c2f8f\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/propertyCreation.js\":\"706df702f712f4e2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/propertyNavigation.js\":\"8467a32d676e9ea0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/propertyValueContext.js\":\"66b321913f399436\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/react.js\":\"cc7b81dd01021054\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/relativeDate.js\":\"c64c652645f786cf\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/relativeTime.js\":\"be84817bb457d5e8\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/renderScope.js\":\"08b04311d3d5471a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/resolvedThenable.js\":\"a23ef3dccb9bfeb4\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/routing.js\":\"be52f555115a9b56\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/safeMode.js\":\"884fd7371df75014\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/scheduleIdle.js\":\"d43e004f925d3663\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/screenWakeLock.js\":\"95337d0b96388a31\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/selection.js\":\"2f7157ee1f52b5b4\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/softKeyboardGrab.js\":\"a4ef71023c778afd\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/startupTimeline.js\":\"d9dd1e036c812f60\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/state.js\":\"99b8fbf8b55458ef\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/string.js\":\"242abf8f25c5fe4a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/surfaceZoom.js\":\"a5f1f33707770505\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/time.js\":\"778ce0a30bd9234d\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/toast.js\":\"af95517a2dbb7410\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/toggleStore.js\":\"edc50c799938b464\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/untilStopped.js\":\"41d3f86bde598c96\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/userActivity.js\":\"5a75ca2eb2d4d450\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/viewTransition.js\":\"916625c23ccac37d\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/viewport.js\":\"d8042ae3212e8cf0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/webLock.js\":\"614b298b23ae98e3\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/workspaceRecovery.js\":\"0e0a71d0e0a0a689\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/workspaceSnapshotStore.js\":\"858eecdac4b70cd1\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-compiler-runtime.js\":\"2911283ea21d1677\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-client.js\":\"e03ed401996344d6\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-server-edge.js\":\"55fd32467762fb53\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-server.js\":\"a15627159d1b3318\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-static-edge.js\":\"b2b540e2fff3ed3c\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-static.js\":\"3876494891504810\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-test-utils.js\":\"245aaab2b8a6da09\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom.js\":\"36ac175785283b4f\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-jsx-runtime.js\":\"dd5dd23b7caf8a6f\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react.js\":\"2954bbdf0fac0c54\",\"/knowledge-medium/pr-preview/pr-1864/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1864/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1864/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
