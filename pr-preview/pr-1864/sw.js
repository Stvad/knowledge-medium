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
		buildId: "7052c316ff25-62fc1f1f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1864/\":\"0899b2be43798a08\",\"/knowledge-medium/pr-preview/pr-1864/index.html\":\"0899b2be43798a08\",\"/knowledge-medium/pr-preview/pr-1864/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1864/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1864/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1864/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1864/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1864/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1864/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1864/assets/FacadeVFS-B0NVfCFB.js\":\"4e670a27cd469cab\",\"/knowledge-medium/pr-preview/pr-1864/assets/OPFSCoopSyncVFS-W9Y-Rxiu.js\":\"ff99377e151d271f\",\"/knowledge-medium/pr-preview/pr-1864/assets/OPFSWriteAheadVFS-D1vKOs_a.js\":\"889629d3350cdcc6\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-Afk3xCD0.js\":\"90d9c104a6cc685e\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1864/assets/wa-sqlite-async-BdmlUoHa.js\":\"6c56f174ecfd25ea\",\"/knowledge-medium/pr-preview/pr-1864/assets/worker-BWk925FV.js\":\"79a3dc64295839dd\",\"/knowledge-medium/pr-preview/pr-1864/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1864/chunks/app-YOmO0SCq.js\":\"2e8c12ae72d8dba5\",\"/knowledge-medium/pr-preview/pr-1864/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1864/index.js\":\"fcd209f05867d0d3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1864/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1864/assets/AccessHandlePoolVFS-BSplSlZN.js\":\"cc97e2a86a9d0695\",\"/knowledge-medium/pr-preview/pr-1864/assets/IDBBatchAtomicVFS-BBOO7Eqz.js\":\"965fb512d56f6e31\",\"/knowledge-medium/pr-preview/pr-1864/assets/MemoryVFS-0PcxEftt.js\":\"811bf195f6aa4ba1\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-CsKKkxjg.js\":\"0991b257ec91a887\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-async-DEfdM9Tk.js\":\"cfa85338822fb926\",\"/knowledge-medium/pr-preview/pr-1864/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1864/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1864/chunks/AccessHandlePoolVFS-BJ8LDemb.js\":\"5af62102bae5ff9f\",\"/knowledge-medium/pr-preview/pr-1864/chunks/FacadeVFS-COmRQoEG.js\":\"405c7502f5d651cb\",\"/knowledge-medium/pr-preview/pr-1864/chunks/IDBBatchAtomicVFS-DavxyxcW.js\":\"8150f7afa4f17e8e\",\"/knowledge-medium/pr-preview/pr-1864/chunks/MemoryVFS-D0u33Dbb.js\":\"e68468e8686e4185\",\"/knowledge-medium/pr-preview/pr-1864/chunks/OPFSCoopSyncVFS-0yXUn_-N.js\":\"d5aec410ca0186f6\",\"/knowledge-medium/pr-preview/pr-1864/chunks/OPFSWriteAheadVFS-CDz4nLD1.js\":\"fe9bfdf1f5ba5eb0\",\"/knowledge-medium/pr-preview/pr-1864/chunks/Preview-D4umjtBa.js\":\"23b21e0d43f9d3ac\",\"/knowledge-medium/pr-preview/pr-1864/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1864/chunks/card-BGPy-b8k.js\":\"0ff3c46fde3d285d\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dist-Brj-WlDh.js\":\"bf2ef2cd0be8bf17\",\"/knowledge-medium/pr-preview/pr-1864/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1864/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1864/chunks/mc-wa-sqlite-async-DcjImBYp.js\":\"8e4376a0a262d58e\",\"/knowledge-medium/pr-preview/pr-1864/chunks/mc-wa-sqlite-j-QsFVVQ.js\":\"d2e9fcd5d163efa9\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-Bkc4g3U_.js\":\"6f156bedec839315\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-BxERfiIn.js\":\"42ef33d5be00ca54\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-C5Q9OOyb.js\":\"58f339001865800a\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-C9qbGszK.js\":\"42fe1148002d1c84\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-CK-yfAkr.js\":\"e4c9e0c32c196785\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-Dwyb__3W.js\":\"460b608527f4e9ff\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-am5JAfvh.js\":\"4da83308a005cf66\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dEUwR-KR.js\":\"00bf5cd984f2ac4f\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dom-server-legacy.browser.production-Kki3Go3j.js\":\"518d65b2172fde94\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dom-server.browser.production-BegyobxO.js\":\"3a2eb451366cb7a5\",\"/knowledge-medium/pr-preview/pr-1864/chunks/react-dom-server.edge.production-DaYTBPiX.js\":\"ff7943a3dfdd5393\",\"/knowledge-medium/pr-preview/pr-1864/chunks/server.browser-B2kxSUpW.js\":\"ae9354c7fd823b75\",\"/knowledge-medium/pr-preview/pr-1864/chunks/textarea-C2La4MX_.js\":\"05c30a2d84270c8a\",\"/knowledge-medium/pr-preview/pr-1864/chunks/ui-DdpRaG4V.js\":\"3b4331ac753af69b\",\"/knowledge-medium/pr-preview/pr-1864/chunks/wa-sqlite-Dq03HU_w.js\":\"a62e35fc62cc5399\",\"/knowledge-medium/pr-preview/pr-1864/chunks/wa-sqlite-async-C_79kuCW.js\":\"03938aa3096686f1\",\"/knowledge-medium/pr-preview/pr-1864/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1864/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1864/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1864/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1864/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1864/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1864/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1864/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1864/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1864/src/App.js\":\"c86d9fa308511fcf\",\"/knowledge-medium/pr-preview/pr-1864/src/appUpdate.js\":\"cf13d0b4a3d792fc\",\"/knowledge-medium/pr-preview/pr-1864/src/appVersion.js\":\"32851a3b422a63e8\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/initialLayout.js\":\"ca43f3bd10c810bd\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/openWorkspaceData.js\":\"6533beb4408e6968\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/resolveWorkspace.js\":\"f6d12686985b7b23\",\"/knowledge-medium/pr-preview/pr-1864/src/bootstrap/workspaceBootstrap.js\":\"889dfb5f95acf61c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockComponent.js\":\"7e5686d85c268ceb\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockCrumbs.js\":\"079d8585ec091911\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockEditor.js\":\"34e5188e5626d191\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockLoadingPlaceholder.js\":\"ac7410ae733f777f\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockProperties.js\":\"7e5fface759e2dff\",\"/knowledge-medium/pr-preview/pr-1864/src/components/BlockSearchPicker.js\":\"0c1b0116e8fa2e67\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ConfirmBulkDeleteDialog.js\":\"95a4b82f300be9ab\",\"/knowledge-medium/pr-preview/pr-1864/src/components/DividerHandle.js\":\"d07429e7722f38c9\",\"/knowledge-medium/pr-preview/pr-1864/src/components/DraftEditor.js\":\"4b5f4543b0d90dc3\",\"/knowledge-medium/pr-preview/pr-1864/src/components/GutterPill.js\":\"35bfb6710fc00886\",\"/knowledge-medium/pr-preview/pr-1864/src/components/Header.js\":\"cb57e52e919b1b09\",\"/knowledge-medium/pr-preview/pr-1864/src/components/LazyBlockComponent.js\":\"8f503da1a2d3641d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/Login.js\":\"83073c3d61f72b99\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ZoomableSurface.js\":\"6b34d702ff77d774\",\"/knowledge-medium/pr-preview/pr-1864/src/components/editModeKeepalive.js\":\"65b64ad99e76e5ef\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b656c52a4dabe798\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2d1eaaee33661675\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/RefPropertyEditor.js\":\"bca4a658100d4add\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/RefTargetTypePicker.js\":\"b83c9e2be2dc5aba\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/SelectPropertyEditor.js\":\"3ec9e4667658fc7d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/TypesPropertyEditor.js\":\"b6897f9fe5d18873\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/defaults.js\":\"bcd7cdbf640eedb5\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/kernelValuePresets.js\":\"e8ee1ff51a064401\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/selectablePresets.js\":\"a5d7a7a3f3efb11e\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyEditors/typesPropertyUi.js\":\"b6339a0a39f660fe\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/AddPropertyForm.js\":\"26b54a98463dee97\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/PropertyPicker.js\":\"af75bc06fde8fdf7\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/PropertyRow.js\":\"233df0e5f3a37329\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/Rows.js\":\"9b919405a0406d1d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/actions.js\":\"b60c983babaab198\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/declarationOnly.js\":\"8584e1c08c544581\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/layout.js\":\"877de962e02d29f7\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/model.js\":\"fe8c8fa6709e6b06\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/shapeUi.js\":\"c3a621c3941e8b79\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/shapes.js\":\"61d9c7aace74c940\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/usePropertyEditingActivation.js\":\"82cd1f9924e8aa7b\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanel/visibility.js\":\"07bd987d20d26195\",\"/knowledge-medium/pr-preview/pr-1864/src/components/propertyPanelSections.js\":\"9bd1feef0f1d6650\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/BlockEmbed.js\":\"cbda49e4cd2bc5c6\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/BlockLink.js\":\"2baa9cb260f7f763\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/BlockRef.js\":\"98e29f424232987c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/ReferenceLink.js\":\"b62e9be7732e6f28\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/cycleGuard.js\":\"6a2bfda57a1ad75e\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/cycleGuardContext.js\":\"06e8af2ea87a830f\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/linkInteraction.js\":\"dc9b236df54d1e78\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/referenceLayout.js\":\"744776078ac57297\",\"/knowledge-medium/pr-preview/pr-1864/src/components/references/useBlockRefAncestors.js\":\"f9bb9bdcb521701d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BlockGutter.js\":\"204c3d8582631fd6\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BlockInfoDialog.js\":\"b796410cd546a37d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BlockTypeBlockRenderer.js\":\"ec993a6c43142c5c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/BulletHoverCard.js\":\"eea406b2b23415c5\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/CodeMirrorContentRenderer.js\":\"23682143dce40e09\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1a7da4992ca161b5\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/ColumnResizeHandles.js\":\"2f0d2715843503cb\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e264f3e470e62078\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/DefaultBlockRenderer.js\":\"570122a2a9c3bf14\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/LayoutRenderer.js\":\"038c93bbc2751452\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/MarkdownContentRenderer.js\":\"34bc631d9aa9ecb7\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/MissingDataRenderer.js\":\"2190ade8c2cf1c8e\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/PanelRenderer.js\":\"6a7874889e4667d6\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e1ba59adc91b6ccd\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/TopLevelRenderer.js\":\"6f21b1118935a14d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/blockGutterMode.js\":\"578ba20dff9f0a00\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/blockTitleText.js\":\"83533c361fd7d34f\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/fieldCreationKeydown.js\":\"980f254757fe628c\",\"/knowledge-medium/pr-preview/pr-1864/src/components/renderer/layoutRootContext.js\":\"5cdfb2ee16bddfdb\",\"/knowledge-medium/pr-preview/pr-1864/src/components/typeChip/TypeChip.js\":\"9b7e9a4895964a09\",\"/knowledge-medium/pr-preview/pr-1864/src/components/typeChip/chipStyle.js\":\"dffde336c939da78\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/anchored-floating.js\":\"902995350139a0c3\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/button.js\":\"2d1e7ddc4020b3cd\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/card.js\":\"a066fe349cca7658\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/checkbox.js\":\"77b854b845794e98\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/collapsible.js\":\"f6086997a4239489\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/command.js\":\"b61620e027885491\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/context-menu.js\":\"011f7bc90ac336e0\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/dialog.js\":\"bbf655fe2bee8aca\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/dropdown-menu.js\":\"0d9c70ba97a0e2d0\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/floating-listbox.js\":\"23a93be701613a7e\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/index.js\":\"8a4c25b4c191a108\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/input.js\":\"f5a577fab3ba846f\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/kbd.js\":\"45368eeaf0b61181\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/label.js\":\"df81ac08f80eb144\",\"/knowledge-medium/pr-preview/pr-1864/src/components/ui/textarea.js\":\"82ad0f9f684bfd23\",\"/knowledge-medium/pr-preview/pr-1864/src/components/useEditModeYieldKeepalive.js\":\"b87ee2abf4b4ddfd\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/BootFallback.js\":\"7a8a8654da947834\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/FocusedRowLazyMount.js\":\"5a49ce1afd6a9e7d\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/LazyViewportMount.js\":\"ba655f86d4578bdd\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/LocalDbCorruptionFallback.js\":\"7d276e0992f1821e\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/error.js\":\"ecc52ac7c192b4a8\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/lazyMountRegistry.js\":\"5ad7dfd4e4cb8ede\",\"/knowledge-medium/pr-preview/pr-1864/src/components/util/suspense.js\":\"0947979f7cce9400\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/CreateWorkspaceDialog.js\":\"2911b35c022951a2\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/PendingInvitations.js\":\"70c2a2099c46e634\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/SyncProgress.js\":\"849a359ffc76e352\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/UnlockProgress.js\":\"d4f8de12003371e8\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceKeyGate.js\":\"b330f41802d4b8a8\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceSettingsDialog.js\":\"77bc52318d4ab220\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceSwitcher.js\":\"26506283d2e392c1\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/WorkspaceSyncGate.js\":\"a6260e4c3281d45a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/ConversionFlow.js\":\"8734967c39a27129\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/ConversionFlowHost.js\":\"01402efdd9bf4c94\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/EncryptionSection.js\":\"b9f705003aeeb163\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/attachmentPrompts.js\":\"f624d84f7e39f21a\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a2b4b93312876780\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/conversionFlowDeps.js\":\"df4ac2d332e5a9e8\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/conversionFlowStore.js\":\"06d1ec736f0b6b26\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/flowUi.js\":\"0abd09d878a169af\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/conversion/useConversionRun.js\":\"19728afee2fe4172\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/keyUi.js\":\"bccb8ced42dc97f8\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/useCloseOnKeyLoss.js\":\"3d4038c40a6c0c30\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/useCloseOnServerE2ee.js\":\"189cb2beab0d29ed\",\"/knowledge-medium/pr-preview/pr-1864/src/components/workspace/workspaceUnlocked.js\":\"5ea40591ff6bbf35\",\"/knowledge-medium/pr-preview/pr-1864/src/context/backgroundSubtree.js\":\"a831834d922b52ec\",\"/knowledge-medium/pr-preview/pr-1864/src/context/block.js\":\"87a623319c23971e\",\"/knowledge-medium/pr-preview/pr-1864/src/context/layoutWsContext.js\":\"1e89eb423b0a0a7e\",\"/knowledge-medium/pr-preview/pr-1864/src/context/propertyDisplay.js\":\"4156006fc1caab48\",\"/knowledge-medium/pr-preview/pr-1864/src/context/repo.js\":\"b6a0929cb676f62a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/aliasClaim.js\":\"dcef60a74dfe4f21\",\"/knowledge-medium/pr-preview/pr-1864/src/data/aliasSeatNamespace.js\":\"db2ca32154509022\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/blockData.js\":\"1b0cf14aa298a464\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/blockType.js\":\"dc1dd345eaa1ace8\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/changeScope.js\":\"6e88f5ec8fab9e4a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/codecs.js\":\"c3fe73c6eb94e28d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/derivedData.js\":\"185d3f2ce3033782\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/errors.js\":\"8392592cbddd493a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/events.js\":\"8e3ca2ce34c85c1d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/handle.js\":\"605e64434a1a6c0c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/index.js\":\"c9cc669ae2c46ade\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/mutator.js\":\"0e3cb18007236dc0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/processor.js\":\"cbcd49bbe850b64f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/propertySchema.js\":\"950c52ce73b92050\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/query.js\":\"23e436053e09e601\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/sameTxProcessor.js\":\"2101987cf53996d5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/schema.js\":\"605e64434a1a6c0c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/tx.js\":\"605e64434a1a6c0c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/typedBlockQuery.js\":\"060fe5fea59c51b0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/user.js\":\"c32e2d53e789458f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/valuePresetCore.js\":\"48027c60b68ca178\",\"/knowledge-medium/pr-preview/pr-1864/src/data/api/valuePresets.js\":\"5dd0c04a199d7c4e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/attachmentCleanerIOVerb.js\":\"cf474f46e975acff\",\"/knowledge-medium/pr-preview/pr-1864/src/data/block.js\":\"f80917ff9bc2953e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockCache.js\":\"89b11e4873e35554\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockId.js\":\"b3d16c5558b67032\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockLiveness.js\":\"71fceeac6f9190b7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockMerge.js\":\"0077915c88fecc53\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockSchema.js\":\"9055e85d309aaccd\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockTypeLookup.js\":\"5ea1fdee26b66f46\",\"/knowledge-medium/pr-preview/pr-1864/src/data/blockTypes.js\":\"b00a9d7330148f3d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/childrenView.js\":\"8b832b456db9fde1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/clientContext.js\":\"ac466b07c475e1fe\",\"/knowledge-medium/pr-preview/pr-1864/src/data/dbFileSiblings.js\":\"70f3d1ca6db095eb\",\"/knowledge-medium/pr-preview/pr-1864/src/data/definitionSeeds.js\":\"b1c1e61dade729f8\",\"/knowledge-medium/pr-preview/pr-1864/src/data/derivedIds.js\":\"3d5c8c32684e60d8\",\"/knowledge-medium/pr-preview/pr-1864/src/data/drawnSubtree.js\":\"f90c8b5b97a826fe\",\"/knowledge-medium/pr-preview/pr-1864/src/data/facetBridge.js\":\"7704a399d07ba8fa\",\"/knowledge-medium/pr-preview/pr-1864/src/data/facets.js\":\"7960125b0a6d47ac\",\"/knowledge-medium/pr-preview/pr-1864/src/data/globalState.js\":\"f704fa2e85968a35\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/aliasClaimRederiveProcessor.js\":\"7559beda48228c3c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/ancestorBatch.js\":\"05d3e2aed3d0e5f8\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/blockTypeTypeifyProcessor.js\":\"95ac2989d48ec752\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/clientSchema.js\":\"1638e7afb6153313\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/commitPipeline.js\":\"4be921ce1517f54a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/devAssertions.js\":\"b5e2c18367c7b664\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/firstSync.js\":\"41fff6fdb6508cec\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/freshInitialLoad.js\":\"a76751b4a6cda9fe\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/graphBackfillClaim.js\":\"befb3521711fe457\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/handleStore.js\":\"bac18f4b24281e66\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/idleMarkerJobs.js\":\"89ad54c9e102ad6b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/initialDownload.js\":\"7d005b74088c5e8c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/initializeClientDatabase.js\":\"b9bd6ee1429144c5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/jsonCanonical.js\":\"366eea02e48ce28b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/kernelInvalidation.js\":\"68df1d7694d2083a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/kernelProcessors.js\":\"bff9851367e6040a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/kernelQueries.js\":\"14735f747989a324\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/mergeTypeMembershipProcessor.js\":\"ad82da733c38012b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/normalizeReferencesProcessor.js\":\"632e984f3a96b636\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/poolInstrumentation.js\":\"35187f07eaf6b78b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/processorRunner.js\":\"c29a7ae84a7a4203\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyCellBackfill.js\":\"11fc3579b099e429\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyChildMint.js\":\"e74b53f2b5083245\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyChildrenProcessor.js\":\"8ccaa6c8aba2c49f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a0e9e6d387502dc6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyDefinitionSynthesis.js\":\"7a6b0784b8f2d81c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyKeyScan.js\":\"75f0a7ae976e90f2\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertySchemaResolution.js\":\"4a57f9eac660e276\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/propertyValueEdits.js\":\"5c0e4a3f52db0f67\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/raiseProtocol.js\":\"e21f6c12e55f2546\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/readBatch.js\":\"f4c52415b95a091f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/refProjection.js\":\"e8d6123d8ce8b62a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/referenceTargetLookups.js\":\"6e928607421a60ae\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/referenceTargetProcessor.js\":\"892fdc1b68ec108c\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/replayMerge.js\":\"0a416b07f4292015\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/sqlBinds.js\":\"6b31e9367079d9a2\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0227b742a68b881f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/arrivalProcessors.js\":\"fd52654f96303125\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/invalidate.js\":\"e68296121c191aaf\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/materialize.js\":\"b101a536ed5b7978\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/observer.js\":\"1a9d490690f848f7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/syncObserver/reconcile.js\":\"6c2f033e82f616e8\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/timingMetrics.js\":\"6ec9a9d902ff97b4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/treeQueries.js\":\"e58d9c1fafab1766\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/txEngine.js\":\"2fcaa39452afbe80\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/txSnapshots.js\":\"00d5634486c835b9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/typedBlockQuery.js\":\"452ba9c3cad22949\",\"/knowledge-medium/pr-preview/pr-1864/src/data/internals/undoManager.js\":\"9b3c12fbe2b6dc39\",\"/knowledge-medium/pr-preview/pr-1864/src/data/invalidation.js\":\"519b73069fa3f15a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/kernelDataExtension.js\":\"5f7c462bc29227f9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/kernelPage.js\":\"114d397d430a53fe\",\"/knowledge-medium/pr-preview/pr-1864/src/data/kernelValuePresetCores.js\":\"b5fc707bb1ddbfd9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localDbCorruptionSignal.js\":\"25a73ab3488b97bd\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localDbStorage.js\":\"82e8caf3fb9ef341\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localDbVfs.js\":\"507e67841d2a876f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/localSchema.js\":\"35d2201300cf48d5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/maintenance.js\":\"d0c06fb30cc7e6c9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/mergeProperties.js\":\"d4b539bbac7e9ed3\",\"/knowledge-medium/pr-preview/pr-1864/src/data/metricsConsoleHook.js\":\"1440cf31da73f3d9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/migrationsPage.js\":\"ca09321ff5654027\",\"/knowledge-medium/pr-preview/pr-1864/src/data/mutators.js\":\"c3324d044f930983\",\"/knowledge-medium/pr-preview/pr-1864/src/data/orderKey.js\":\"9890b16a539309f6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/orderKeyPlacement.js\":\"a3139af1d5413927\",\"/knowledge-medium/pr-preview/pr-1864/src/data/outlineSurface.js\":\"d055398321e39969\",\"/knowledge-medium/pr-preview/pr-1864/src/data/pendingEditorContent.js\":\"5f1f029bb907ff12\",\"/knowledge-medium/pr-preview/pr-1864/src/data/pendingUploadsSql.js\":\"f3dbe348a99cdec6\",\"/knowledge-medium/pr-preview/pr-1864/src/data/pluginStateExtensions.js\":\"56e6efc2b064aabc\",\"/knowledge-medium/pr-preview/pr-1864/src/data/powerSyncLogger.js\":\"49ce9befde5a75a5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/projectorRuntime.js\":\"c1d7ad834e72dd94\",\"/knowledge-medium/pr-preview/pr-1864/src/data/properties.js\":\"03196656063fdfb1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertiesPage.js\":\"408b5afa58450f92\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyChildren.js\":\"bf82b0ca98861bb5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDefinitionFanout.js\":\"d60084c778cb6b44\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDefinitionMetadata.js\":\"00c9cae190246b01\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDefinitionRegistry.js\":\"f0ac2ea292be4138\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyDisplayMode.js\":\"7828f6ce2db1b517\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertyRowCreation.js\":\"4b4dcc0c238aa1c7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertySchemaCreation.js\":\"bed7f1001e6d719f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/propertySeeds.js\":\"6efa1dac5cba8ae1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/recentsPage.js\":\"157a072fbcd3af13\",\"/knowledge-medium/pr-preview/pr-1864/src/data/referenceBlock.js\":\"59cea11096526fa4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/rejectedUploads.js\":\"e7fd1373613d93b5\",\"/knowledge-medium/pr-preview/pr-1864/src/data/releasePowerSyncConnection.js\":\"d0808a564d1ff519\",\"/knowledge-medium/pr-preview/pr-1864/src/data/repo.js\":\"cb83991bef21796f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/repoProvider.js\":\"2d2e1fde95bf54d1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/rowProperty.js\":\"8c655575711c9501\",\"/knowledge-medium/pr-preview/pr-1864/src/data/searchFilter.js\":\"5ffe251d7ff14e94\",\"/knowledge-medium/pr-preview/pr-1864/src/data/seedIdentityLedger.js\":\"6115808673553380\",\"/knowledge-medium/pr-preview/pr-1864/src/data/stateBlocks.js\":\"97aea78256baa902\",\"/knowledge-medium/pr-preview/pr-1864/src/data/structuralEditPolicy.js\":\"9a71c51bee4f1a24\",\"/knowledge-medium/pr-preview/pr-1864/src/data/subtreeDelete.js\":\"06730b6c4f0366c0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/syncStreamLock.js\":\"1bcc7517638a7448\",\"/knowledge-medium/pr-preview/pr-1864/src/data/syncedTableSqlRecognizer.js\":\"8e99f9f9684e324a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/syncedTableWriteGuard.js\":\"8fe83f63c45d9dc4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/targets.js\":\"2c3bb34db6beaeb1\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeColors.js\":\"c222c4737fa358af\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeDefinitionMetadata.js\":\"c0787608a68797ea\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeDefinitionRegistry.js\":\"88ec6c344f3c0920\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeExtraction.js\":\"161b3dbb8c1e4c30\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeInitialValues.js\":\"171003528fd0e26e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typePropertyGroups.js\":\"83e2041e9a8ef944\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeSeeds.js\":\"1db25b3f6ab9f98a\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typeTagger.js\":\"9e28e5ef9002f7c4\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typedRecords.js\":\"42ed3572236dd8c9\",\"/knowledge-medium/pr-preview/pr-1864/src/data/typesPage.js\":\"6b6947e1c2a0ffe2\",\"/knowledge-medium/pr-preview/pr-1864/src/data/userPrefs.js\":\"45ec30ab65ae735e\",\"/knowledge-medium/pr-preview/pr-1864/src/data/userSchemasService.js\":\"9ff10be83cd22d89\",\"/knowledge-medium/pr-preview/pr-1864/src/data/userTypesService.js\":\"09302a7a6d835fdf\",\"/knowledge-medium/pr-preview/pr-1864/src/data/valuePresetRegistry.js\":\"735caa63a25b7f6f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/visibleChildren.js\":\"f4bc06aae2c75e37\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceConversion.js\":\"857299a492ad15b0\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceFirstSync.js\":\"d1e00a985a0ce74b\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceIdNamespace.js\":\"40f11232e2a2696d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaceSchema.js\":\"44656c2c26466d3f\",\"/knowledge-medium/pr-preview/pr-1864/src/data/workspaces.js\":\"26404324accc8f0d\",\"/knowledge-medium/pr-preview/pr-1864/src/data/writeAheadLog.js\":\"e2f4e55752666bf7\",\"/knowledge-medium/pr-preview/pr-1864/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/BlockPasteShellDecorator.js\":\"82479afb9c0313d3\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/atTrigger.js\":\"09035efcca9d7166\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/autocomplete.js\":\"367dfb78448a3393\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/codeMirrorExtensions.js\":\"bf73cc616d934fa4\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/contentFlush.js\":\"d71874bd30568f32\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/defaultInteractions.js\":\"40c6394aa42855e7\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/editSettleSignal.js\":\"5f70acf5ef9df39c\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/insertImage.js\":\"6d5534ff6f8e6fc0\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/referenceCompletionRange.js\":\"f681e8e3ca24522a\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/referenceTargetTypes.js\":\"0052cf6f21ff25e7\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/syntaxContext.js\":\"9bb03f5e7a265dfa\",\"/knowledge-medium/pr-preview/pr-1864/src/editor/triggerMatch.js\":\"db179c1051e8c64c\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/AppRuntimeProvider.js\":\"8bb3832b49fac246\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/BlockFocusShellDecorator.js\":\"9a37c9541824616b\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/ExtensionRenderBoundary.js\":\"6c84c3a76db476f1\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/PanelContentRecovery.js\":\"fc0577dc99beeb64\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/apiCatalog.js\":\"03000313114783b6\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/approveExtensionHere.js\":\"fb447a168ea627c5\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/armedCutAppMount.js\":\"43dc85af7bd11353\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/batchableKeyedStore.js\":\"039026929cc6d890\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/blockInteraction.js\":\"4a041a1cd7762baf\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/blockSelectionAction.js\":\"3cae643795f5dd98\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/compileExtensionModule.js\":\"559d7f0bc907c2ff\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/compiledModuleCache.js\":\"b56eec4f03b53854\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/continuousGestures.js\":\"5e27cce932ae9d81\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/core.js\":\"eec347a84553e975\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/defaultRenderers.js\":\"2779862e5a0cb290\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/definitionFanoutAppMount.js\":\"bc3caf032bd91541\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/dialogAppMount.js\":\"ea8f86714e1b8c71\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/dynamicExtensionSeeds.js\":\"3c5327941728a53e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/dynamicExtensions.js\":\"1a98ff12fe50c86a\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/exampleExtensions.js\":\"bfb7effe0d033146\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionApprovalStatus.js\":\"994833a7fe77e476\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionLoadErrorToast.js\":\"f00ce653c5930066\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionLoadErrors.js\":\"d7412407a24d9467\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionLookup.js\":\"9704ec6ae96e749e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionToggles.js\":\"5830ee5255876b6e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/extensionUtilitiesCss.js\":\"315374b67d8a2768\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/kernelPageDeletionGuard.js\":\"45e6c6e58812fa8f\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/liveRuntime.js\":\"5348dfc97eb9708e\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/openExtensionsSettings.js\":\"9bcf5c11e212d94f\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/overridesCache.js\":\"e18000f3e3b79e98\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/pluginIds.js\":\"344ca8ec4ab0942d\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/processorRejectionToast.js\":\"af97618d423aaa8c\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/runtimeActions.js\":\"690b9f32fb96a72b\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/runtimeContext.js\":\"5344191a284a8128\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/staticAppExtensions.js\":\"c70fbce029a19cda\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/staticDataExtensions.js\":\"ea1901bbf123d465\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/toastAppMount.js\":\"64a9ab690e9eada1\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/useOverrides.js\":\"116754bf5269b407\",\"/knowledge-medium/pr-preview/pr-1864/src/extensions/useShortcutSurfaceActivations.js\":\"cca529bd498358bc\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/discoverToggleTree.js\":\"8e021a6cc882b1a1\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/facet.js\":\"bd9313ab8e0b6ba1\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/resolveAppRuntime.js\":\"27ae5261ce8f03fc\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/runtimeEvents.js\":\"85c0ece35d990824\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/togglable.js\":\"6d7c877d44c8fda8\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/variantFacet.js\":\"a609da418580d889\",\"/knowledge-medium/pr-preview/pr-1864/src/facets/verbFacet.js\":\"f15222151e66055c\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/block.js\":\"e42d55fb2765b1ec\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/focusedChild.js\":\"7c6154f3e34ca823\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/propertySchemas.js\":\"6536ace43ceb46ab\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/typeRegistry.js\":\"555a91d125dcacef\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useAncestorCrumbs.js\":\"3af26886734ee244\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useAutocompleteListbox.js\":\"400063b361ba6eaf\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useDebouncedSearch.js\":\"06cba9b562061ced\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useDebouncedValue.js\":\"8ff06116280d10f0\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useIsFocalRender.js\":\"b53d343004259ddc\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useIsReadOnly.js\":\"aa012ef825ce8b01\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useMaterializeBacklog.js\":\"77b784f913ea9da7\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useMinuteClock.js\":\"d9135df682d8cfbd\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/usePanelLayoutProjection.js\":\"20d06da1659e7f0f\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/usePendingInvitations.js\":\"f6519eb5fea70f1d\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useRendererRegistry.js\":\"2b1e9f83b7072997\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useRetainedFieldRows.js\":\"f011d08d56624ffe\",\"/knowledge-medium/pr-preview/pr-1864/src/hooks/useWorkspaces.js\":\"5c8fbca544a06045\",\"/knowledge-medium/pr-preview/pr-1864/src/lib/utils.js\":\"b27c160bc7b477b7\",\"/knowledge-medium/pr-preview/pr-1864/src/main.js\":\"403b66299391248f\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/MarkdownImage.js\":\"4f43a64d6caf424f\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/blockSeparators.js\":\"09bfadac057536d8\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/context.js\":\"ce5b6604b4ebed29\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/defaultMarkdownExtension.js\":\"c9933c294b4b925e\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/extensions.js\":\"fc384df7521820dd\",\"/knowledge-medium/pr-preview/pr-1864/src/markdown/renderMarkdownHtml.js\":\"bf4c64a6343ffb84\",\"/knowledge-medium/pr-preview/pr-1864/src/minimal-editor.js\":\"f2134c41e9022687\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/armedCut.js\":\"5d7f98274350c89b\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/captureMediaVerb.js\":\"db628c3b8b563dde\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/clipboard.js\":\"973002b2684e0a44\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/decision.js\":\"63a81652b2f53be1\",\"/knowledge-medium/pr-preview/pr-1864/src/paste/operations.js\":\"b1cf6c1e1ea21674\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/account-header/AccountHeaderItem.js\":\"0467ab08a043dd3e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/account-header/index.js\":\"d768383566253df2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ba9a01f17931aa0e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/askAgent.js\":\"107b092d83cee422\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/askedStore.js\":\"500249aa43079d38\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"57663e4e558de072\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/chipState.js\":\"8a5a4d18b1551a63\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/dataExtension.js\":\"98b16759da62f6b8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/index.js\":\"aa9a9ec61c2d2fd0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9e739b6551767a3e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-dispatch-companion/schema.js\":\"1b8db95f3d191ddf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b4aed8ac4c27c7c5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2ae02e215429846c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/addMedia.js\":\"b8f956e39f8ce0d0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/backlinks.js\":\"83e2eb78019fe8b2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/block.js\":\"24f58c2ff3c6f8fe\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/context.js\":\"ea8163a033e6d51d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7f153b35d8ba3a04\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/index.js\":\"7d7cd3437cc9f4d7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/outline.js\":\"178a1a1f5cbf2612\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/properties.js\":\"de02c8de6f6dcea0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/refs.js\":\"114a8029a55723c1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cc1e24aa46738984\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/search.js\":\"776ae616ba7d131f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/shared.js\":\"2eeb397ae853f5a7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"627b025136238c99\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentViews/text.js\":\"915c010d6d0248fb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/agentWrites.js\":\"47462457ba0ac653\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/authoringCatalog.js\":\"f073703788fd2a9d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/blockRefTargets.js\":\"97c784fe9fc9b081\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/bridge.js\":\"68b2553ad592286e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/bridgeLoop.js\":\"9d2afb9e7aa4da0d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/changeHistory.js\":\"5be5f95e31180c8d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/commands.js\":\"6bfc4780b87e2fe1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/commentsCommands.js\":\"88ff2bada88a5875\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/dataExtension.js\":\"9af7da446f8514c4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/dataModelGuide.js\":\"f0836ecca018e6d9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/describeRuntime.js\":\"4d7694bf4c18e88a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/extensionLint.js\":\"7806e2581498d4c3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/grainAudit.js\":\"f79414fa268ba5c0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/healthCommand.js\":\"a10f1c2ec73fb2cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/index.js\":\"76fb8ef799e5ddbf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/presetIdentity.js\":\"cb936ae52bce624f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1d096f77119764df\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/readMedia.js\":\"2e890cda54c5a25b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/schema.js\":\"bdde2f6e20e4ebee\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/serialization.js\":\"4234bd66db0a6ad9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/targets.js\":\"9bbcb57767144ce1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/tokens.js\":\"9f240994d97ffdb8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/watchEvents.js\":\"2784b3493023bc66\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/workspaceGuard.js\":\"96175fffae05f6c2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/agent-runtime/writeCommands.js\":\"e3cddb1a65bd5660\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/AliasCollisionToast.js\":\"990087055213ae59\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/DuplicateNameBanner.js\":\"8e56398b86e65268\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/collisionMerge.js\":\"d781962985932cba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/dataExtension.js\":\"1d607e0302d35c7c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/index.js\":\"cf89adc9fc4c8d1d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/mergeCollisionAction.js\":\"4480201031050d81\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/pageStyling.js\":\"98c775cca3ce7b77\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/rejectionToast.js\":\"a764d6910e902c81\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/alias/syncProcessor.js\":\"be84952a2802544b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/actions.js\":\"4d783485ede7e98c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/addComment.js\":\"a5de0270fa8855f0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/anchor.js\":\"ef9f28ca6c588f5a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/anchorState.js\":\"d5e8361c742442d5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/commentLinks.js\":\"986542a84e3ba6f5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/confirmThreadDeletion.js\":\"1a662fd3e81e85c2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/container.js\":\"dc2a4608cb0529f9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/dataExtension.js\":\"e6cab92fc4723b2d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/deleteComment.js\":\"1ed4a0c47970c7b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/highlights.js\":\"e301540ea1e2b7f8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/index.js\":\"82f56875207d4e22\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/linkedCommentsPill.js\":\"906e16e70151190f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/margin.js\":\"734d5ffd1ff6f1f0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/marginSchema.js\":\"726ed77e3e0bbf39\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/newComment.js\":\"e3e7284b187125bb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/ownThreadPicker.js\":\"f28a54958fdfccd6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/placement.js\":\"98743941843ee3e1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/queries.js\":\"5ecf933e2648b479\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/quotePosition.js\":\"bbb59e5b9d7b5db0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/quotedIn.js\":\"e64412912406d18d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/quotedRange.js\":\"5a6491e3043afb23\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/rangeRefs.js\":\"c62227d572619824\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/readHighlights.js\":\"8f9e190b126a07ae\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/readSelection.js\":\"22b11bffbdfc77d9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/readSelectionUi.js\":\"8cbc53feec6cbef3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/reanchor.js\":\"d4526c39f30100af\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/schema.js\":\"4381cf821fba103c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/scope.js\":\"5696b993fc6146a5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/scopeThreads.js\":\"88731d100ec068dd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/splitRetarget.js\":\"69e8ad70af6f5909\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/suggestionCard.js\":\"36436badb4ef67f0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/suggestions.js\":\"572c292166541d8a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/summaries.js\":\"e8f5677bdc8df4a6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/summaryBatch.js\":\"b5a3613a7c38b246\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/surface.js\":\"acb7f1d94a2b5f3f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/threadNavigation.js\":\"fe20859132a60c68\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/threads.js\":\"fe4f0be1b8ce0385\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/ui.js\":\"ecd00b1b07a38db8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/annotations/uiStore.js\":\"8383926fe3db53db\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-intents/appIntents.js\":\"254502f40ca3465f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-intents/index.js\":\"f84e9b326d020104\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-update-prompt/index.js\":\"12c90122f22088f1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/app-update-prompt/status.js\":\"ba408938b4c09fdb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"69ba58fd7e041e2b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/MediaBlockRenderer.js\":\"6cca90ef3b9a6e97\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b5c67d51307c73eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/MediaUploadReconciler.js\":\"a788d2a78fa3330c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/assetDownLane.js\":\"0b23e8d6baad96ed\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/assetResolver.js\":\"46229c83c29df728\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/assetUpload.js\":\"27d8c77d2c3dcdf7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/attachmentCleanerIO.js\":\"982f0d7397083e76\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/supabaseAuditIO.js\":\"92c5317bbf4af5a3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/blobStore.js\":\"68c393604f352805\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/browserMedia.js\":\"b6a84ea7a12514d9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/byteStore.js\":\"63262bb0aaad3885\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/cleanerIO.js\":\"47216103b292cf02\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/cleanupAttachments.js\":\"bf93dc5cee7ca2c8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/dataExtension.js\":\"599c6f1a1dd654f7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/downLane.js\":\"28b9a904bc705fd9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/index.js\":\"b21a8fa686b87357\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/insertImageContribution.js\":\"7360d124f5e17be2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/laneArming.js\":\"163a78465022e36d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/laneLock.js\":\"2d922b2b437870fb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaBlock.js\":\"68b51c475cebd61b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaCapture.js\":\"0f5075664a04f265\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaLanes.js\":\"3c54abca811a8621\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaViewers.js\":\"f7768ec54e6da2c1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/mediaViewersFacet.js\":\"e1dea89266f8edd3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/pasteCapture.js\":\"d2ce7a3ae8e0d691\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/resolver.js\":\"d93fbb04af016c26\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/retryUploadsAction.js\":\"b2f9d3d545b12b01\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/storagePaths.js\":\"37e59c2c17f68de8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadDrain.js\":\"58cc2fc84f6ca817\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadLaneStatus.js\":\"426d6dcd49f783a4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadReconcile.js\":\"931b1754e8b91b2b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadRecovery.js\":\"d27c26ee7862beea\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/uploadStore.js\":\"81b3f81250bdff72\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/attachments/useAssetObjectUrl.js\":\"95d996954cb19401\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4218fe2b8aa3c503\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ae858d6b81cdb019\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/facet.js\":\"a259a252b352d15c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/index.js\":\"588547e660c848f5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks-view/prop.js\":\"ae09521d56937885\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/BacklinkFilters.js\":\"58bb27a94bc8bc45\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"54b476c455fb944c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/BlockEntry.js\":\"90630edf614240d0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/LinkedReferences.js\":\"e9ebfdf8bdffe150\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d23b480484d989a4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/dailyNoteDefaults.js\":\"47fdfe56a9645651\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/dataExtension.js\":\"d2c06e4283a95848\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/edgeExclusions.js\":\"104fd4bdc05a7111\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/filterProperty.js\":\"d5e314d3c2a03584\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/index.js\":\"e5a82ac4769e2bde\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1b2d1069c9270408\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/applies.js\":\"81d22e6c75d632d9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/countQuery.js\":\"367832a2d6e9ecb8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/expansionStore.js\":\"621ed4e71d4ff063\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/index.js\":\"dbb81b3a35b9ed02\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f69128d22e0194f1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/presentationInvalidation.js\":\"c5293128b6f6a3bf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/propertyEditorOverride.js\":\"3ee0f58ae7af0cad\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/propertyFilter.js\":\"28507669e2eb72bb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/query.js\":\"cbfee3d8cec66b5c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/resolveFilter.js\":\"ab43ff75b10206c9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/sourceBatch.js\":\"0b6c09e5293e46d5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/sources.js\":\"660dee9ecbb8327c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/useBacklinks.js\":\"ee7ecb9d84bda856\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e0a10714f0ef434a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/BirthdayCelebration.js\":\"3735c2859ac1b108\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/BirthdayOverlay.js\":\"9f114a394afe71a9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/gate.js\":\"22495f0fe7e91c86\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/index.js\":\"4f9107e5c810ae57\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/birthday/wolfTheme.js\":\"babedc2462575ca2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/BlockDragLayer.js\":\"b29d216d3237775a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/dragController.js\":\"fb317f720657525a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/dropTarget.js\":\"b065149e14f59413\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/index.js\":\"b5763a9c23f124c6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-drag/projection.js\":\"cae76d7c78910481\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-info/BlockMetaCard.js\":\"4bee9300e846fd23\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-info/index.js\":\"d3e2525d00aaa1fa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/AddTagDialog.js\":\"2d0871d64a031f07\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f8ebb5f84779327f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/TagNameIssueHint.js\":\"a330ea08fee7d583\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/addTagAction.js\":\"441b94c4128f544f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/appendTag.js\":\"e7dc98ab51f945aa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/config.js\":\"f107c8d3d1577328\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/dataExtension.js\":\"15fec82673251adc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/index.js\":\"763647b0afa84dfe\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/block-tagging/propertyEditorOverride.js\":\"37f653422f0400ef\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a1c1ce83b0b3057e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1784cba003ab5b5f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1ac8e1653323b6bf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"498c3f1fc08f7fbb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7a33620f6d80d67a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/index.js\":\"c6dad4e766a7eb51\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c6278ee4384b7343\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/CharacterCountItem.js\":\"9025882b453d98ab\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0394f769fe9f2eaa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/actions.js\":\"b996ce5486bbd71e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/blockType.js\":\"52d8912c29a88b0f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/charCount.js\":\"370ddd938bb2e995\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/dataExtension.js\":\"ce105410b72014fe\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/index.js\":\"2b377cdb882af3f4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/profiles.js\":\"d313d4abab7e2dfe\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/properties.js\":\"afe9ebf482e887a8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/character-counter/textCounts.js\":\"4c98e4accf9aa8f1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/colemak-keybindings/index.js\":\"bfe82b9430ff7050\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/CommandPalette.js\":\"81816fe608b15033\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/HeaderItem.js\":\"01028e85e9af5a90\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/context.js\":\"65ead1551318e653\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/index.js\":\"cb6e6c45f4c5f5c0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/selection.js\":\"34b3ff0b6b6efd01\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/toggleStore.js\":\"0034ca6cea2a16d8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/command-palette/useCommandPaletteActions.js\":\"5ab2fbad1b9610ac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/ContributorBadges.js\":\"ace3fc49814c48f4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/author.js\":\"a820455323f55379\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/codeMirrorExtensions.js\":\"f6026dcc790dcc94\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/dataExtension.js\":\"c588de547293349f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/index.js\":\"5ec9a26c53718822\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/mentionAutocomplete.js\":\"09c553f1df5d5dde\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/processor.js\":\"21bf1b0ee904ae3a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/profiles.js\":\"4dde5b023978be93\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/queries.js\":\"53ee9c9f6858e6cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/contributors/schema.js\":\"57cb5dd7eec9e3c7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e78b2d5aa163548b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f7c937244ef54cc5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/index.js\":\"41de766e5ba1035b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ec2c50bead637cff\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"454a5f7574e099b4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/CalendarGrid.js\":\"ad9039fc1c607037\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DailyNotePicker.js\":\"659bf5b5deecefbb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2e1707128903f307\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DateNavDecorator.js\":\"cf77cd6b6c98a507\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/DateScrubOverlay.js\":\"ab223e177d661bc9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/HeaderItem.js\":\"3ab4a3afb495ace3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/ReschedulePicker.js\":\"23607e25d8ff1da2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/SpreadDatesDialog.js\":\"039cf2574a69a38a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/actions.js\":\"f43d9a1a807562c1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/blockDateAdapter.js\":\"8552de23304f602b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/calendar.js\":\"b00907f354201ea6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dailyNotes.js\":\"46492902927fbeea\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dataExtension.js\":\"3ddcc4e692ce5eb8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubActions.js\":\"9b7f5891bbe0b31f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubGesture.js\":\"64f4b0f2b2236062\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e8daddce5494a9cb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ea995ea71f7f7a84\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/deletionGuard.js\":\"35031ac8a4056f4f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/dueQuery.js\":\"96ffa3bf8f68169f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/index.js\":\"164cf302ad16c3aa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/landing.js\":\"d7844d01b0899415\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/localSchema.js\":\"86a9949b028cd015\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/referenceDateAdapter.js\":\"67018f0aed83ce7d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/rescheduleAction.js\":\"656e695803019cda\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/schema.js\":\"78e9f27e97c6fa75\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/spreadBlockDates.js\":\"94b90ca26a81c51b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/spreadDatesAction.js\":\"261bbbabc2eac38e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/today.js\":\"db94da8d7e8b5d4b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3aa7d42c71418b3f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"872c7015c63c6443\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/audit.js\":\"633b703d6be6a640\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/auditAction.js\":\"f65b7ad28578ee60\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/auditRanges.js\":\"ae8faeb206eaa929\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/diagnosticsSource.js\":\"3a6e3311e5f5b13d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/divergenceScan.js\":\"7a9e63ed6f3c2f1c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/index.js\":\"a33ba3f802596543\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6fba6943c86b56b3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/referencesMirror.js\":\"3f8bde94fb0b7c09\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/rowJson.js\":\"61cdbeb8c9c0daf2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/schedule.js\":\"58cfbe50dad0812a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/data-integrity/store.js\":\"6662fc92f65ea107\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-maintenance/action.js\":\"9765b12f4bb62492\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-maintenance/index.js\":\"9016f4579a7a08b2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-maintenance/plugin.js\":\"39b9b61f29c414dd\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4f659317fc8e6029\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/actions.js\":\"0a21703150e01d56\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/changeMarker.js\":\"83bea75554118bee\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/diagnostics.js\":\"36ac0631d39d17c6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/fileSystemAccess.js\":\"22a50d61b7e29630\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/filenames.js\":\"0558b71123aa7b5b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/index.js\":\"f255022eab10407f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/mirror.js\":\"5080a4ffa1c7453d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/runLock.js\":\"de767e28dc01f6e0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/runtimeHealth.js\":\"15fb13d30f03ddff\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/schedule.js\":\"a8e0020c36a4dd27\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/db-mirror/store.js\":\"72bbe54d1d4b578b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/default-themes/index.js\":\"e3292fa27d88b42f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/default-themes/themes.js\":\"176a4ee6647636e2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/diagnostics/facet.js\":\"6907ddf893545843\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/diagnostics/useDiagnostics.js\":\"174879b8a8f8f9a0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/dismissals.js\":\"ad672040ce826a33\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/index.js\":\"b0349bf9ca70e636\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/status.js\":\"f18f4d6e840b9eb6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extension-prompts/store.js\":\"2a17a9d3d300c736\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0562cc168e9fb7da\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/ExtensionsSettings.js\":\"690a33163f3b143f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/actions.js\":\"bf9a64204ec571f8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/config.js\":\"1bffe654ea351c89\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/dataExtension.js\":\"27d2da41a14b82e8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/effect.js\":\"bbf283a6908941a6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/index.js\":\"1364d260f394f743\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5797e19c3e85edf1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extensions-settings/useToggleTree.js\":\"ff0aa295086f5436\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/ExtractTypeDialog.js\":\"514353970f617796\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f2f35768fca4c953\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/PropertyShapePicker.js\":\"cc6895c424a16675\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/action.js\":\"0b6e78f43b13e66a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/extract-type/index.js\":\"b20ddcc1021d6b2f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/FindReplaceDialog.js\":\"d6c6113aa5f64b45\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/HeaderItem.js\":\"579d74e82fbba384\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/dataExtension.js\":\"6de0e8adc9b002c5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/index.js\":\"ba8f81c00ae50366\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/search.js\":\"7c831fdfb217c3eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/toggleStore.js\":\"c1d92024c6b64eb9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/LocationPropertyEditor.js\":\"0f11a8d2cf748aa9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/MapView.js\":\"a04b184beea64f4e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/blockTypes.js\":\"c61bff2fa62def28\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/codeMirrorExtensions.js\":\"ac36d4b46c9be131\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/createOrFindPlace.js\":\"07bc08a8b7a39452\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/currentLocation.js\":\"ad31f0c4d3ca1f5b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/dataExtension.js\":\"32a10bd95e7d290b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/geoContentDecorator.js\":\"9f9dd574f663a50a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/googlePlacesClient.js\":\"04898ef327606561\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/index.js\":\"2d4860c4da073be8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/locationsPage.js\":\"29a8d8544832fc73\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/mapViewport.js\":\"0cd0ad8915f2f0ce\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/pickCurrentLocation.js\":\"4b39940c31be3faa\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/placeAutocomplete.js\":\"511d59efbacceb91\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/placeNameCollision.js\":\"3e0d23d8ba4c99c4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/properties.js\":\"6ad721cb558cf065\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/propertyEditorOverrides.js\":\"b15aaf05582647f3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/query.js\":\"756e9683df3f76f0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/geo/usePlaceSearch.js\":\"215969df9d18354f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"70dd31c3f18441f1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b347738654660867\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c71db209a99ecc76\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/config.js\":\"4c909ad4f7611b03\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/dataExtension.js\":\"ce4fe82b1544be8a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/facet.js\":\"52d8ee132e84511b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/grouping.js\":\"5ed98b17bbfc6777\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/index.js\":\"82a61aa5cfdbb346\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2441618b6af301ac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/query.js\":\"09839fae02c065c5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/resolveConfig.js\":\"5b23e8a775038f92\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"242f6ed01179af33\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"02f62c8c8f0a05df\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/HtmlDocumentContent.js\":\"91101650db94468e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/HtmlFrame.js\":\"f78a13d941aea9c5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/actions.js\":\"d6a1a83bcba3c0f3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/blockType.js\":\"21f5ca41d61e97a6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/confirmRunScripts.js\":\"b9bdc481e45547f6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/dataExtension.js\":\"923023303689463f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/frameAnnotations.js\":\"1d77639555fb5d6c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/frameDocument.js\":\"01833f68137b86f3\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/frameTheme.js\":\"42c39e3e6dd69a36\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/index.js\":\"7d8db15b4d7c0a55\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/scriptConsent.js\":\"9ac92945fff069a4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/sourceMap.js\":\"79ca0fb75ff8fff9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/html-document/useDocumentScripts.js\":\"435a9ccb0e809a8b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/index.js\":\"3b8474bab19fe087\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/record.js\":\"181a779bcc9779d6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/recordStore.js\":\"acaee96641036af8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/responsiveness.js\":\"59f07d68bbf67711\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/schedule.js\":\"63b8aa841ceae0b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/interaction-metrics/sessionContext.js\":\"5b147ce9ad734feb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ea2334bc4a900c70\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6e1954e3690811b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/actions.js\":\"01604720c09da1ea\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/config.js\":\"7ffeeb97e5345ecf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/dataExtension.js\":\"2289b030eabffd93\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/effect.js\":\"a62bd6ef07e6a25d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/index.js\":\"c083c65d3420b8ae\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/keyCapture.js\":\"6b9c367a070b80f5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/overrideStore.js\":\"a53009d36c9a90a7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ae6066769675957a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/HeaderItem.js\":\"ca611abbe58387c6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/LeftSidebar.js\":\"c2da4b09907eae96\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/actions.js\":\"1210fbf3a9d56918\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/facet.js\":\"ad4d9523828d73a8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/index.js\":\"2c971f6324c32bde\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/shortcuts.js\":\"638f77608141926c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/left-sidebar/toggleStore.js\":\"5239a31eb6c1ea4d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/MergePicker.js\":\"d6ad0a0e66d33961\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/index.js\":\"999dea131f4eb5e4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/mergeAction.js\":\"b6bde7f151b82e44\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/merge-blocks/strategy.js\":\"b2ee03f32e3e089e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/Button.js\":\"785d64d409781a70\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"088513ee3ee95437\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ecbb6e83e327321f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/facet.js\":\"ad166dab44fe16b0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-bottom-nav/index.js\":\"8ef888cbf182443a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"57503a8701859ef8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/actions.js\":\"536c7539ee8ce1eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c2635267a120ab4e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ee31e8d61eb86488\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/mobile-keyboard-toolbar/index.js\":\"b793551bf8a677a1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c0ea131fac064f58\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d8f1c5ea2cfd2c49\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/contextMenuItem.js\":\"0e31dea85855a940\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/index.js\":\"3d465a866b3dabe2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/moveAction.js\":\"5fd67f23aacdc26a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/moveBlocks.js\":\"0dd9a5b43a548dae\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/move-blocks/selectionAfterMove.js\":\"8879603386eb9fef\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/TutorialBanner.js\":\"5c7ee2f1d0f5d03d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/action.js\":\"67afc5b9ad7509b5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/bannerDismissal.js\":\"4d6cb4310e85a344\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/documents/cheatSheet.js\":\"ecfae10faca3a4eb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/index.js\":\"1d81b3a3e21dff73\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/keys.js\":\"431f82549639bcde\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/landing.js\":\"d345d12ffbb2c89c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/outline.js\":\"9ec73211617f0028\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/onboarding/seed.js\":\"36474802944b73bc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3fb39bd80e8e896b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/analyze.js\":\"03c269c315ba6e16\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/diagnosticsSource.js\":\"e76beac045fb57f2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/index.js\":\"4330b2c0ff6ada5c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/load.js\":\"e835126e6928d007\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/monitorRun.js\":\"801a30c4a56fb072\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/schedule.js\":\"0029bf0d73312ad2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/series.js\":\"07d55a8d814bbb69\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/store.js\":\"f2dd7a9f3ebab296\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/trendAction.js\":\"411b052c36700460\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/perf-monitor/verdict.js\":\"6b3d767082dfd106\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/plain-outliner/clickToEditAction.js\":\"871588c38c1a1e23\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/plain-outliner/index.js\":\"df0cd20b2ec8094c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/plain-outliner/interactions.js\":\"e0aa23146ce7b91c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"eb465a9b1a8cf2be\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/MigrationGate.js\":\"f7d15a3b8972d8ca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/MigrationGateDialog.js\":\"038fa6765666b577\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/action.js\":\"4ed4a678a6ce8a3a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/index.js\":\"e3e04198879ad38b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/localRunMessage.js\":\"ef074487394248b4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/plugin.js\":\"65c65048799cceb1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/progressReport.js\":\"90630af1f3b50452\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/properties-migration/sweepProgress.js\":\"2ca003e6e2603845\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/FieldRowRenderer.js\":\"fe4092340c73d410\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/ValueRowRenderer.js\":\"2fd549bb6e327b7c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/actions.js\":\"cf5b2cfc9c2651cf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/autocomplete.js\":\"186420de69558145\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/fieldRow.js\":\"9c4163b13a1573da\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/index.js\":\"3f3e7755f1c91ea8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/referenceWarning.js\":\"250135423bc78426\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/valueAutocomplete.js\":\"69af86b5d6b0583b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/property-rows/valueSchema.js\":\"84704507103a87b1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/HeaderItem.js\":\"d81ace8036bf60d1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/QuickFind.js\":\"4c2087f276eb5f7b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/index.js\":\"0d96bd0c0cd51835\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/recents.js\":\"b1ed76ae4aecd87a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/resultItems.js\":\"daeb70272334f95f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/selection.js\":\"2ab0d7f76cec4042\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/quick-find/toggleStore.js\":\"47def930c80b3870\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/HeaderItem.js\":\"c1cd445768bdc30a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5cced6564294ce95\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/grouping.js\":\"8b4f67a1aba72691\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/index.js\":\"42ca99673da6d150\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/recents/target.js\":\"feb17763b6c9c7e0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/codeMirrorExtensions.js\":\"123cc5206659ad07\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/contentPrefill.js\":\"a219bd218e2e3fcf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/dataExtension.js\":\"bb834bed7450f7f9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/index.js\":\"0135228d93423631\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"71c9ffc9a8699ac0\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/invalidation.js\":\"f8f93632bef36490\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/localSchema.js\":\"69822711b8a08643\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/blockrefs/index.js\":\"d34c7ea7efd465b6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c66d2039db867663\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/index.js\":\"b3d0bb8b2ce8f60d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/referenceNode.js\":\"4d369383601624c2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/remark-reference-occurrences.js\":\"57c5c39ac544401b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"bade0b107b7f078d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/index.js\":\"ec01faffb2c016fb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"18df1880ae8ed296\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2d3493fac3a51429\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/mergeRetargetProcessor.js\":\"cd991dc6c3d2c1a1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/parseFence.js\":\"874d503e34773ab2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/referenceParser.js\":\"1cdc5f2f84309cd1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/referenceProjection.js\":\"e55457134788ca50\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/referencesProcessor.js\":\"6c88471560adc73a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/renameProcessor.js\":\"425da95df21dc28d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/references/spanReplacement.js\":\"7de1563fd1f38633\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/htmlToOutline.js\":\"4290648d70a57ed9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/index.js\":\"d3a49e1938979e0a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e509bd86c6786b28\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/rich-paste/pasteDecision.js\":\"a75e48055c25b303\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/action.js\":\"c9f74912ab2a1f44\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/blockIds.js\":\"db79ab2e7a903bd9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/content.js\":\"4670845af33c5327\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/effect.js\":\"fd9543db104fbf9a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/ids.js\":\"9c347ae87f0990f4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/import.js\":\"854065ad8bda264b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/index.js\":\"e17f0476e83f924c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/plan.js\":\"a549cf148c64ea7e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/plugin.js\":\"aae9be3f3c579eed\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/promotion.js\":\"160968a6a5270cac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/properties.js\":\"36bd3b11da83c9ac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/references.js\":\"910d643840f11a9f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/report.js\":\"3ce1a83f59572e71\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/roamMemo.js\":\"e722b5e77b82f15f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/runtime.js\":\"db2dfa1ba5a5cddf\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/schemaReconciliation.js\":\"664c044a21fa5c6d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/srsMarkers.js\":\"c0bcbe1f6c938e3d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/todo.js\":\"6926b19b7d7f551b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/typeCandidates.js\":\"38a87442c2e1e46d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/roam-import/types.js\":\"c096b17d4ade7fed\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/search-health/index.js\":\"2646f8e48698254f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/search-health/store.js\":\"502a17f54dcaedac\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/HeaderItem.js\":\"5bc509f933a33ffb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2bd89203526a17ba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/index.js\":\"855ade53453b5f4d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/model.js\":\"e3034e22c2e19837\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/toggleStore.js\":\"b04c2cf6f1067f5e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/shortcut-help/useKeyInspector.js\":\"45b025cbfd6c7024\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cd91382cd444b548\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/ShellDecorator.js\":\"f6f0b67d44870c40\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/actions.js\":\"8482017b95f01da1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e93381e6df4bef19\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/index.js\":\"0109761260eee154\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/shell.js\":\"87203b8fb6769f1a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/surface.js\":\"6c9c9d782ec6a038\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/spatial-navigation/walker.js\":\"1dbe7c37df47fcd4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e4f3e0dd4e00f24e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/dataExtension.js\":\"a66889111c7c0c6c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/index.js\":\"e09cf1575b7fbc74\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/indicator.js\":\"90da5d8790234e55\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/moveSrsState.js\":\"b2617d6e1fe65f18\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f60f19943937863b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/scheduler.js\":\"e76b729bd5f3b183\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/schema.js\":\"b635953d139a9098\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"dd27c1ed078a92d8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/srsClipboard.js\":\"4384938e6e8ff634\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5b6df6da37be5950\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d851fe0576e2e73e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/DeckPicker.js\":\"e995ee5084949915\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/ReviewControls.js\":\"bf73e656626eff57\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/ReviewDeckRenderer.js\":\"07b11d720eac48a5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/ReviewSession.js\":\"e5d98705e1d8fc97\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/actions.js\":\"1154f9d3047c125e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/archive.js\":\"359ce9ef22ea4033\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/dataExtension.js\":\"a2124a0c0c45909f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/deck.js\":\"2287f518462973de\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/dueQuery.js\":\"af9a4e9b83de1585\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/gradeDecision.js\":\"f60db85548c0abba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/index.js\":\"6840e587fb0e8ef2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/keyHints.js\":\"c40b3a85808558e9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/reviewCardLayout.js\":\"a303e06d817f0779\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/reviewProgress.js\":\"66057b4b3a09d13f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/schema.js\":\"95465e17d0fc4f1d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/srs-review/useDueCards.js\":\"10fe63d6c6189794\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/startup-metrics/index.js\":\"86a728a751ec2688\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/startup-metrics/record.js\":\"0065fa67839a5b45\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/storage-persistence/index.js\":\"55941d20536c0825\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/storage-persistence/persistenceStatus.js\":\"dd8ea2590fb289e5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/storage-persistence/requestAction.js\":\"c8550bf6c4a177d5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/TypeChipsDecorator.js\":\"3a5bc8161030a6e5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/codeMirrorExtensions.js\":\"911a6cbf81930d4e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/index.js\":\"cdbaffded9295e2b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/supertags/typeAutocomplete.js\":\"bc71491b2c9fbc0f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5863a5e15c195a7c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/actions.js\":\"c236da6a2197053a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/anchor.js\":\"e94035827c6def57\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/events.js\":\"c47439808f1a6433\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/gestureActions.js\":\"b2f473c36d528f74\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/index.js\":\"2a1de39445500dad\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2b809bdabcce3f6e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/sync-metrics/collect.js\":\"eae76d740aa014a9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/sync-metrics/index.js\":\"e74cebfd5bd0ee93\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/sync-metrics/record.js\":\"a1ec79b937bc0d3b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/RejectionDialog.js\":\"c9ed21c9e7bbf247\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/SystemStatusHeaderItem.js\":\"997d8571e1b96617\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/index.js\":\"031c62c3bec74d02\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/model.js\":\"1f46246cb0c8b8a6\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/queueCounts.js\":\"a53dd2a4761d5e33\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/rejectedHelpers.js\":\"0c4c2bf66e0465f5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/rematerializeAction.js\":\"b25f8a07610e43ba\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/system-status/useHysteresis.js\":\"79ad850911e8714d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/ColumnHeaders.js\":\"4a94ab0499b1e0cb\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/QueryUi.js\":\"828f67433631f378\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/TableLayout.js\":\"6ddc9db6cb3ffd2c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/actions.js\":\"a8b93ac24fa93515\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/cellEdits.js\":\"da6cb6f19c412ff5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/columns.js\":\"13a735fec1c3e702\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/controller.js\":\"b21e86e1ea6fa703\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/convert.js\":\"4604e4b717866f63\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/dataExtension.js\":\"b0a7431ac755aa9e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/index.js\":\"fca72eae4305fe31\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/keys.js\":\"1d277da9c5a82eca\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/model.js\":\"557a4f7b0fbc1aec\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/navigation.js\":\"968235b6ca58c067\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/backfill.js\":\"9e9f4cdfbfbc455e\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/completion.js\":\"fb56bd704e583edc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/format.js\":\"f06ae5f9648a5996\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/parse.js\":\"7ded1d4305bb3974\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/queryValue.js\":\"1add12846f39c401\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/query/source.js\":\"12a468c68eceddab\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/registry.js\":\"b8e78c8d4aa1a28a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/rowGutter.js\":\"0da0c260edaa5f9b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/rowVerbs.js\":\"294cd0e7e8234f0a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/schema.js\":\"451df79dee0c39d7\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/tables/sort.js\":\"d159fcca612bb5d4\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/theme-toggle/effect.js\":\"49f6e8674063fda2\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/theme-toggle/index.js\":\"1d9b43c8cce1d207\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/theme-toggle/theme.js\":\"7802c023edb9bfce\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/actions.js\":\"8f10bace7d4e71cc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/dataExtension.js\":\"fe653b6a6db14f92\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/index.js\":\"bd0337269c7be384\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/todo/schema.js\":\"9fa81d35b68d1b4c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a12f6402bcb9f67d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/actions.js\":\"15780111a09fd01b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/defaultItems.js\":\"4c1b44cd788627f1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/facet.js\":\"0852cf86298357fc\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/holdRecognizer.js\":\"fa805d606d6c427d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/touch-selection/index.js\":\"bf2c2d314f13d928\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/update-indicator/UpdateIndicator.js\":\"1dbbd384a10007f5\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/update-indicator/index.js\":\"adeccafbdc9ad751\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/update-indicator/loadTimes.js\":\"a7670f1b069e54ee\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/VideoNotesRenderer.js\":\"a31fd8a5869b755d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/VideoPlayerRenderer.js\":\"756091bd150a6a5f\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/VideoTimeStamp.js\":\"86e342ff38b8226c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/actions.js\":\"fd375a16d2b204f9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/index.js\":\"2a76a469cb6a8b7d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/markdown.js\":\"d150f6752587b83b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/notes.js\":\"4d29903a2faa322d\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/registry.js\":\"829d0ab7b751ab2a\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/remark-timestamps.js\":\"085de9ee83746706\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/video-player/view.js\":\"cdf3ace087f93be1\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/LinkHints.js\":\"4ffb272855909e01\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/index.js\":\"2b172fadaf717184\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/model.js\":\"4edad40801a749c8\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-link-hints/settings.js\":\"fbb49a0f87e15f8b\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-normal-mode/actions.js\":\"c581e99fc38a7884\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-normal-mode/index.js\":\"8c2f296f168f6c3c\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/vim-normal-mode/interactions.js\":\"36a26f5b46451ee9\",\"/knowledge-medium/pr-preview/pr-1864/src/plugins/workspace-header/index.js\":\"3ce828b959719e63\",\"/knowledge-medium/pr-preview/pr-1864/src/registerServiceWorker.js\":\"9589df5104a75033\",\"/knowledge-medium/pr-preview/pr-1864/src/requestPersistentStorage.js\":\"c009db477b3b6741\",\"/knowledge-medium/pr-preview/pr-1864/src/services/authRequestDeadline.js\":\"334c52a15328568a\",\"/knowledge-medium/pr-preview/pr-1864/src/services/authStorage.js\":\"998f2693c9fc1012\",\"/knowledge-medium/pr-preview/pr-1864/src/services/powersync.js\":\"9adb8784c046804a\",\"/knowledge-medium/pr-preview/pr-1864/src/services/supabase.js\":\"2e0e3ab6d9bc9f53\",\"/knowledge-medium/pr-preview/pr-1864/src/services/uploadErrorClassifier.js\":\"84b04794c1771f17\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/ActiveContexts.js\":\"0d05df96b1cdd7d9\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/HotkeyReconciler.js\":\"f94a2415ceb30592\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/WipeLocalDataDialog.js\":\"482050fbc74980b8\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/actionDispatch.js\":\"879598492c7d8e48\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/actionRefItems.js\":\"c29c8c51aecd751d\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/applyKeybindingOverrides.js\":\"9ac4323f169cd601\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/blockActions.js\":\"ade51faf7de062a9\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/blockMergeGesture.js\":\"0bd6f40b3598f7fd\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/canonicalizeChord.js\":\"78898cb270cb72c5\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/defaultContexts.js\":\"a6ad72b4cf772113\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/defaultShortcuts.js\":\"0785cbf8dfa0ef1d\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/effectiveActions.js\":\"23dc5efdff4f36c3\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/gestureAction.js\":\"d866917689fce6c5\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/gestureBinding.js\":\"a64c4af123b758ee\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/holdRegistry.js\":\"6cb3d43b2de985db\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/keybindingConflicts.js\":\"9a1773b45dd2b169\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/keybindingOverrides.js\":\"c4f605bab6e3fe5e\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/pointerAction.js\":\"a181eb0f4ad9b0e4\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/resolve.js\":\"769a9ac35308bfc7\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/runAction.js\":\"1dc827540eaad0ba\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/sequenceMatcher.js\":\"062d72e52e037788\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/types.js\":\"a93cd31214e2c634\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/useActionContext.js\":\"3aa1b2618e856219\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/useActionDiscovery.js\":\"643783af99542ae4\",\"/knowledge-medium/pr-preview/pr-1864/src/shortcuts/utils.js\":\"6606dfac02e3fbe2\",\"/knowledge-medium/pr-preview/pr-1864/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1864/src/sw/bootStore.js\":\"3037573650a88297\",\"/knowledge-medium/pr-preview/pr-1864/src/sw/previewDatabases.js\":\"c5838f6d3eecc8c5\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/byteTransform.js\":\"2f4bbac304f796f8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/attachmentCleaner.js\":\"ea3de494581f3a33\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/attachmentParts.js\":\"8fc6acd7d353e1dd\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/bundleParts.js\":\"886e08565c412f14\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/bundleRecord.js\":\"51efe529e2b97aa2\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/manifest.js\":\"e97d140827b7b45a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/takeBundle.js\":\"96179aa8f56c3f89\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/bundle/verifyBundle.js\":\"57c00d4c96d9b1fd\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/cleaningStage.js\":\"2e2fbbd7829c867c\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/conversionKey.js\":\"4f9ec43e490d9ed2\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/conversionServer.js\":\"a98b0337d29e54a8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/flip.js\":\"b057de16fbd6ea99\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/flipAttempts.js\":\"334498577858d01a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/pages.js\":\"36d05cf56543d283\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/preflight.js\":\"c326a21314140225\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/reseal.js\":\"3a9a55f64ef635fc\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/runConversion.js\":\"5072581e84cd5354\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/runLock.js\":\"c752d100b8e863b6\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/sealing.js\":\"e39e02fd6b6adabb\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/sealingStage.js\":\"af63b1358afdf446\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/stage.js\":\"018aa8aa573878f5\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/conversion/verifyReseal.js\":\"8954c106f94c8da8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/aad.js\":\"f15d7c2de057251c\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/aead.js\":\"a5b934f6c9d3fcc3\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/base32.js\":\"7f59b194733d7f41\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/base64url.js\":\"295c4769583fb2cc\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/binaryEnvelope.js\":\"2be6bc64597650ce\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/byteAead.js\":\"5807ba59f7bd8c13\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/canary.js\":\"947fc7ae52dc17f9\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/contentHash.js\":\"d8514b5992b318d7\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/contentKey.js\":\"cd2b0de915b7f2b0\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/derivedIdNamespace.js\":\"d339de7375a6bd26\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/envelope.js\":\"b134d303593c4dcf\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/hex.js\":\"44fe16685496f503\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/sha256Hex.js\":\"0dfab0a034d033cf\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/crypto/workspaceKey.js\":\"b103cd9d4c3fcae8\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/conversionState.js\":\"39a45327cefe484d\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/createEncryptedWorkspace.js\":\"02135c1e77539a30\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/pastedKey.js\":\"adac7e437415f964\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8897810fc95fbbfc\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0f964cd5af74e24a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/keyStore.js\":\"3b0bc311d8651401\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/mintWorkspaceKey.js\":\"ae15f02160491298\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/modePin.js\":\"966c82ba43b117b6\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/openWorkspaceKeys.js\":\"abc3f5adff04b943\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/resolveWorkspaceEntry.js\":\"fdc38963e514e97b\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/resolver.js\":\"db8c69d1e58f3c08\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/keys/workspaceAccess.js\":\"7e10ee1e505de86a\",\"/knowledge-medium/pr-preview/pr-1864/src/sync/transform.js\":\"22e293aab168365d\",\"/knowledge-medium/pr-preview/pr-1864/src/themeBootDefaults.js\":\"6b03e54201d5f2ba\",\"/knowledge-medium/pr-preview/pr-1864/src/types.js\":\"d870a6d56f61b0cf\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/ClientLocalSettings.js\":\"9f54aef439eb9e59\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/abortableSleep.js\":\"c54cfb3d1eb99e99\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/array.js\":\"8a72789046397855\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/backlinkAutocomplete.js\":\"2a0c2270f91e125f\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/blockCrumbs.js\":\"7f394826e160a981\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/blockrefAutocomplete.js\":\"0d036cfd696059ea\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/cadencedIdleJob.js\":\"b78a7fc90bebca20\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/callbackSet.js\":\"7304778fd96431b7\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/clientId.js\":\"85361465c0a6dcd3\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/codemirror.js\":\"f041debbc44a3560\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/codemirrorCompletion.js\":\"08cace912f970cc2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/copy.js\":\"96c5009759ab081a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dailyPage.js\":\"ce10cff713d34ecf\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dbForensics.js\":\"fc56a086649edf99\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dbForensicsHooks.js\":\"260db2b803fa0f76\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/deleteBlockThroughUi.js\":\"f58b8affab2e8ee1\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dialogs.js\":\"29ee6e38a4df7e14\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/dom.js\":\"2475107a7fb81e0a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/downloadBlob.js\":\"0d37e92741f06908\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/exportSqliteDb.js\":\"b788c87a3bfbd52c\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/fileSystemAccess.js\":\"ccf0f976cb044225\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/flipSlide.js\":\"5c00e7e35c2a1187\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/fnv1a.js\":\"7120771919e29553\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/formatBytes.js\":\"e65790dbeebc2744\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/fuzzyRank.js\":\"a900b614b50a411f\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/idbKeyedStore.js\":\"c17fb99dfcf8cab0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/idleCallbackPolyfill.js\":\"38d7a9ad55a13893\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/keyboardAwareScroll.js\":\"a4e99ec8896c05b2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/keyboardViewport.js\":\"092e330d5a3e052d\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/lastWorkspace.js\":\"86af297a58da380b\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/layoutColumns.js\":\"a57dc2b087dd6aec\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/layoutSessionDom.js\":\"450767ef8aa8ef3b\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/layoutSessionId.js\":\"083cbb957900ece2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/linkClickGestures.js\":\"36e376a72eeeb122\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/linkTargetAutocomplete.js\":\"cffed8b7dbef7eed\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/localDbCorruption.js\":\"a2d4eef134f1e567\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/localDbRecovery.js\":\"9be7b1260dd6638e\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/markdownParser.js\":\"0cdf7ac418f5aa1e\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/memoize.js\":\"61a0a24304e77959\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/nameFieldCommit.js\":\"50cc0a9697b8026d\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/nameList.js\":\"d284f1e6402dbbb0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/navigation.js\":\"bba5836855afab27\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/omnilinerNamespace.js\":\"d5be21a08ffd1e32\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/opfsPageScan.js\":\"fd98040a5686aec4\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelClearance.js\":\"76a1a23c6b9fce70\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelHistory.js\":\"b5965141f9dca7bd\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelLanes.js\":\"f9d3ed3f679317ee\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelLayoutProjection.js\":\"a6dab7ccd9c4d322\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelScrollAnchor.js\":\"aec477796faff725\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/panelUrlFlags.js\":\"98c3a75bce02ff83\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/platform.js\":\"2982c0d0a80486b3\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/pluralize.js\":\"8c569bdd42688df2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/propertyCreation.js\":\"0290e410d4db1b69\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/propertyNavigation.js\":\"2d91ef0342d76af2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/propertyValueContext.js\":\"8478af5eccaf5410\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/react.js\":\"08ef3fb1f82d1a8a\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/relativeDate.js\":\"a683ad6205afdbd0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/relativeTime.js\":\"1e6342353930f4ae\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/renderScope.js\":\"8158144e07b382b4\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/resolvedThenable.js\":\"66a5572f17274d89\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/routing.js\":\"cdc1611125a44203\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/safeMode.js\":\"1007e94abb6b01b4\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/scheduleIdle.js\":\"7735fced9b4ffca0\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/screenWakeLock.js\":\"48a36ab488a058de\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/selection.js\":\"d054cc1a707432e2\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/softKeyboardGrab.js\":\"fbd9b92b419da2d5\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/startupTimeline.js\":\"f65a0ebe71b6160d\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/state.js\":\"44955b3f525afba4\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/string.js\":\"f198c6110cc8d9e7\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/surfaceZoom.js\":\"3be0e272af47ae98\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/time.js\":\"c7c2c79d11882560\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/toast.js\":\"c64761d1d106c5db\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/toggleStore.js\":\"66784a1b9e9fc224\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/untilStopped.js\":\"585ae3a012feefac\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/userActivity.js\":\"ca33a7e2910c89bf\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/viewTransition.js\":\"ce840e2cd0db2c2c\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/viewport.js\":\"ab71407488fd99df\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/webLock.js\":\"9bc5b2a388516595\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/workspaceRecovery.js\":\"50f1adf60e666816\",\"/knowledge-medium/pr-preview/pr-1864/src/utils/workspaceSnapshotStore.js\":\"e0019accc0c3f5c5\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-compiler-runtime.js\":\"1310f0d6da6444db\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-client.js\":\"9ef3eecfd42684ad\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-server-edge.js\":\"82084015ca44280d\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-server.js\":\"acad762751ed292c\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-static-edge.js\":\"2cea613371d88e2f\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-static.js\":\"77631981235df019\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom-test-utils.js\":\"e4df1a0a0bd04740\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-dom.js\":\"414763b9ab57ff83\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react-jsx-runtime.js\":\"9e21df6596bd9a89\",\"/knowledge-medium/pr-preview/pr-1864/src/vendor/react.js\":\"64040a6958007cfe\",\"/knowledge-medium/pr-preview/pr-1864/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1864/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1864/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
