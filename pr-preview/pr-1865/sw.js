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
		buildId: "af1e529bde52-c5cf1ce3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1865/\":\"c04507e3dd47787e\",\"/knowledge-medium/pr-preview/pr-1865/index.html\":\"c04507e3dd47787e\",\"/knowledge-medium/pr-preview/pr-1865/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1865/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1865/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1865/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1865/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1865/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1865/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1865/assets/FacadeVFS-Q1J3QSOd.js\":\"e96b2be8b277cf37\",\"/knowledge-medium/pr-preview/pr-1865/assets/OPFSCoopSyncVFS-JvhznRK9.js\":\"0ff5706de261e160\",\"/knowledge-medium/pr-preview/pr-1865/assets/OPFSWriteAheadVFS-B_UxIWCv.js\":\"ebe51a2d2d988a68\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-XrVujZc3.js\":\"f0a66e9d9fdb764d\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-async-BDgFcvcJ.js\":\"9e4a9da0131d6427\",\"/knowledge-medium/pr-preview/pr-1865/assets/worker-CTi3M2HQ.js\":\"6cccf577af50ac93\",\"/knowledge-medium/pr-preview/pr-1865/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1865/chunks/app-BpEoi1YO.js\":\"a25d585d86d7c93e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1865/index.js\":\"f646b419808cec28\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1865/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1865/assets/AccessHandlePoolVFS-CbEdricE.js\":\"7a0944adc499a397\",\"/knowledge-medium/pr-preview/pr-1865/assets/IDBBatchAtomicVFS-DFvnpy4I.js\":\"8c14405cdcd4e8ad\",\"/knowledge-medium/pr-preview/pr-1865/assets/MemoryVFS-BzMnQtI4.js\":\"57e7e8f1795a9e1d\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-DqS93zm4.js\":\"818c97965d26f3f3\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-async-oNwjye6n.js\":\"f082c28b54ac9ac8\",\"/knowledge-medium/pr-preview/pr-1865/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1865/chunks/AccessHandlePoolVFS-BErnnttK.js\":\"967e425c38eec9fe\",\"/knowledge-medium/pr-preview/pr-1865/chunks/FacadeVFS-uQ5dz4zA.js\":\"ca631cdeb65dcf36\",\"/knowledge-medium/pr-preview/pr-1865/chunks/IDBBatchAtomicVFS-BdGZ_xo3.js\":\"ea1af7bb6ec85400\",\"/knowledge-medium/pr-preview/pr-1865/chunks/MemoryVFS-DsYGPBy7.js\":\"c2e86928b06afd39\",\"/knowledge-medium/pr-preview/pr-1865/chunks/OPFSCoopSyncVFS-f0Iyb18U.js\":\"257539af5ec5d952\",\"/knowledge-medium/pr-preview/pr-1865/chunks/OPFSWriteAheadVFS-CR2MqT8t.js\":\"45c5452dbccc95ab\",\"/knowledge-medium/pr-preview/pr-1865/chunks/Preview-bz_QaRoi.js\":\"7fcce0b60a5f01cb\",\"/knowledge-medium/pr-preview/pr-1865/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1865/chunks/card-RU5fgeU4.js\":\"49ec3f6bd876aa09\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dist-w3bsWqb4.js\":\"b5db6ff8f1b3020b\",\"/knowledge-medium/pr-preview/pr-1865/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1865/chunks/mc-wa-sqlite-CYiXoAHX.js\":\"c3d1a3588483fa67\",\"/knowledge-medium/pr-preview/pr-1865/chunks/mc-wa-sqlite-async-TsAhNX5x.js\":\"a6526d183b63f2cf\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-B1ueAu3z.js\":\"4e83320714ae9be2\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-BLbCHMP3.js\":\"fb3937655ffe7b4f\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-CNHj0NDp.js\":\"d375e98a94f0afbd\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-CpW7Fnb_.js\":\"7e48cd41732e9885\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-DH4oC5Zt.js\":\"a03a95f06ec6b2de\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-DMkoKqHX.js\":\"a871adc08ffe5c28\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-P7XL3Hip.js\":\"cef64ec084f406d4\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-dom-server-legacy.browser.production-C37MHEtP.js\":\"a880307e9a3b7978\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-dom-server.browser.production-CMn8RgNq.js\":\"74d7a5270af56194\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-dom-server.edge.production-9EyH7LI8.js\":\"4438d50a95797a51\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-ghdG3bQc.js\":\"6ddb818d4e38e24e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/server.browser-CUlsx6hl.js\":\"a486beda338f099e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/textarea-2rZpq8SA.js\":\"233de3c44bd3833f\",\"/knowledge-medium/pr-preview/pr-1865/chunks/ui-CAmmQqd0.js\":\"b926d8939a7cd7c9\",\"/knowledge-medium/pr-preview/pr-1865/chunks/wa-sqlite-BB-E8SjX.js\":\"9a51e774c98da307\",\"/knowledge-medium/pr-preview/pr-1865/chunks/wa-sqlite-async-B3IxMjbo.js\":\"6450312a405862a4\",\"/knowledge-medium/pr-preview/pr-1865/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1865/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1865/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1865/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1865/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1865/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1865/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1865/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1865/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1865/src/App.js\":\"84f4d6fdce136053\",\"/knowledge-medium/pr-preview/pr-1865/src/appUpdate.js\":\"7f0824d4e8191933\",\"/knowledge-medium/pr-preview/pr-1865/src/appVersion.js\":\"0ccc23469b55584e\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/initialLayout.js\":\"da7c1a4c2f5ebfa5\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/openWorkspaceData.js\":\"9d3d1706dbe419d9\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/resolveWorkspace.js\":\"460dcaafa97a65b2\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/workspaceBootstrap.js\":\"4bb103e7ff083f6c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockComponent.js\":\"73ec47b5a1f57693\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockCrumbs.js\":\"65fc4610e737c971\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockEditor.js\":\"1be847b51f85e325\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockLoadingPlaceholder.js\":\"3a6a98c5a195ef0d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockProperties.js\":\"1eda9c228d43ad45\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockSearchPicker.js\":\"e7960cd3d9c4563d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ConfirmBulkDeleteDialog.js\":\"83bdf06324e148a7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/DividerHandle.js\":\"654fccb0af680d63\",\"/knowledge-medium/pr-preview/pr-1865/src/components/DraftEditor.js\":\"21c8c69fc21d4fe7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/GutterPill.js\":\"081aac798817e5ff\",\"/knowledge-medium/pr-preview/pr-1865/src/components/Header.js\":\"1e6d46e9013d71c2\",\"/knowledge-medium/pr-preview/pr-1865/src/components/LazyBlockComponent.js\":\"cb401f47615eef82\",\"/knowledge-medium/pr-preview/pr-1865/src/components/Login.js\":\"5da7f85c13f122c5\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ZoomableSurface.js\":\"a6616a6948f4c1fb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/editModeKeepalive.js\":\"31ea903306e89a7a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8d6a02a9b71dd049\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c781f681231199f3\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/RefPropertyEditor.js\":\"85524899a70721cc\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/RefTargetTypePicker.js\":\"e2ce98d6df24521d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/SelectPropertyEditor.js\":\"fa2359f37f970657\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/TypesPropertyEditor.js\":\"ce766a56beea82aa\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/defaults.js\":\"2ca68f5f91651e9a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/kernelValuePresets.js\":\"c89b088c27b47361\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/selectablePresets.js\":\"066f25763ee466e7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/typesPropertyUi.js\":\"2527e77bbc869d50\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/AddPropertyForm.js\":\"15bf196a9fa83d5b\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/PropertyPicker.js\":\"3d34a4d0149bd41a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/PropertyRow.js\":\"41a3e119a843d747\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/Rows.js\":\"58ddf98708177aa8\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/actions.js\":\"b70ac480fa70598d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/declarationOnly.js\":\"018386911c3cb13e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/layout.js\":\"7efb878619fb7b5c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/model.js\":\"00e7d0ac0288270f\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/shapeUi.js\":\"0a78e974a79ca2bb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/shapes.js\":\"ce48101716396cd3\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9ebef8d5f3d05d6a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/visibility.js\":\"173f9cf8b09297cc\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanelSections.js\":\"cfba0be7997c2146\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/BlockEmbed.js\":\"904b46b656e17d2b\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/BlockLink.js\":\"bad8519a44c0c7e1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/BlockRef.js\":\"fc5ada3089d09542\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/ReferenceLink.js\":\"77a8a3f59208d45a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/cycleGuard.js\":\"c37a840dbdb0ba1d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/cycleGuardContext.js\":\"f71237e5f73ce69c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/linkInteraction.js\":\"fc1244089636a5da\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/referenceLayout.js\":\"c7c4354177c29ac0\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/useBlockRefAncestors.js\":\"201d1115e744297a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BlockGutter.js\":\"5833c32a7e8ef5f1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BlockInfoDialog.js\":\"75fe39aed5066722\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BlockTypeBlockRenderer.js\":\"7592b7f036b97aff\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BulletHoverCard.js\":\"b7d13f2f4ff718b6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/CodeMirrorContentRenderer.js\":\"ae41c0c10cdfe465\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"19b2d83e4b0e4a95\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/ColumnResizeHandles.js\":\"287cbb737dcb0eaf\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a37aa0300329b77b\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/DefaultBlockRenderer.js\":\"5b9daece43d7f55f\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/LayoutRenderer.js\":\"409eed4b5b1a7f0f\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/MarkdownContentRenderer.js\":\"e27ff1320761cf28\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/MissingDataRenderer.js\":\"ef3ea1b2ec0f8e5a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/PanelRenderer.js\":\"83e5f1d8a8f25f76\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ca530bc6fb853b9a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/TopLevelRenderer.js\":\"5db41e9c544eb0f5\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/blockGutterMode.js\":\"a27d0837190233fc\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/blockTitleText.js\":\"de88cc771ab2cad0\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/fieldCreationKeydown.js\":\"0bc684ddb9a35554\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/layoutRootContext.js\":\"3b1f833f8e65a2d9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/typeChip/TypeChip.js\":\"40f0691e7c00e13e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/typeChip/chipStyle.js\":\"aa33a71217bb6b13\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/anchored-floating.js\":\"f8cc2ba17315a317\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/button.js\":\"30215e9eb7a2d11e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/card.js\":\"6016dcb255753336\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/checkbox.js\":\"579c297bded5134a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/collapsible.js\":\"ca8741987e3bbd9e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/command.js\":\"faeaa5406272cff9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/context-menu.js\":\"f1082f834090d3da\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/dialog.js\":\"86bbdf7fd90ca677\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/dropdown-menu.js\":\"af7ae71986c6dcfb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/floating-listbox.js\":\"b04e32749d0764c7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/index.js\":\"bd9d25e592095666\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/input.js\":\"18d8a74dbad1ca13\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/kbd.js\":\"c7b6fc83fb02c3ed\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/label.js\":\"25d0d4a3c78421ae\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/textarea.js\":\"5ce3c2edd6262ed6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/useEditModeYieldKeepalive.js\":\"0cdf549f83895606\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/BootFallback.js\":\"1e71b1b42579bde1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/FocusedRowLazyMount.js\":\"7e058157d082ff5a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/LazyViewportMount.js\":\"000a7772d8cfd3d1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/LocalDbCorruptionFallback.js\":\"ad8907a2d96de76d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/error.js\":\"3ce4f8ee6f921cc7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/lazyMountRegistry.js\":\"e96da3639ea6f1b5\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/suspense.js\":\"74754cc47c90fcd5\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/CreateWorkspaceDialog.js\":\"bf6c3690c2b7c8c8\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/PendingInvitations.js\":\"5b783db4e4b2c024\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/SyncProgress.js\":\"7927f59ec8b74dab\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/UnlockProgress.js\":\"6fa5992e851e2fd8\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceKeyGate.js\":\"9e05013a20937deb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceSettingsDialog.js\":\"5490884541115e25\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceSwitcher.js\":\"930569251d67c29a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceSyncGate.js\":\"619fb0fa4f3cced1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/ConversionFlow.js\":\"e30828f760be7b7c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/ConversionFlowHost.js\":\"87a222c543bbe301\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/EncryptionSection.js\":\"d8d1861ebeec85b8\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/attachmentPrompts.js\":\"e87c4cc2088c17d2\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/bundleFolderPrompts.js\":\"656eaa826d15fa56\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/conversionFlowDeps.js\":\"9b1964394e14c60a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/conversionFlowStore.js\":\"632d65c29e7f74a6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/flowUi.js\":\"a72564b130d0ff82\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/useConversionRun.js\":\"b4eeb4fd8f29e3e6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/keyUi.js\":\"f480da7b6454cc9b\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/useCloseOnKeyLoss.js\":\"e724203f19b47fbc\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/useCloseOnServerE2ee.js\":\"e005660add240c0f\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/workspaceUnlocked.js\":\"93a2d49b5ad21a75\",\"/knowledge-medium/pr-preview/pr-1865/src/context/backgroundSubtree.js\":\"f4aac5e6cacc01a2\",\"/knowledge-medium/pr-preview/pr-1865/src/context/block.js\":\"2849c248fb5fd78e\",\"/knowledge-medium/pr-preview/pr-1865/src/context/layoutWsContext.js\":\"fe473a920593ba36\",\"/knowledge-medium/pr-preview/pr-1865/src/context/propertyDisplay.js\":\"890132fcefeeecbf\",\"/knowledge-medium/pr-preview/pr-1865/src/context/repo.js\":\"6c254576a8db466a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/aliasClaim.js\":\"cadf73b33abc0685\",\"/knowledge-medium/pr-preview/pr-1865/src/data/aliasSeatNamespace.js\":\"5546af9f345b9d39\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/blockData.js\":\"52159bada7e8d850\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/blockType.js\":\"4d02cd411e6e11f6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/changeScope.js\":\"9bdb03b08d41e2b9\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/codecs.js\":\"ac33049088fbb8e1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/derivedData.js\":\"a6681e6d1ad77dc7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/errors.js\":\"598d27f27c9e31da\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/events.js\":\"6c15369b716cdcec\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/handle.js\":\"abb9297533194049\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/index.js\":\"f0a4ede49760ca34\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/mutator.js\":\"654640a752b942a8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/processor.js\":\"20a37bc711ecdcdf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/propertySchema.js\":\"334bcc0123cffbbc\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/query.js\":\"e6ad21c447411044\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/sameTxProcessor.js\":\"0b2f708ccc75632c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/schema.js\":\"abb9297533194049\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/tx.js\":\"abb9297533194049\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/typedBlockQuery.js\":\"8669a6efcf6d8aa7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/user.js\":\"e49037fb40e0b419\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/valuePresetCore.js\":\"09ad33428cb6d293\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/valuePresets.js\":\"1082408e848c8f6b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/attachmentCleanerIOVerb.js\":\"40cdeb3621fed1fb\",\"/knowledge-medium/pr-preview/pr-1865/src/data/block.js\":\"2e58b1144864f393\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockCache.js\":\"08345bdc5a2579e8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockId.js\":\"877294645d687e20\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockLiveness.js\":\"f951c20535d6db23\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockMerge.js\":\"52704226f29a5a2c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockSchema.js\":\"3d257a495a4e10c5\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockTypeLookup.js\":\"2e5129d90654acdf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockTypes.js\":\"525291db600f1d66\",\"/knowledge-medium/pr-preview/pr-1865/src/data/childrenView.js\":\"82741f1051c67ca5\",\"/knowledge-medium/pr-preview/pr-1865/src/data/clientContext.js\":\"3deecad0646e5823\",\"/knowledge-medium/pr-preview/pr-1865/src/data/dbFileSiblings.js\":\"c979954913c9bcd6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/definitionSeeds.js\":\"4220798452b0d4cf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/derivedIds.js\":\"56e3e352007b4de0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/drawnSubtree.js\":\"6767ee804711ca04\",\"/knowledge-medium/pr-preview/pr-1865/src/data/facetBridge.js\":\"c3b5867634f48184\",\"/knowledge-medium/pr-preview/pr-1865/src/data/facets.js\":\"87ced3ea7d3df09c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/globalState.js\":\"0c61361dfce86203\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/aliasClaimRederiveProcessor.js\":\"cea88da1b519e1f8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/ancestorBatch.js\":\"5f90f3a627de27f7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/blockTypeTypeifyProcessor.js\":\"e5a7bf2fc4e467ce\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/clientSchema.js\":\"c17b27ee4cfc06b2\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/commitPipeline.js\":\"9140aa3eed29adcf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/devAssertions.js\":\"62b52d761dacb269\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/firstSync.js\":\"f149c4d63fbe311d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/freshInitialLoad.js\":\"849977dfea1be12d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/graphBackfillClaim.js\":\"0eca47701a05bd62\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/handleStore.js\":\"345efc9b08816b53\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/idleMarkerJobs.js\":\"685640f4cf25f64b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/initialDownload.js\":\"00d5266433f25fcb\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/initializeClientDatabase.js\":\"478300aafd4bd5e4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/jsonCanonical.js\":\"b23995239f9e97b1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/kernelInvalidation.js\":\"92de7e1cc399b4be\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/kernelProcessors.js\":\"823be903ca1d043b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/kernelQueries.js\":\"907f2553efc82174\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/mergeTypeMembershipProcessor.js\":\"1562c56a8edd4c98\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/normalizeReferencesProcessor.js\":\"c38324828639ed66\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/poolInstrumentation.js\":\"1851d1224e2bb54e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/processorRunner.js\":\"1f2dd8039bd62049\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyCellBackfill.js\":\"27394bbf44975c5d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyChildMint.js\":\"7c6e16be764171a0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyChildrenProcessor.js\":\"ed024a1290917ba1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f52fe2e808430d8d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyDefinitionSynthesis.js\":\"876ee59699fe8feb\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyKeyScan.js\":\"72cf2a45c95fa16d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertySchemaResolution.js\":\"166f3bf0dfcab4eb\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyValueEdits.js\":\"3faf789828bffd1c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/raiseProtocol.js\":\"67b28c962405f1f7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/readBatch.js\":\"ffddeaae6d94da25\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/refProjection.js\":\"140f6c969457af12\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/referenceTargetLookups.js\":\"b294e3e4473c8626\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/referenceTargetProcessor.js\":\"24626ed7967f8586\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/replayMerge.js\":\"d1f7473b4d2a0fa1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/sqlBinds.js\":\"e25bef49bd1cb113\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a0d9dc94da5728b2\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/arrivalProcessors.js\":\"7cfe4413c5cbc4c2\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/invalidate.js\":\"fde267b1cab62b4b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/materialize.js\":\"a67b071ace2981cf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/observer.js\":\"f4e8b0a61553c0d3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/reconcile.js\":\"6583b14a60b20f4b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/timingMetrics.js\":\"57962dc217a17799\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/treeQueries.js\":\"742a2d16c9eca2bd\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/txEngine.js\":\"c266823628a36489\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/txSnapshots.js\":\"63a57625e0419231\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/typedBlockQuery.js\":\"317320407f1b3f15\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/undoManager.js\":\"210d30f26e934c0e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/invalidation.js\":\"7d430ef0bda93be3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/kernelDataExtension.js\":\"682670d8cf33fec4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/kernelPage.js\":\"81f3746347bc09a0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/kernelValuePresetCores.js\":\"5467862ac4f6450d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localDbCorruptionSignal.js\":\"5e596bc312023db7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localDbStorage.js\":\"7edcacaa03112b73\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localDbVfs.js\":\"397e07c89123fa19\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localSchema.js\":\"fe1c76401b95438a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/maintenance.js\":\"e7b7791db31ed69e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/mergeProperties.js\":\"81bf5db1f4bb8fa3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/metricsConsoleHook.js\":\"61aa999f621b4f98\",\"/knowledge-medium/pr-preview/pr-1865/src/data/migrationsPage.js\":\"5ff0d45a786483a5\",\"/knowledge-medium/pr-preview/pr-1865/src/data/mutators.js\":\"4cbd1d45cdee11e8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/orderKey.js\":\"5f18c3668e7c2c13\",\"/knowledge-medium/pr-preview/pr-1865/src/data/orderKeyPlacement.js\":\"44d826ac7be07c3a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/outlineSurface.js\":\"cc7f27cb8415863a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/pendingEditorContent.js\":\"8cb6b4877b9c71e6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/pendingUploadsSql.js\":\"56174c8003c7e935\",\"/knowledge-medium/pr-preview/pr-1865/src/data/pluginStateExtensions.js\":\"82eb029ed4327203\",\"/knowledge-medium/pr-preview/pr-1865/src/data/powerSyncLogger.js\":\"453e968a9957da22\",\"/knowledge-medium/pr-preview/pr-1865/src/data/projectorRuntime.js\":\"e64548c1242e1c46\",\"/knowledge-medium/pr-preview/pr-1865/src/data/properties.js\":\"26b8fc8c9fb11fee\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertiesPage.js\":\"740a297c3c487dc4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyChildren.js\":\"a41a57b41c41bb46\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDefinitionFanout.js\":\"b7ed802a729c4feb\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDefinitionMetadata.js\":\"f41a05cd4105d7bd\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDefinitionRegistry.js\":\"dbd2f186c5c5521f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDisplayMode.js\":\"cbe57d46450a1a46\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyRowCreation.js\":\"bc165a9ab6562957\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertySchemaCreation.js\":\"f30a7c6f3d529621\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertySeeds.js\":\"ae38d3e9805cdc94\",\"/knowledge-medium/pr-preview/pr-1865/src/data/recentsPage.js\":\"5b6d9f496a6f8b3c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/referenceBlock.js\":\"98fb3cff139c4e0e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/rejectedUploads.js\":\"122242f415638138\",\"/knowledge-medium/pr-preview/pr-1865/src/data/releasePowerSyncConnection.js\":\"ca857ec2e088a20e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/repo.js\":\"e732d81eadeaa404\",\"/knowledge-medium/pr-preview/pr-1865/src/data/repoProvider.js\":\"4aebf1171f9c6811\",\"/knowledge-medium/pr-preview/pr-1865/src/data/rowProperty.js\":\"b322a26f3119741c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/searchFilter.js\":\"c961de5adc20acc1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/seedIdentityLedger.js\":\"c2e54a43d9813115\",\"/knowledge-medium/pr-preview/pr-1865/src/data/stateBlocks.js\":\"4a20e0670c7c4491\",\"/knowledge-medium/pr-preview/pr-1865/src/data/structuralEditPolicy.js\":\"de7c5b7132d0a632\",\"/knowledge-medium/pr-preview/pr-1865/src/data/subtreeDelete.js\":\"8fcc3e10f3512c17\",\"/knowledge-medium/pr-preview/pr-1865/src/data/syncStreamLock.js\":\"6249387b2e596a6c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/syncedTableSqlRecognizer.js\":\"9d53d566c64fb413\",\"/knowledge-medium/pr-preview/pr-1865/src/data/syncedTableWriteGuard.js\":\"537aa09716d54183\",\"/knowledge-medium/pr-preview/pr-1865/src/data/targets.js\":\"4f6b7a27bdeeb291\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeColors.js\":\"5d53b06de47debef\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeDefinitionMetadata.js\":\"c03057394ff51298\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeDefinitionRegistry.js\":\"71de0fddbfc695b6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeExtraction.js\":\"72d886dfebabf070\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeInitialValues.js\":\"e5331666f25200ad\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typePropertyGroups.js\":\"c51f339e461a403c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeSeeds.js\":\"205a85875e3c2a9d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeTagger.js\":\"630f3fca6d496f4d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typedRecords.js\":\"3a947fac62996b60\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typesPage.js\":\"44c1df62535a499d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/userPrefs.js\":\"e125d65f8904e1b3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/userSchemasService.js\":\"1509bcfbba6f3b3a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/userTypesService.js\":\"153e131a7381a459\",\"/knowledge-medium/pr-preview/pr-1865/src/data/valuePresetRegistry.js\":\"58f5a9c1e965a3c9\",\"/knowledge-medium/pr-preview/pr-1865/src/data/visibleChildren.js\":\"1e8b3c84139dbc4c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceConversion.js\":\"48ccaf7fd340b552\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceFirstSync.js\":\"faf48215fba05fa7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceIdNamespace.js\":\"862ba6b224c3e399\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceSchema.js\":\"7143010202925285\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaces.js\":\"f32ba60614c3b852\",\"/knowledge-medium/pr-preview/pr-1865/src/data/writeAheadLog.js\":\"02adb1169b4c8e7d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/BlockPasteShellDecorator.js\":\"4ad0e4a8914148e4\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/atTrigger.js\":\"b2c93fb5c640f588\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/autocomplete.js\":\"a5e6056816b5a1dc\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/codeMirrorExtensions.js\":\"68dbc2a7b7e183b5\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/contentFlush.js\":\"fd2532b06fc72365\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/defaultInteractions.js\":\"a4edc2b4418f2570\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/editSettleSignal.js\":\"74d8c5b47c2eaa95\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/insertImage.js\":\"46e5f49c0a68cc9d\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/referenceCompletionRange.js\":\"446a779f71aadef8\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/referenceTargetTypes.js\":\"b731b392757deac7\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/syntaxContext.js\":\"8581eade9f5420bc\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/triggerMatch.js\":\"c571eaad7ab49eab\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/AppRuntimeProvider.js\":\"67f1be8a5fd856eb\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/BlockFocusShellDecorator.js\":\"524fd81d628e08e4\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/ExtensionRenderBoundary.js\":\"bec04aaf35d4248e\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/PanelContentRecovery.js\":\"8c89730b8e088a7c\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/apiCatalog.js\":\"cced11e98bc8de34\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/approveExtensionHere.js\":\"f348197e02f604c4\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/armedCutAppMount.js\":\"bc71eecf59dff063\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/batchableKeyedStore.js\":\"37f355b5b10a6d6b\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/blockInteraction.js\":\"a9255ac589f05ed7\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/blockSelectionAction.js\":\"181265a74e3e1fa8\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/compileExtensionModule.js\":\"1cbe2d16dd404807\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/compiledModuleCache.js\":\"6e9b62c1cbcc82b2\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/continuousGestures.js\":\"bd91a40eb9ce1a79\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/core.js\":\"12e1d1268b6c6f25\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/defaultRenderers.js\":\"5551fc2bf0f7f452\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/definitionFanoutAppMount.js\":\"f9fd0b9c4bd7f26b\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/dialogAppMount.js\":\"9194e2080aed3ad7\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/dynamicExtensionSeeds.js\":\"9bab663e05efcd81\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/dynamicExtensions.js\":\"9426a44a65fbc813\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/exampleExtensions.js\":\"d3019ec95b338be3\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionApprovalStatus.js\":\"a7449fc80d2ad548\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionLoadErrorToast.js\":\"399b693762e8ddc3\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionLoadErrors.js\":\"fc7b658f15086cad\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionLookup.js\":\"90a16f9205978e92\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionToggles.js\":\"495099abbd26e52e\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionUtilitiesCss.js\":\"266d1484ceb9827d\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/kernelPageDeletionGuard.js\":\"6a8f6092a6521900\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/liveRuntime.js\":\"20661f05b3a3bdf7\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/openExtensionsSettings.js\":\"aab0da3660fd36ef\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/overridesCache.js\":\"527244856f027015\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/pluginIds.js\":\"97c2b361b20f63a3\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/processorRejectionToast.js\":\"b52246035b922549\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/runtimeActions.js\":\"54529da252eb61e8\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/runtimeContext.js\":\"1c52b7210cf5d046\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/staticAppExtensions.js\":\"3fbf3fc44f9ddcf6\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/staticDataExtensions.js\":\"b208c1888c1b9e97\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/toastAppMount.js\":\"c09f8674cfae9175\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/useOverrides.js\":\"7ab89502ae61b1f9\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/useShortcutSurfaceActivations.js\":\"e637480c2165229a\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/discoverToggleTree.js\":\"adfc61faee8a6548\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/facet.js\":\"148fb8c504dd7c59\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/resolveAppRuntime.js\":\"863146b3df0df1e0\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/runtimeEvents.js\":\"34da4b6aad519711\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/togglable.js\":\"c1fb8195095017aa\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/variantFacet.js\":\"bb62051508ef0365\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/verbFacet.js\":\"dbf8f5dbed1133e4\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/block.js\":\"52f176e31c15fb05\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/focusedChild.js\":\"b1332b2cb6406ebf\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/propertySchemas.js\":\"e4b8eb2852279a2f\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/typeRegistry.js\":\"f372a6d8573d9a13\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useAncestorCrumbs.js\":\"11b68e0423e609c2\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useAutocompleteListbox.js\":\"d4fb617f59dbc2f8\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useDebouncedSearch.js\":\"3895eb0b080da949\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useDebouncedValue.js\":\"bb33418aa475aca7\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useIsFocalRender.js\":\"b29dc3de98e280f8\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useIsReadOnly.js\":\"05a11f2ab0511358\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useMaterializeBacklog.js\":\"f4a3053e4f292036\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useMinuteClock.js\":\"783169aa6f90327d\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/usePanelLayoutProjection.js\":\"ca1116ae7c98057d\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/usePendingInvitations.js\":\"866a4ff927b725f4\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useRendererRegistry.js\":\"a00c6de92a9d95ed\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useRetainedFieldRows.js\":\"4793dc00c488bf5c\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useWorkspaces.js\":\"cb7def4dc6fc615d\",\"/knowledge-medium/pr-preview/pr-1865/src/lib/utils.js\":\"f919bfd28a445565\",\"/knowledge-medium/pr-preview/pr-1865/src/main.js\":\"539a0d4814384beb\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/MarkdownImage.js\":\"4c57514eb16d5853\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/blockSeparators.js\":\"0f2bd77513731ecc\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/context.js\":\"3612c5432664a241\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/defaultMarkdownExtension.js\":\"a91e77d8be7e99b5\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/extensions.js\":\"398a696c7b100e72\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/renderMarkdownHtml.js\":\"4b66c916f9ae7745\",\"/knowledge-medium/pr-preview/pr-1865/src/minimal-editor.js\":\"33c477e975a5333c\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/armedCut.js\":\"10c90b88e2f7943d\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/captureMediaVerb.js\":\"4aa6041dfcf162b9\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/clipboard.js\":\"e446b6a0fe3ad19a\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/decision.js\":\"f310dcbf86486dc5\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/operations.js\":\"6983bf3eb79fe9bb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/account-header/AccountHeaderItem.js\":\"f15e2c14034b6646\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/account-header/index.js\":\"f952edc1623781cf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9d2960b0fe2b080d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/askAgent.js\":\"f1aed5f2265b362b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/askedStore.js\":\"ead8f695f95046f9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"4991ef080605f6f9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/chipState.js\":\"73f2eee138fa95ce\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/dataExtension.js\":\"36bb742a52383c87\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/index.js\":\"1250603437d63ea0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9082528a98b467eb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/schema.js\":\"5a74a0127918d087\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/AgentTokensDialog.js\":\"99084d4690e9d780\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4e1e7dce92b15668\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/addMedia.js\":\"881655a09958ecc1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/backlinks.js\":\"500fc3a783bb42b2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/block.js\":\"d64499e2c9b0b36e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/context.js\":\"4d0d69dbea64da11\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2745ca6c1518a6ae\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/index.js\":\"c2d23ee292f93162\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/memoryIndex.js\":\"e33c240603b520da\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/outline.js\":\"94d05966a277d822\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/properties.js\":\"7ba2fa2fbc690860\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/refs.js\":\"37dc93fc97350a83\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"eb2f6f7ba90c1395\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/search.js\":\"cebb34c6ee714ee8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/shared.js\":\"3b34070113f34bb6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7a02a803d8cbd57c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/text.js\":\"815713921cf92c2e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentWrites.js\":\"f21563c851193f58\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/authoringCatalog.js\":\"e0e23913507440db\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/blockRefTargets.js\":\"b0fb105731739610\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/bridge.js\":\"5416b82a7718b65d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/bridgeLoop.js\":\"ccdb81b2d901fdbf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/changeHistory.js\":\"4e8761fe4e75259a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/commands.js\":\"72bbc9298098b451\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/commentsCommands.js\":\"d09c8176d850834e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/dataExtension.js\":\"eead889e9b98195d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/dataModelGuide.js\":\"ea3a0d4b48139e87\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/describeRuntime.js\":\"f7e6d294dbca7469\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/extensionLint.js\":\"b0e53c39b5b60901\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/grainAudit.js\":\"ce9120a168989110\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/healthCommand.js\":\"d2ec9e5303db52f3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/index.js\":\"6ce4f9637cb8928d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/presetIdentity.js\":\"ad33158a5a9f6c18\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f2f1529d0ee8fcac\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/readMedia.js\":\"454adcfcbd5db51b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/schema.js\":\"6bdbac7dc1e44f75\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/serialization.js\":\"04bcbf9f076b8ca8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/targets.js\":\"a815ae4e72aacd32\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/tokens.js\":\"b002e32c54d7b5b4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/watchEvents.js\":\"70fac303eba7af6b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/workspaceGuard.js\":\"828b05316fdba1b8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/writeCommands.js\":\"f84848fd03768fe2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/AliasCollisionToast.js\":\"734147d75670b7b4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/DuplicateNameBanner.js\":\"0a356c9f02345f29\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/collisionMerge.js\":\"ef2cd9c4709b3e74\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/dataExtension.js\":\"a7275b9588f24c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/index.js\":\"f849cef36d5783a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/mergeCollisionAction.js\":\"f60f74cc395abec0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/pageStyling.js\":\"25bfbcba2089ed91\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/rejectionToast.js\":\"cfd040286f399ff8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/syncProcessor.js\":\"09984b5ee670cd6e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/actions.js\":\"05dad09696e568c0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/addComment.js\":\"60baab7632dd9205\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/anchor.js\":\"4cf62590dd4cfd69\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/anchorState.js\":\"abebff62f5351863\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/commentLinks.js\":\"9b33bbd23a3a0ad6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/confirmThreadDeletion.js\":\"0c2e541be7d547d8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/container.js\":\"82ada2a29eb4d4dd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/dataExtension.js\":\"d219d2f343d3415c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/deleteComment.js\":\"6a69516f5b8c06b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/highlights.js\":\"e0b57a73fdb77e84\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/index.js\":\"bbb2d18a5377cf45\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/linkedCommentsPill.js\":\"2db52f5c1e00ee09\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/margin.js\":\"d72bc19e0e61d745\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/marginSchema.js\":\"caa6d35caadaa815\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/newComment.js\":\"57acf29a2343556f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/ownThreadPicker.js\":\"cc0bf2dc1386f14d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/placement.js\":\"4c050fb1cbc9f6d5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/queries.js\":\"b45ef0af05917b5e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/quotePosition.js\":\"f25ce4494e030f0a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/quotedIn.js\":\"7db5e8b8d0ca3e27\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/quotedRange.js\":\"aa9af223b5b43da9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/rangeRefs.js\":\"1ffecb6b72ba90fa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/readHighlights.js\":\"9e0d6f77cf4aa595\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/readSelection.js\":\"e44e603818bdeb09\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/readSelectionUi.js\":\"7c92329dfb6e78bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/reanchor.js\":\"af86979898616608\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/schema.js\":\"38069bbdd10adf9e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/scope.js\":\"d6d067c5bccfa74a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/scopeThreads.js\":\"f30a9a2692c57329\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/splitRetarget.js\":\"c9acb08a7fbe8799\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/suggestionCard.js\":\"d33ec77a584c9cb8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/suggestions.js\":\"37c1cddb80c2a864\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/summaries.js\":\"f194a1d18374a3bd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/summaryBatch.js\":\"9934e6e55cb621c4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/surface.js\":\"808d3fcdfa4e1a8a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/threadNavigation.js\":\"7833d313ea784f98\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/threads.js\":\"b60b250990ef0e89\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/ui.js\":\"d36a968e6d8b38bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/uiStore.js\":\"af0ba913c52b802a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-intents/appIntents.js\":\"1f1669cc962e0702\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-intents/index.js\":\"094b631c0daf2816\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-update-prompt/index.js\":\"8fa4fb09af81827d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-update-prompt/status.js\":\"2023789e140451f9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"56e77e77f0b201a0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/MediaBlockRenderer.js\":\"2f4d768ee8b76160\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e2748e98f3d79c20\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/MediaUploadReconciler.js\":\"4ad6ddd32aef9ea3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/assetDownLane.js\":\"d4ae5706ef9ad9cb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/assetResolver.js\":\"fce038c94effe53b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/assetUpload.js\":\"eec5b05705909a58\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/attachmentCleanerIO.js\":\"ffec97fe7407aaf9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a0bedc433f17ce7d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/blobStore.js\":\"64517a11ae12ba57\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/browserMedia.js\":\"de7ed6a0b0e21411\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/byteStore.js\":\"99e4266c3e9e61a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/cleanerIO.js\":\"98da20ac95463c3e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/cleanupAttachments.js\":\"54b4710368b67972\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/dataExtension.js\":\"ebbcfb846c14b56a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/downLane.js\":\"fce3812910223332\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/index.js\":\"7e9cfd9a7b895aab\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/insertImageContribution.js\":\"e88a2bdd10db9bc3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/laneArming.js\":\"dd41f682be8f2d93\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/laneLock.js\":\"2e0bc638451e99f1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaBlock.js\":\"356a1b271ff9febc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaCapture.js\":\"aacbd2711b872051\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaLanes.js\":\"16f55e23bb34026b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaViewers.js\":\"44510a619455c10a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaViewersFacet.js\":\"733475b350631eaf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/pasteCapture.js\":\"d991ffe28ffd91b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/resolver.js\":\"bf80640ecd5bbea1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/retryUploadsAction.js\":\"4da21aaa1c0d2955\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/storagePaths.js\":\"be2a82fd725cfd14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadDrain.js\":\"4e1009bcc793e034\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadLaneStatus.js\":\"700a98cac4cb6167\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadReconcile.js\":\"90e9ee42bef21f68\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadRecovery.js\":\"bd3002a78239d7de\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadStore.js\":\"e748f5b863bfbe4e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/useAssetObjectUrl.js\":\"43d5fa29d53f3bd8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6cd93fa2ecf9ccba\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6ecb0377761233e5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/facet.js\":\"b2d3d67ef1bcf9e4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/index.js\":\"b4192887bed0586e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/prop.js\":\"46e4ec4988e9d5dd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/BacklinkFilters.js\":\"294685e9a6e82f74\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bf92ddb2496fdf26\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/BlockEntry.js\":\"cff0becaf7698bee\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/LinkedReferences.js\":\"000b4a77681aa982\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"014ce6eb5d2c7eb1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/dailyNoteDefaults.js\":\"ebfc3eb91e849502\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/dataExtension.js\":\"9e78fbb174be5b0e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/edgeExclusions.js\":\"fc75dbf7891d603e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/filterProperty.js\":\"2ebdfa8c73c94241\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/index.js\":\"59e1644c90a7a4fe\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"368d3b8b505976f0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/applies.js\":\"703ea15d5c1e39e9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/countQuery.js\":\"ded02d0ffa37ce04\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/expansionStore.js\":\"914a1cb2dd776999\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/index.js\":\"f990ba701ae0c827\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f57bdc8c71b634c1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/presentationInvalidation.js\":\"19370b24d76410c5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/propertyEditorOverride.js\":\"8005cafacac37bfe\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/propertyFilter.js\":\"350aec3e70388865\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/query.js\":\"a4c0ebe9abfbf3ca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/resolveFilter.js\":\"9a58ce32e2931f11\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/sourceBatch.js\":\"4717d9d74e20575c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/sources.js\":\"582e2a7a8c77b696\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/useBacklinks.js\":\"9416878c6ad9c758\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"96d142789f698c94\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/BirthdayCelebration.js\":\"b4c8c5acbcb31eb2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/BirthdayOverlay.js\":\"41cd2987465eddb3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/gate.js\":\"c04312b3dfa622ba\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/index.js\":\"425de92d21e76b44\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/wolfTheme.js\":\"8975cbfe75592079\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/BlockDragLayer.js\":\"462fd73e5ddfab1a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/dragController.js\":\"3e2c4d74c70c43c4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/dropTarget.js\":\"8e2a5fc1e17bb98f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/index.js\":\"3a0ed0c8b11ab54e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/projection.js\":\"3e330f322d25831c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-info/BlockMetaCard.js\":\"1e55e6cfeee997af\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-info/index.js\":\"b05317ca14a141e4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/AddTagDialog.js\":\"ddbd1c263b74447d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e4e083e9a472ddf9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/TagNameIssueHint.js\":\"feefc7871bd50230\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/addTagAction.js\":\"5cec12a54961d707\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/appendTag.js\":\"2db2a829dd380208\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/config.js\":\"68c53d2df60dcad0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/dataExtension.js\":\"ead071059f05de15\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/index.js\":\"a71b691d9ea4cf53\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/propertyEditorOverride.js\":\"a8de127d5efad588\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0cec0d57ad5dbdfc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e3d09ab0561580f7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/Breadcrumbs.js\":\"2c4e12219a43e659\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4e21e0ea3c1353bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"72ef744fc575caca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/index.js\":\"6de5a448845b7855\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0945c8bf1479ff59\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/CharacterCountItem.js\":\"daa59f5c75845685\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/ProfilePropertyEditor.js\":\"49e6b50a9a44a927\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/actions.js\":\"066e8c82f52178df\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/blockType.js\":\"9475e62651bc773a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/charCount.js\":\"459b4329f5806d49\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/dataExtension.js\":\"2c2afc514806172e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/index.js\":\"991c6a1517ea6a22\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/profiles.js\":\"dccb5ab1a60b753e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/properties.js\":\"fb7819b613fe1b14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/textCounts.js\":\"0ba68f9d0196536f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/colemak-keybindings/index.js\":\"d0b69363a2724e7c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/CommandPalette.js\":\"0f4b90bbec2f86c7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/HeaderItem.js\":\"bb8c1db5a2b15999\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/context.js\":\"ba0df23c9a7220db\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/index.js\":\"fffcfd3ea4ba0570\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/selection.js\":\"7ecbf6e66349748a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/toggleStore.js\":\"6a7590a0099bab82\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/useCommandPaletteActions.js\":\"1189ad01f58ead7a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/ContributorBadges.js\":\"6e3ac5aa30fe7853\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/author.js\":\"7e1b871dd503a018\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/codeMirrorExtensions.js\":\"aa123dc5b8fcb3e6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/dataExtension.js\":\"049a5a2df09106a0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/index.js\":\"aaa5e87bc032ba50\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/mentionAutocomplete.js\":\"ccd6717bdd054a2c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/processor.js\":\"c05d7f5f51c7ab31\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/profiles.js\":\"cf2f3606c037e91c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/queries.js\":\"47f649561c419ee2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/schema.js\":\"318add64b3913ca0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"038f5cd7f50a0857\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a0ad9053308f8164\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/index.js\":\"76619989e32ee432\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"75f1ab34a280f607\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7c72547a8f522213\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/CalendarGrid.js\":\"83e350866c783458\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DailyNotePicker.js\":\"63bf7dad6eeb47b3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4f749bdbde84c2e4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DateNavDecorator.js\":\"d65131769dc9bf87\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DateScrubOverlay.js\":\"fd13d446d593c382\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/HeaderItem.js\":\"09c8ec8e84845c36\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/ReschedulePicker.js\":\"d545b4f28b782906\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e78fb7e5da0549f8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/actions.js\":\"aad3c02596ad9fa3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/blockDateAdapter.js\":\"53eb746f3787d984\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/calendar.js\":\"5b697b39a1550fc7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dailyNotes.js\":\"2c8d26001f90bea8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dataExtension.js\":\"957769f9ddcdc37c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubActions.js\":\"05785074167360ec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubGesture.js\":\"6832e312f0cea981\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubGestureActions.js\":\"01d1f5e4f2c06857\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c28b2ac4fe068fc8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/deletionGuard.js\":\"92c904632ecd9a21\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dueQuery.js\":\"894442661aeca58e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/index.js\":\"d0f375d97d20ecb2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/landing.js\":\"37c295358963561c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/localSchema.js\":\"306400a5b4d1ba87\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/referenceDateAdapter.js\":\"98ba2f404a1f8ed6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/rescheduleAction.js\":\"1709e40b78414ea9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/schema.js\":\"3e0aa33f17055720\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/spreadBlockDates.js\":\"a96c99d22eb4ccb3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/spreadDatesAction.js\":\"ba582e550409811c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/today.js\":\"94c2886afbacfa0f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3e02978b2086b404\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b5ed57c5f9a495a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/audit.js\":\"57c610fce731385e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/auditAction.js\":\"14e04b8185445687\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/auditRanges.js\":\"c6957e2d0544e65d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/diagnosticsSource.js\":\"9b57cc810ae4c2a7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/divergenceScan.js\":\"1163dabff7b9b9b5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/index.js\":\"7612ad8666689d41\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0c08f54b0235a7ed\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/referencesMirror.js\":\"e04589f71fc5682b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/rowJson.js\":\"a85006d25e178d75\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/schedule.js\":\"df8a5eea80d50cec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/store.js\":\"ff36adfbe4c8e64c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-maintenance/action.js\":\"d82b35b8998dbbf2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-maintenance/index.js\":\"b2ab52644f58d59a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-maintenance/plugin.js\":\"17bdbe767dccd0b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4c1f73c02b334759\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/actions.js\":\"3123f047c0daa38b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/changeMarker.js\":\"c8f1cd3ba1866210\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/diagnostics.js\":\"c294ff0543657e4d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/fileSystemAccess.js\":\"3d795dcec13c8588\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/filenames.js\":\"9c7cbfa721bed823\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/index.js\":\"f4406a993f23851c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/mirror.js\":\"5711530a9ea15eac\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/runLock.js\":\"499f395c3c4b7b18\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/runtimeHealth.js\":\"a0f286b910caab47\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/schedule.js\":\"04e5f835b502a565\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/store.js\":\"5905c65e4f196ead\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/default-themes/index.js\":\"fbed4122d5199749\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/default-themes/themes.js\":\"2ce134c1963d576d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/diagnostics/facet.js\":\"93679ae0918a832f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/diagnostics/useDiagnostics.js\":\"ea47121b4adcb74d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/dismissals.js\":\"ab5cc59c1dcc7a5e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/index.js\":\"b916e6aed1b7e3c6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/status.js\":\"4df77fb329578f9a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/store.js\":\"515a570babd31dde\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4ca38db1d0d4ed4b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/ExtensionsSettings.js\":\"058447ba2e54be01\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/actions.js\":\"1aa7a12c2e2ccd3c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/config.js\":\"01eea32067bb8f50\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/dataExtension.js\":\"154b243ef68433d8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/effect.js\":\"665cdbe2b4277b19\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/index.js\":\"0fed2b0a6d672de4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/propertyEditorOverride.js\":\"971c05fb2fe30916\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/useToggleTree.js\":\"9a7104d55d7eaa36\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/ExtractTypeDialog.js\":\"12c1e09e88dba758\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"db682669f0091eda\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/PropertyShapePicker.js\":\"55c0df8d884a6228\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/action.js\":\"b2458c2ed68e4cbf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/index.js\":\"5bcc7094206df6c7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/FindReplaceDialog.js\":\"d8688c9be2132542\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/HeaderItem.js\":\"3c888eec7f661ce5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/dataExtension.js\":\"f274b6f4a9648db2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/index.js\":\"908c25375de0803c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/search.js\":\"9e0b807986cd45d7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/toggleStore.js\":\"77f909d5f6fb0a2f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/LocationPropertyEditor.js\":\"522916c95ea11d28\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/MapView.js\":\"0008622d377f8c6c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/blockTypes.js\":\"49afa4b6b60835de\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/codeMirrorExtensions.js\":\"8426780c75a39ec6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/createOrFindPlace.js\":\"cc740a980ad6322b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/currentLocation.js\":\"88fe149ca18d5d91\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/dataExtension.js\":\"75b73d29491f0221\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/geoContentDecorator.js\":\"e74a98e816a87fa8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/googlePlacesClient.js\":\"50e359fedbe55ffe\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/index.js\":\"ea8bf3c6ffd0fa0e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/locationsPage.js\":\"8117cc96021586ee\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/mapViewport.js\":\"dd516264768c5fcc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/pickCurrentLocation.js\":\"a8d9653878036b2e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/placeAutocomplete.js\":\"9ba8abf6649c6ace\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/placeNameCollision.js\":\"a755adee188056dc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/properties.js\":\"f730b8c6a50fbe4b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/propertyEditorOverrides.js\":\"497a6692f9ac19a0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/query.js\":\"26a3fce23f085b7f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/usePlaceSearch.js\":\"e5079abb93c54cb5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c550246911ef7e61\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cad2c25e541f607c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e9792270f3931231\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/config.js\":\"a48f430de454e97a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/dataExtension.js\":\"80fb4ce8a29b9655\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/facet.js\":\"3aa70ca3bc052592\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/grouping.js\":\"e5351ae1a00be610\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/index.js\":\"8cc3fcccc366fbb5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"40609837bf4c0f71\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/query.js\":\"9482e112049c12ab\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/resolveConfig.js\":\"f518ce0a2f9c7d21\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f25760e6af58f97a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ef212a94344a53aa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/HtmlDocumentContent.js\":\"409c5028ff2999af\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/HtmlFrame.js\":\"cfc55368a3531177\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/actions.js\":\"f3d9a3dd7ca3fa57\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/blockType.js\":\"98cd51214f038baa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/confirmRunScripts.js\":\"4c4a0d187c6f65e7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/dataExtension.js\":\"310ba067385f8715\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/frameAnnotations.js\":\"be20bb5a036deed2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/frameDocument.js\":\"314c88ea8507e5a7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/frameTheme.js\":\"587a015bf71bd4b4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/index.js\":\"c76d34da4321171b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/scriptConsent.js\":\"d95929e261b4d306\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/sourceMap.js\":\"0fbad536c5fff3bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/useDocumentScripts.js\":\"2f9471bfd4a476df\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/index.js\":\"0cc4f9abfad17e70\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/record.js\":\"ac9d38c5d174cf9e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/recordStore.js\":\"a9b42f609fa9c5b3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/responsiveness.js\":\"ed4e8674941d4521\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/schedule.js\":\"d53af4ff145fada1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/sessionContext.js\":\"57d08eb6d3953cb8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d74a2a0fe6da9b9f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ea50e7b82324dfce\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/actions.js\":\"b8e2b47ff758a5d4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/config.js\":\"0cc5b1e77945cf84\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/dataExtension.js\":\"c0a6b1272ed2f37f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/effect.js\":\"df137b6107869fa4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/index.js\":\"9b10c9a28108b18e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/keyCapture.js\":\"63007f8ef888f095\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/overrideStore.js\":\"0e84d7c261e5b926\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f51661373c495e01\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/HeaderItem.js\":\"a14929a519efc107\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/LeftSidebar.js\":\"f7dcfe3e7422044f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/actions.js\":\"e8ecc8aa6e3ef177\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/facet.js\":\"44b43572236ef36f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/index.js\":\"157d166da85bcddf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/shortcuts.js\":\"ab4cd0823b254deb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/toggleStore.js\":\"01e62bf05044a43d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/MergePicker.js\":\"a3450ffb7d587c74\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/index.js\":\"2e3a391dc5db586b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/mergeAction.js\":\"7cde837ed136a4ca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/strategy.js\":\"bc1c4b9bae92fa6e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/Button.js\":\"8d91fbe10fdb69c6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e8e2c1c9cf3991e5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ea3bd8cb5ba25f1e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/facet.js\":\"3b156bed79a5b008\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/index.js\":\"fe828bde2e1648a6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4628f463acb94b44\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/actions.js\":\"b3c8070240b37ca3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c97d9f02ebb2fe72\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ccc075d7dbd2e6b2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/index.js\":\"dad9fce1d96fdec7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/MoveDestinationPicker.js\":\"08cf2e266da3fd99\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fb44ac904d681657\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/contextMenuItem.js\":\"51ec812d8528089e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/index.js\":\"84ef88220eb57686\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/moveAction.js\":\"a59dac943902b4c5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/moveBlocks.js\":\"17651a25ca5205e1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/selectionAfterMove.js\":\"99cdf8f55da673ea\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/TutorialBanner.js\":\"faf86802e6cb8cce\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/action.js\":\"023c05e99c2d0a6a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/bannerDismissal.js\":\"664bcb354e2a9266\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/documents/cheatSheet.js\":\"68a4c7d4f8b3e4b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/index.js\":\"b29636b3edd2438b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/keys.js\":\"63a9a09740703f81\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/landing.js\":\"1fd1c3616863fee0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/outline.js\":\"8d1a9c2abca495c1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/seed.js\":\"62473bb5d762445c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2c626fcbf9f42acd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/analyze.js\":\"1c395c377cc4a2dc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/diagnosticsSource.js\":\"5ac0d620f1566d7d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/index.js\":\"7c930013a15a522a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/load.js\":\"5568b357da6fa577\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/monitorRun.js\":\"66ed59f76e7632f3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/schedule.js\":\"ffbf3252fb9efc0a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/series.js\":\"a99e36800be07515\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/store.js\":\"7f4dab642f99b024\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/trendAction.js\":\"49d92174f8e84573\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/verdict.js\":\"53778b38ad5e78af\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/plain-outliner/clickToEditAction.js\":\"ad7815471a7b86b2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/plain-outliner/index.js\":\"3f231b001f92c6cc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/plain-outliner/interactions.js\":\"4c703714f83df7c7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7963bcfbba6b9753\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/MigrationGate.js\":\"587dd8b046231a65\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/MigrationGateDialog.js\":\"93cac8fe8e28b6a0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/action.js\":\"47caa5db07458229\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/index.js\":\"4bb967ffd5568717\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/localRunMessage.js\":\"e236a6ed90576c1c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/plugin.js\":\"fda523251a1b81b7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/progressReport.js\":\"a6ddf0460220db5b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/sweepProgress.js\":\"fb46bd35d805e2c9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/FieldRowRenderer.js\":\"c24507737fa9186a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/ValueRowRenderer.js\":\"03f112aed7c9cfe0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/actions.js\":\"75f46f4e9432c012\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/autocomplete.js\":\"39c00ae97db3af2e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/fieldRow.js\":\"720d8da1ecd7e1a4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/index.js\":\"c49bdfd106faa192\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/referenceWarning.js\":\"73270915cd89ad9a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/valueAutocomplete.js\":\"16544630bcf9dec4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/valueSchema.js\":\"951247e3583f2e62\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/HeaderItem.js\":\"ce0f079b9983d209\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/QuickFind.js\":\"0a444cf9519b4cf3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/index.js\":\"a12294ac6ad0fbcd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/recents.js\":\"18a0306a084ea9e9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/resultItems.js\":\"1f0bcc841bc9c225\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/selection.js\":\"e1252114713ac4ca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/toggleStore.js\":\"a47c326bd7e53bda\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/HeaderItem.js\":\"8ec27287b232ce0d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5aefb32f424f7abf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/grouping.js\":\"2b0094c967ee6fb8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/index.js\":\"e2b55197a4753841\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/target.js\":\"20a78098cf93a95f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/codeMirrorExtensions.js\":\"65d7fea34534222c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/contentPrefill.js\":\"21e6ff55ac3c5bdd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/dataExtension.js\":\"5606dddf7a6ee915\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/index.js\":\"41667734bfee4052\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cb3f3c1209d1b293\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/invalidation.js\":\"b273991a4e54b71e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/localSchema.js\":\"f881bcadbb5b4dab\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/blockrefs/index.js\":\"4483a64ca79d3b71\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"115f14cb8a196089\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/index.js\":\"8a27fea168655f79\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/referenceNode.js\":\"2edfb27e12f48bbf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d636302171b17f8c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"95b282fc5ac6d3f5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/index.js\":\"94b0268e9a96d3e8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b4d458928d6c652b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d896b70fac09f9d9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/mergeRetargetProcessor.js\":\"803d97dad3dd7c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/parseFence.js\":\"d84812eea2c76c99\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/referenceParser.js\":\"9ea706407ae70a4e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/referenceProjection.js\":\"edeacdf0db527b42\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/referencesProcessor.js\":\"c2f45f6dc52c5288\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/renameProcessor.js\":\"ac2012691cf6ad5e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/spanReplacement.js\":\"b9b6df47d09daefd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/htmlToOutline.js\":\"0e3472c522403adc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/index.js\":\"39a07a46e430ee4b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fa28fb0cc8657944\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/pasteDecision.js\":\"db5d8ddf260914ef\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/action.js\":\"9378687b88881a1f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/blockIds.js\":\"94b4c9aa39bd2cca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/content.js\":\"ce18184962fecbba\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/effect.js\":\"66169af38795fd7e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/ids.js\":\"82fe74515a833cbc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/import.js\":\"388842b2002ca60c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/index.js\":\"02c3e948b8d4fb97\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/plan.js\":\"6c3c83cccb1c3291\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/plugin.js\":\"a1c770ac4b6ee27f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/promotion.js\":\"344de1c988138bc1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/properties.js\":\"fc13356dddc46550\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/references.js\":\"865fdc96e464abe7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/report.js\":\"a375ca9dfe9c9032\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/roamMemo.js\":\"8381f75818333253\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/runtime.js\":\"7754ec2ae625206a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/schemaReconciliation.js\":\"64d405c2d42bd3ed\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/srsMarkers.js\":\"530e40911edcb26c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/todo.js\":\"513ef969b07f5440\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/typeCandidates.js\":\"d658becaffcb23a9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/types.js\":\"a327f96468dd9163\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/search-health/index.js\":\"c5e1fc6f59539c65\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/search-health/store.js\":\"eaf81041a1718a2c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/HeaderItem.js\":\"b0718afb8c3c00bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7112cbfae8d8c49b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/index.js\":\"e5a7d33ec80168de\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/model.js\":\"060d86bcea490428\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/toggleStore.js\":\"cb2c8bc01bd45b05\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/useKeyInspector.js\":\"a451293eda6e4ca3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d1d534bb19ca9b05\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/ShellDecorator.js\":\"c7d05eea841ea6bf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/actions.js\":\"b2b38ba2055e14c6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/exclusionsFacet.js\":\"85d4e6f0784c7540\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/index.js\":\"c53f54cc180cbd3c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/shell.js\":\"73006385dc25862c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/surface.js\":\"398e6baac8131463\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/walker.js\":\"83170cc59a39b52e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dcd4a355d33f5e43\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/dataExtension.js\":\"b0fbb7487e92bd5e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/index.js\":\"8bcdcd081c49a34c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/indicator.js\":\"60e9bcfb0ab0dc9f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/moveSrsState.js\":\"4b27ceea6441c1b2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c0ab67cb22e0a7ca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/scheduler.js\":\"a464e65553674283\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/schema.js\":\"70c205588777e141\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ae6fe88815d14a45\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/srsClipboard.js\":\"fe40a3a3107c52bf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"68be3e8c869a72d3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e6757215f4fa8f6b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/DeckPicker.js\":\"d1e0e1edf8038762\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/ReviewControls.js\":\"73b5ed9ce5f0549a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1209af1ec8cf4102\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/ReviewSession.js\":\"6bf4d2d2e18d5fed\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/actions.js\":\"1aca0ea67d6d292f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/archive.js\":\"88bc7383c9101c00\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/dataExtension.js\":\"b90ed3b243bb9914\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/deck.js\":\"7a17b83cb80c2f9d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/dueQuery.js\":\"e612cba5b3a1072a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/gradeDecision.js\":\"dbcb7ad77459e71d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/index.js\":\"639c1ee50f8c06b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/keyHints.js\":\"49ac40a97a51ffe6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/reviewCardLayout.js\":\"e6bc597edccdbe93\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/reviewProgress.js\":\"506b5efeb6b3b648\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/schema.js\":\"0d475365715f94b5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/useDueCards.js\":\"64559d5bb24ef87f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/startup-metrics/index.js\":\"b120b951432728da\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/startup-metrics/record.js\":\"e4caf490d6cf3ebc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/storage-persistence/index.js\":\"e438262be2842ec6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/storage-persistence/persistenceStatus.js\":\"ec4f11bfc8e73aeb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/storage-persistence/requestAction.js\":\"c7736b7746769399\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/TypeChipsDecorator.js\":\"640271375c27f06c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/codeMirrorExtensions.js\":\"04f37e103409987e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/index.js\":\"2ad2bfffd683e508\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/typeAutocomplete.js\":\"7c7d358b5f88f6f2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0df32f4cbd4a2702\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/actions.js\":\"07891fd673886330\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/anchor.js\":\"528231bd23db2a01\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/events.js\":\"ba80f299e3421bf4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/gestureActions.js\":\"dc48d1578fa16732\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/index.js\":\"08bf0eaf7755852d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"18db01055cb57c2a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/sync-metrics/collect.js\":\"837c180cd23e9f62\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/sync-metrics/index.js\":\"beb6da50e2bb50f2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/sync-metrics/record.js\":\"3bb2efe14c55de6e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/RejectionDialog.js\":\"a5beb47f67d943ff\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1ff7873c56cda180\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/index.js\":\"4849df1e261ce6bf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/model.js\":\"5c8f34e44e88eae0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/queueCounts.js\":\"a4a2689e76003685\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/rejectedHelpers.js\":\"d98bf617b74932c5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/rematerializeAction.js\":\"32e7b46e4d82c881\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/useHysteresis.js\":\"2c93a2f417438c7f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/ColumnHeaders.js\":\"1aaf0185b177b478\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/QueryUi.js\":\"37aee413456de312\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/TableLayout.js\":\"89a99a8536c63eb8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/actions.js\":\"8684eedafb66751e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/cellEdits.js\":\"28fd6501fdc9b79e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/columns.js\":\"c8810a08b37959b3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/controller.js\":\"9842a10aa216d955\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/convert.js\":\"8f1e1480b7ba5120\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/dataExtension.js\":\"3afcd783c95bc685\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/index.js\":\"b05538b1e7adc9dd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/keys.js\":\"5c51474110c878e9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/model.js\":\"7431e3228fac91ac\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/navigation.js\":\"057ea07f6f83700c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/backfill.js\":\"d5e13ce8e6b6b789\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/completion.js\":\"4d84d5c5dd094618\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/format.js\":\"f036c7fedd81f66d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/parse.js\":\"fbb3b4935765022c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/queryValue.js\":\"7a593b2d220f21c3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/source.js\":\"944b9097b9698448\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/registry.js\":\"bb6e004b0d6c40bb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/rowGutter.js\":\"597a9f0d4a67db70\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/rowVerbs.js\":\"85735f243ee26fb9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/schema.js\":\"c76e56efe7e0bc7d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/sort.js\":\"c08a90abc0223358\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/theme-toggle/effect.js\":\"65ccedae5750a231\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/theme-toggle/index.js\":\"a7332b1530a29d92\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/theme-toggle/theme.js\":\"cb4affaae503ca4c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/actions.js\":\"ebfa3d4feb23476c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/dataExtension.js\":\"77bb6eb011166ab6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/index.js\":\"e6d1c6dd9286948c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/schema.js\":\"e11405163907f0b1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/TouchSelectionLayer.js\":\"04ae0427d3b563d2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/actions.js\":\"ff2346e9421648f9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/defaultItems.js\":\"25ca833472c98238\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/facet.js\":\"981d890e85b48229\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/holdRecognizer.js\":\"4311f588f2c2b2f3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/index.js\":\"980fe635ca6e0584\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/update-indicator/UpdateIndicator.js\":\"abc8838e411d86d2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/update-indicator/index.js\":\"933157d856a0f65e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/update-indicator/loadTimes.js\":\"cc510336e624a5b2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/VideoNotesRenderer.js\":\"129e3d5fffbd7a98\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/VideoPlayerRenderer.js\":\"57c66f6156381cd8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/VideoTimeStamp.js\":\"9bee8a598a0e7518\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/actions.js\":\"372b1a71dadff9fb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/index.js\":\"83613bbb540cb5f3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/markdown.js\":\"d404479e9291910f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/notes.js\":\"892a3740177e3661\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/registry.js\":\"bf70dc320fb2e6e9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/remark-timestamps.js\":\"b975a5bd228bf2eb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/view.js\":\"22ff6c8985367f8a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/LinkHints.js\":\"973a26aa983fdc02\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/index.js\":\"a0b4a9d394894ff3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/model.js\":\"b41ba672eb351fb5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/settings.js\":\"a533de71034676ee\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-normal-mode/actions.js\":\"e5191b5f553e25e7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-normal-mode/index.js\":\"2736ad9d6a721b6e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-normal-mode/interactions.js\":\"1ee546922fff42f4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/workspace-header/index.js\":\"13127839c8d1cc28\",\"/knowledge-medium/pr-preview/pr-1865/src/registerServiceWorker.js\":\"0d47d75e320a0216\",\"/knowledge-medium/pr-preview/pr-1865/src/requestPersistentStorage.js\":\"450efa76382606b0\",\"/knowledge-medium/pr-preview/pr-1865/src/services/authRequestDeadline.js\":\"8c68e90a6bbe004a\",\"/knowledge-medium/pr-preview/pr-1865/src/services/authStorage.js\":\"60acfaeb6f2d18f8\",\"/knowledge-medium/pr-preview/pr-1865/src/services/powersync.js\":\"f6836294125bc7b0\",\"/knowledge-medium/pr-preview/pr-1865/src/services/supabase.js\":\"ad583e68a8f8b772\",\"/knowledge-medium/pr-preview/pr-1865/src/services/uploadErrorClassifier.js\":\"649b53230452c7e2\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/ActiveContexts.js\":\"0d2f669370cfaa32\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/HotkeyReconciler.js\":\"e991091d40877703\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/WipeLocalDataDialog.js\":\"bcadfd1718cc7c78\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/actionDispatch.js\":\"5d647ff9519ed32c\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/actionRefItems.js\":\"02174dec77ca80a4\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/applyKeybindingOverrides.js\":\"cf9192ddc1734864\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/blockActions.js\":\"de96ecc4784fece6\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/blockMergeGesture.js\":\"e3d43bf45ea03446\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/canonicalizeChord.js\":\"609bc7be9e9994f5\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/defaultContexts.js\":\"746ce9159a6ff6ae\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/defaultShortcuts.js\":\"5d2e031ef99945cc\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/effectiveActions.js\":\"8fa50c30277a0b9b\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/gestureAction.js\":\"7d63b54f0a481cb0\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/gestureBinding.js\":\"027d785d2a735822\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/holdRegistry.js\":\"d79e1ca83242f54e\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/keybindingConflicts.js\":\"a5beb48518eba17b\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/keybindingOverrides.js\":\"d6c51fcd391ec732\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/pointerAction.js\":\"71290b7cec24b4c6\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/resolve.js\":\"2983c31518a44d5e\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/runAction.js\":\"860a8b310ec84102\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/sequenceMatcher.js\":\"8173c01d94308d77\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/types.js\":\"f3966071a46d7029\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/useActionContext.js\":\"e60b6e5913c145cd\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/useActionDiscovery.js\":\"ac3c00e84c938f9e\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/utils.js\":\"15df0a58087a28ca\",\"/knowledge-medium/pr-preview/pr-1865/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1865/src/sw/bootStore.js\":\"64c964aec4e65dce\",\"/knowledge-medium/pr-preview/pr-1865/src/sw/previewDatabases.js\":\"741b05d6bc0853a0\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/byteTransform.js\":\"66823d5d327a5c90\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/attachmentCleaner.js\":\"02119d0e056b1c04\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/attachmentParts.js\":\"a5f775a22a180dc2\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/bundleParts.js\":\"66f50ea34ea663bc\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/bundleRecord.js\":\"30ab56e7751943ec\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/manifest.js\":\"9fa719945cf79ecf\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/takeBundle.js\":\"896ab0c4a1123ed5\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/verifyBundle.js\":\"f21214a5419e1690\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/cleaningStage.js\":\"24de7afb54b5db56\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/conversionKey.js\":\"97d6293bd877272e\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/conversionServer.js\":\"fdaec3a03a1e2c7f\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/flip.js\":\"dbffb83b53b5782f\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/flipAttempts.js\":\"014c9f1e8ef59d4a\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/pages.js\":\"ef75b77c7558613a\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/preflight.js\":\"26990d9f913593ba\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/reseal.js\":\"c65cf4b3b0485853\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/runConversion.js\":\"8a51ff889674262f\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/runLock.js\":\"c99ecf0a1aae30aa\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/sealing.js\":\"c616220a13dbb6e6\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/sealingStage.js\":\"9411c2669198c787\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/stage.js\":\"65ea1a3266d601b9\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/verifyReseal.js\":\"79f26d8b6c2863de\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/aad.js\":\"9b330178f116d7ba\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/aead.js\":\"31de7cd6632b0a76\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/base32.js\":\"035877ecef8a0281\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/base64url.js\":\"16efc965c22922f0\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/binaryEnvelope.js\":\"62cee9cc1b5d9b56\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/byteAead.js\":\"55bd0c96d2a1ec3c\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/canary.js\":\"d7e622dadc4479bb\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/contentHash.js\":\"ed80ff36ef032d4b\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/contentKey.js\":\"262664678a222755\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/derivedIdNamespace.js\":\"b155c8a21810fb70\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/envelope.js\":\"97f47f9d5990b790\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/hex.js\":\"a7cc03f9ce9c423c\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/sha256Hex.js\":\"852c5136cbf2ac59\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/workspaceKey.js\":\"174a6766fe1f9f10\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/conversionState.js\":\"5839fadb80fa6af6\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/createEncryptedWorkspace.js\":\"17fa17289acafff5\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/pastedKey.js\":\"c68909266a52b20e\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"07b7ae85d9aeec50\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3b9ee1dcbda9d0a0\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/keyStore.js\":\"32e637d9e227da85\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/mintWorkspaceKey.js\":\"76f3f2695dd99d01\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/modePin.js\":\"4015175e5dceb647\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/openWorkspaceKeys.js\":\"e4a790ce989fae90\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/resolveWorkspaceEntry.js\":\"6cde8c188ef9ea91\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/resolver.js\":\"aedde6cd32a56fec\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/workspaceAccess.js\":\"9500d3cd45f1c738\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/transform.js\":\"bef6328e36cb8117\",\"/knowledge-medium/pr-preview/pr-1865/src/themeBootDefaults.js\":\"368f4ee86cd1bf10\",\"/knowledge-medium/pr-preview/pr-1865/src/types.js\":\"c306da967cb5a681\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/ClientLocalSettings.js\":\"bfc20d85d6712717\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/abortableSleep.js\":\"d8cc2048dbce849c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/array.js\":\"09fb08bfdfd0a465\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/backlinkAutocomplete.js\":\"9288eee59f5b703f\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/blockCrumbs.js\":\"6185303665b3e260\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/blockrefAutocomplete.js\":\"6345a961b5c553e3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/cadencedIdleJob.js\":\"cb5f278d14ebf6f9\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/callbackSet.js\":\"f3f7b7be9dc86b68\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/clientId.js\":\"35719d875b13106c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/codemirror.js\":\"40d651b0f466a31c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/codemirrorCompletion.js\":\"d79bc08a908f3897\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/copy.js\":\"6b858049c8d9bcd6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dailyPage.js\":\"18d89962fa895adf\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dbForensics.js\":\"b2a92ffc21c9f796\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dbForensicsHooks.js\":\"bd1d9eef412bd2e1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/deleteBlockThroughUi.js\":\"7f49ac440e240b20\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dialogs.js\":\"f1b1bfef5df41c17\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dom.js\":\"528dc0e31456820f\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/downloadBlob.js\":\"68fbb85ffc8e9588\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/exportSqliteDb.js\":\"68d2e511f531ba1a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/fileSystemAccess.js\":\"243b8b39b191f646\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/flipSlide.js\":\"0a616d6637563a1d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/fnv1a.js\":\"f022083c4b4f537a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/formatBytes.js\":\"c30478c43a8e13ab\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/fuzzyRank.js\":\"e95f533a3df18c54\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/idbKeyedStore.js\":\"38637ecf81bee91a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/idleCallbackPolyfill.js\":\"99c0074ea1f78ae6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/keyboardAwareScroll.js\":\"c73ae5f2a2015278\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/keyboardViewport.js\":\"2601f2a9a9b6734d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/lastWorkspace.js\":\"1f0a265f560001fb\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/layoutColumns.js\":\"608c67a0a9b2b972\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/layoutSessionDom.js\":\"efd3abad5d46b920\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/layoutSessionId.js\":\"2d22043c34941555\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/linkClickGestures.js\":\"1249102d409ef087\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/linkTargetAutocomplete.js\":\"4e1c134016b70b5f\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/localDbCorruption.js\":\"c629326f04343767\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/localDbRecovery.js\":\"f5cfee1e0c7f867d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/markdownParser.js\":\"cbff462620d15902\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/memoize.js\":\"ca161b0693eb98c8\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/nameFieldCommit.js\":\"aa752e64540962b4\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/nameList.js\":\"df13cc5cd7045302\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/navigation.js\":\"954f99b2f4ac1c1c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/omnilinerNamespace.js\":\"e1877a502f2cecd3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/opfsPageScan.js\":\"99ac41896cd546ba\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelClearance.js\":\"0b63962112f65fbc\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelHistory.js\":\"db87eb12d911a267\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelLanes.js\":\"9b01a9da5432e6e5\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelLayoutProjection.js\":\"65a99dddf2560898\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelScrollAnchor.js\":\"835b0325d8c01389\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelUrlFlags.js\":\"b1ba2d19db39a07c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/platform.js\":\"6f87240e85bc92c0\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/pluralize.js\":\"7fc0ac4df8eca043\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/propertyCreation.js\":\"81584548f371022a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/propertyNavigation.js\":\"851b8b5da86b1985\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/propertyValueContext.js\":\"e8601cf8079cfa4c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/react.js\":\"cdc7412ac30d5c4a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/relativeDate.js\":\"dda343d4780c0f68\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/relativeTime.js\":\"63b8d016480e0cf2\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/renderScope.js\":\"73a6cd3a2c9ed3f1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/resolvedThenable.js\":\"d78738d3ac68143c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/routing.js\":\"4c47125fc6a7833d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/safeMode.js\":\"58c59cc2fd4c7416\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/scheduleIdle.js\":\"2f8502a83c101931\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/screenWakeLock.js\":\"a555c946d788216d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/selection.js\":\"a4e4cbee614ddb5d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/softKeyboardGrab.js\":\"5fb75df0d1cfbfd9\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/startupTimeline.js\":\"da17d59d95372fc1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/state.js\":\"4f415177dd03faa0\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/string.js\":\"200dda88d712c7b0\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/surfaceZoom.js\":\"e4826a394707d28a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/time.js\":\"7886beac13161812\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/toast.js\":\"fd0f924dd0ffc3e2\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/toggleStore.js\":\"bf6281d60119281e\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/untilStopped.js\":\"cd47120d7b7db60e\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/userActivity.js\":\"7c7de9973ba415e8\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/viewTransition.js\":\"44bd5bf6835d29f6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/viewport.js\":\"93f4d99de68500df\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/webLock.js\":\"869c3762438050bf\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/workspaceRecovery.js\":\"7ccaa204e4156d13\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/workspaceSnapshotStore.js\":\"6af0669430f87009\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-compiler-runtime.js\":\"487448f053fcbd55\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-client.js\":\"076ced9b0ed477dc\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-server-edge.js\":\"19e3051220f7dbc5\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-server.js\":\"ac4caf41e0c7a3a3\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-static-edge.js\":\"25c7122acf7aa42d\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-static.js\":\"8abbc0bdc8521640\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-test-utils.js\":\"d102252f1ad6deed\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom.js\":\"df59c79f51380a5b\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-jsx-runtime.js\":\"6e62eb793cbd3eb7\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react.js\":\"776b210fa3cca6be\",\"/knowledge-medium/pr-preview/pr-1865/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1865/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1865/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
