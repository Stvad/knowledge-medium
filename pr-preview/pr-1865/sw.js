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
		buildId: "4249ebe411a8-9cf012cf",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1865/\":\"1807a33f61385109\",\"/knowledge-medium/pr-preview/pr-1865/index.html\":\"1807a33f61385109\",\"/knowledge-medium/pr-preview/pr-1865/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1865/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1865/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1865/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1865/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1865/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1865/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1865/assets/FacadeVFS-Q1J3QSOd.js\":\"e96b2be8b277cf37\",\"/knowledge-medium/pr-preview/pr-1865/assets/OPFSCoopSyncVFS-JvhznRK9.js\":\"0ff5706de261e160\",\"/knowledge-medium/pr-preview/pr-1865/assets/OPFSWriteAheadVFS-B_UxIWCv.js\":\"ebe51a2d2d988a68\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-XrVujZc3.js\":\"f0a66e9d9fdb764d\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1865/assets/wa-sqlite-async-BDgFcvcJ.js\":\"9e4a9da0131d6427\",\"/knowledge-medium/pr-preview/pr-1865/assets/worker-CTi3M2HQ.js\":\"6cccf577af50ac93\",\"/knowledge-medium/pr-preview/pr-1865/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1865/chunks/app-lQM9KZV3.js\":\"68e87840e34cab2d\",\"/knowledge-medium/pr-preview/pr-1865/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1865/index.js\":\"c2120fe716ad3dee\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1865/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1865/assets/AccessHandlePoolVFS-CbEdricE.js\":\"7a0944adc499a397\",\"/knowledge-medium/pr-preview/pr-1865/assets/IDBBatchAtomicVFS-DFvnpy4I.js\":\"8c14405cdcd4e8ad\",\"/knowledge-medium/pr-preview/pr-1865/assets/MemoryVFS-BzMnQtI4.js\":\"57e7e8f1795a9e1d\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-DqS93zm4.js\":\"818c97965d26f3f3\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1865/assets/mc-wa-sqlite-async-oNwjye6n.js\":\"f082c28b54ac9ac8\",\"/knowledge-medium/pr-preview/pr-1865/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1865/chunks/AccessHandlePoolVFS-CoiGyXhP.js\":\"45659cddffaac442\",\"/knowledge-medium/pr-preview/pr-1865/chunks/FacadeVFS-DOWe5Lfb.js\":\"3e160838a8d8703c\",\"/knowledge-medium/pr-preview/pr-1865/chunks/IDBBatchAtomicVFS-Pab2EyDt.js\":\"46963429f6d19474\",\"/knowledge-medium/pr-preview/pr-1865/chunks/MemoryVFS-DAN1vJu8.js\":\"467a44656b1e53ea\",\"/knowledge-medium/pr-preview/pr-1865/chunks/OPFSCoopSyncVFS-Dfy1lkDl.js\":\"40b07757a0a12cea\",\"/knowledge-medium/pr-preview/pr-1865/chunks/OPFSWriteAheadVFS-CHeevw0u.js\":\"779109dd9151e578\",\"/knowledge-medium/pr-preview/pr-1865/chunks/Preview-kU2etHIB.js\":\"c2b9b23612cc83f0\",\"/knowledge-medium/pr-preview/pr-1865/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1865/chunks/card-DMhbyDnf.js\":\"bf25a3a3e3d73c58\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1865/chunks/dist-CxQmZoRU.js\":\"312a265882b7ffce\",\"/knowledge-medium/pr-preview/pr-1865/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1865/chunks/mc-wa-sqlite-CYiXoAHX.js\":\"c3d1a3588483fa67\",\"/knowledge-medium/pr-preview/pr-1865/chunks/mc-wa-sqlite-async-TsAhNX5x.js\":\"a6526d183b63f2cf\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-BFOP1nbU.js\":\"8998b0f9b231c919\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-BIOgKqvn.js\":\"98680af19165f1bd\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-CtqwBRA1.js\":\"e12746c7e46626eb\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-Ds_37nAx.js\":\"b7d7868eaf596154\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-dom-server-legacy.browser.production-2D309Epn.js\":\"2b652e8878dc6a27\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-dom-server.browser.production-Brx3VV5v.js\":\"d61dd3eec907fe89\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-dom-server.edge.production-pHklsFXs.js\":\"462a6fd980d32641\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-ei8W4Piw.js\":\"36c21c6aac7bb719\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-ixaOJ_3b.js\":\"c77bf3040e5a552e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-rNITxIeW.js\":\"0d0a550aca499001\",\"/knowledge-medium/pr-preview/pr-1865/chunks/react-uO23uZts.js\":\"ddbdf5ed02d1ba0e\",\"/knowledge-medium/pr-preview/pr-1865/chunks/server.browser-BepQVBD4.js\":\"6a028b57e0564e40\",\"/knowledge-medium/pr-preview/pr-1865/chunks/textarea-FgAgTu0m.js\":\"6e91e1aa5f5ba2a6\",\"/knowledge-medium/pr-preview/pr-1865/chunks/ui-BuJejbpg.js\":\"0d7d5e4e7aa9c6e4\",\"/knowledge-medium/pr-preview/pr-1865/chunks/wa-sqlite-BB-E8SjX.js\":\"9a51e774c98da307\",\"/knowledge-medium/pr-preview/pr-1865/chunks/wa-sqlite-async-B3IxMjbo.js\":\"6450312a405862a4\",\"/knowledge-medium/pr-preview/pr-1865/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1865/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1865/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1865/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1865/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1865/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1865/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1865/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1865/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1865/src/App.js\":\"c5bf34d5eb8163db\",\"/knowledge-medium/pr-preview/pr-1865/src/appUpdate.js\":\"8048473610faf4d1\",\"/knowledge-medium/pr-preview/pr-1865/src/appVersion.js\":\"57d12c014fa1bd45\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/initialLayout.js\":\"6402a5569d8c87d6\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/openWorkspaceData.js\":\"0ca9d970e9b111c6\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/resolveWorkspace.js\":\"f75519053775277b\",\"/knowledge-medium/pr-preview/pr-1865/src/bootstrap/workspaceBootstrap.js\":\"1fa83a4e212cbc33\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockComponent.js\":\"cff07542255d976f\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockCrumbs.js\":\"306fbc9ded3e1685\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockEditor.js\":\"4a54db34609bc81a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockLoadingPlaceholder.js\":\"25c9574ff60d9c5a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockProperties.js\":\"4cabb0787649d610\",\"/knowledge-medium/pr-preview/pr-1865/src/components/BlockSearchPicker.js\":\"bc1a2e9f5b186707\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ConfirmBulkDeleteDialog.js\":\"c29f265d7acc077a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/DividerHandle.js\":\"ea7d553a498d576f\",\"/knowledge-medium/pr-preview/pr-1865/src/components/DraftEditor.js\":\"e7f4a1bb21ac72f9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/GutterPill.js\":\"12e2f6161bd0fe0c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/Header.js\":\"fd646e6ae8b8850d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/LazyBlockComponent.js\":\"d05c0a701b07931b\",\"/knowledge-medium/pr-preview/pr-1865/src/components/Login.js\":\"cab3c363b11abebe\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ZoomableSurface.js\":\"ed377a5190f47a18\",\"/knowledge-medium/pr-preview/pr-1865/src/components/editModeKeepalive.js\":\"4af9628e18d1303a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b745c541674fd351\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ccbf76f343088694\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/RefPropertyEditor.js\":\"416a13feda0b3ec6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/RefTargetTypePicker.js\":\"49cfa3333da31134\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/SelectPropertyEditor.js\":\"bfc8a371b9c5a4f1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/TypesPropertyEditor.js\":\"26508d08a9f6738c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/defaults.js\":\"5a38adb96b93f750\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/kernelValuePresets.js\":\"19f1816a7ee8c875\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/selectablePresets.js\":\"e9813044dc42f034\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyEditors/typesPropertyUi.js\":\"d582d5e84bf1e3ac\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/AddPropertyForm.js\":\"817f5e0171ca19a9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/PropertyPicker.js\":\"abcc10361b00ecef\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/PropertyRow.js\":\"694a8759d2aab8eb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/Rows.js\":\"7d6c041b7558d65a\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/actions.js\":\"cde0c3a892b14818\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/declarationOnly.js\":\"9c1d2927fec835c6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/layout.js\":\"28b7ead3cfa341ce\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/model.js\":\"0fef0b2b43acdfca\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/shapeUi.js\":\"de850967d0e866b9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/shapes.js\":\"dc11458b58c259d7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5c1f5b99108f5c30\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanel/visibility.js\":\"3c741092e4dcab7c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/propertyPanelSections.js\":\"c7d3c6dce22e51ab\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/BlockEmbed.js\":\"210ea95ad435a396\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/BlockLink.js\":\"1084f2e5b90eaa66\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/BlockRef.js\":\"34e37f39a5a9d651\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/ReferenceLink.js\":\"0dc56900a39ccc6e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/cycleGuard.js\":\"8c79c3b712653fa5\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/cycleGuardContext.js\":\"d24334641f384b03\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/linkInteraction.js\":\"26b99655311ec7b7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/referenceLayout.js\":\"ee1ff8b4d4039646\",\"/knowledge-medium/pr-preview/pr-1865/src/components/references/useBlockRefAncestors.js\":\"67c5c9cb290a22b2\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BlockGutter.js\":\"6055b9f6dfbea530\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BlockInfoDialog.js\":\"93b8ddf89080dffb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BlockTypeBlockRenderer.js\":\"cad5dd19977a1ee7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/BulletHoverCard.js\":\"d6fb750ca6e7e864\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/CodeMirrorContentRenderer.js\":\"f9b6cd96d1a779c4\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2c7e9a31438688ca\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/ColumnResizeHandles.js\":\"e972070c08b513bf\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2f38dd9a0c0b007d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/DefaultBlockRenderer.js\":\"8cde2ecd8e724959\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/LayoutRenderer.js\":\"25f9fc5aa4ce17b6\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/MarkdownContentRenderer.js\":\"1460a36f6505696c\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/MissingDataRenderer.js\":\"2f17bbe25f1e217e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/PanelRenderer.js\":\"b35b80ab159e9981\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/PropertySchemaBlockRenderer.js\":\"08bc9fdc2a1d0413\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/TopLevelRenderer.js\":\"ec2c673cd7b07ef0\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/blockGutterMode.js\":\"3656838361094177\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/blockTitleText.js\":\"fc4d0245bde0cfd3\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/fieldCreationKeydown.js\":\"1d507aa375f7d19e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/renderer/layoutRootContext.js\":\"b3c1aef676411ad1\",\"/knowledge-medium/pr-preview/pr-1865/src/components/typeChip/TypeChip.js\":\"b30de1acbd533155\",\"/knowledge-medium/pr-preview/pr-1865/src/components/typeChip/chipStyle.js\":\"146108fda41e54c9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/anchored-floating.js\":\"f1e8fae14f03bdaa\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/button.js\":\"37ee1f199b1d8594\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/card.js\":\"4acd6544f09f37d3\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/checkbox.js\":\"2d3b17f2a17efac2\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/collapsible.js\":\"bcc78abc8a1af2ec\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/command.js\":\"36e062ac50545cb5\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/context-menu.js\":\"82bda0624bd4f693\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/dialog.js\":\"ac816c7e18934edb\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/dropdown-menu.js\":\"8a093b7942cfa646\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/floating-listbox.js\":\"d9a6f47bc92fae4d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/index.js\":\"98b1b54b20b755dd\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/input.js\":\"02485649918c4f3e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/kbd.js\":\"8f54ef55bd9b6288\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/label.js\":\"166c255464602d49\",\"/knowledge-medium/pr-preview/pr-1865/src/components/ui/textarea.js\":\"e7a81643a3a715df\",\"/knowledge-medium/pr-preview/pr-1865/src/components/useEditModeYieldKeepalive.js\":\"4e6a48ae0e84a902\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/BootFallback.js\":\"e4af7a47bbe0f3c4\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/FocusedRowLazyMount.js\":\"1200bc45541f7761\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/LazyViewportMount.js\":\"66680fc85297bc76\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/LocalDbCorruptionFallback.js\":\"ad11d02354e05389\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/error.js\":\"6d81192ebb03c40e\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/lazyMountRegistry.js\":\"3684d0353a379808\",\"/knowledge-medium/pr-preview/pr-1865/src/components/util/suspense.js\":\"25621c9ea9a7b487\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/CreateWorkspaceDialog.js\":\"81c861787559b306\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/PendingInvitations.js\":\"b18d69792471dbcc\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/SyncProgress.js\":\"ca889c32d1ef30a7\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/UnlockProgress.js\":\"1074cfe81ef50057\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceKeyGate.js\":\"6d31ed599c960687\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceSettingsDialog.js\":\"066575b1c4c4e521\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceSwitcher.js\":\"02baaca009cf6845\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/WorkspaceSyncGate.js\":\"e2ebc82e2bbaafa0\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/ConversionFlow.js\":\"7e6183590d642b2d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/ConversionFlowHost.js\":\"52a68cf37c02e1ca\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/EncryptionSection.js\":\"1bed2664737f77a4\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/attachmentPrompts.js\":\"e6fe696f76ca1e08\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b989792d562b9887\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/conversionFlowDeps.js\":\"b33c2ad8c210c2f2\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/conversionFlowStore.js\":\"5a9ff412fd41d9e8\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/flowUi.js\":\"c7600dc54446996d\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/conversion/useConversionRun.js\":\"bb01ffbff37551ae\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/keyUi.js\":\"33e0733118b7ebb9\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/useCloseOnKeyLoss.js\":\"d902c32c9c84b905\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/useCloseOnServerE2ee.js\":\"aba694fe9fd52dfa\",\"/knowledge-medium/pr-preview/pr-1865/src/components/workspace/workspaceUnlocked.js\":\"335e8a9f6e25a4f2\",\"/knowledge-medium/pr-preview/pr-1865/src/context/backgroundSubtree.js\":\"dfa5c34cdfc17935\",\"/knowledge-medium/pr-preview/pr-1865/src/context/block.js\":\"265717d2c3c230a9\",\"/knowledge-medium/pr-preview/pr-1865/src/context/layoutWsContext.js\":\"fe0ce3420dcfafc5\",\"/knowledge-medium/pr-preview/pr-1865/src/context/propertyDisplay.js\":\"ba15b13c75b36ef6\",\"/knowledge-medium/pr-preview/pr-1865/src/context/repo.js\":\"1cb260a5e7b8483e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/aliasClaim.js\":\"f7cc00f4ee38d56f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/aliasSeatNamespace.js\":\"6067bff24b0c6321\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/blockData.js\":\"7212a08f5228d996\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/blockType.js\":\"ec5ee28d607f98c8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/changeScope.js\":\"7aebb823eec68407\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/codecs.js\":\"c00f20fc026c1979\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/derivedData.js\":\"f777f1b6e72f8d32\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/errors.js\":\"85f76cc7237add34\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/events.js\":\"d8212a8062cacd6a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/handle.js\":\"2ef3b72f968470c4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/index.js\":\"14d193f358c28e5d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/mutator.js\":\"7a8c3470d6cfc0f4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/processor.js\":\"7107a53f16d20c7c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/propertySchema.js\":\"74339efd43e01714\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/query.js\":\"7086b25fb780c1d9\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/sameTxProcessor.js\":\"f5d8277651b97f7d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/schema.js\":\"2ef3b72f968470c4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/tx.js\":\"2ef3b72f968470c4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/typedBlockQuery.js\":\"4a5011804287281e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/user.js\":\"af9e7a0dc0ee21a3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/valuePresetCore.js\":\"3071ed8d240182f1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/api/valuePresets.js\":\"2cb5d04ec2011768\",\"/knowledge-medium/pr-preview/pr-1865/src/data/attachmentCleanerIOVerb.js\":\"b5e1b392c8a9e394\",\"/knowledge-medium/pr-preview/pr-1865/src/data/block.js\":\"d6790cba6384084c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockCache.js\":\"37f70f804804f200\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockId.js\":\"35b31607cbe763ff\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockLiveness.js\":\"236b00dac545fece\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockMerge.js\":\"cd7dd5910b013219\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockSchema.js\":\"0b8f216da02d3774\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockTypeLookup.js\":\"bc975743b938877d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/blockTypes.js\":\"d3adbff38c1ea116\",\"/knowledge-medium/pr-preview/pr-1865/src/data/childrenView.js\":\"190a09da8478b4c6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/clientContext.js\":\"12dbd45185fd2023\",\"/knowledge-medium/pr-preview/pr-1865/src/data/dbFileSiblings.js\":\"cada9d53d8f2a66e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/definitionSeeds.js\":\"d93b71623396820f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/derivedIds.js\":\"6e71b385ecf86346\",\"/knowledge-medium/pr-preview/pr-1865/src/data/drawnSubtree.js\":\"14f75cf5f7773782\",\"/knowledge-medium/pr-preview/pr-1865/src/data/facetBridge.js\":\"502446185ae670e5\",\"/knowledge-medium/pr-preview/pr-1865/src/data/facets.js\":\"8c00966bf7de9bfc\",\"/knowledge-medium/pr-preview/pr-1865/src/data/globalState.js\":\"7117cda807d69561\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/aliasClaimRederiveProcessor.js\":\"edca20029103f76b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/ancestorBatch.js\":\"17fab754f78294d5\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/blockTypeTypeifyProcessor.js\":\"2158e424d2219fe2\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/clientSchema.js\":\"8a9f33bbd17ea87a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/commitPipeline.js\":\"219f2c03352efc24\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/devAssertions.js\":\"7fda0887acb2611a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/firstSync.js\":\"ecdcc4d39aef48f4\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/freshInitialLoad.js\":\"2adc4c97f8e4cbf3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/graphBackfillClaim.js\":\"62decacc95641fcf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/handleStore.js\":\"1bfc4851a75e122f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/idleMarkerJobs.js\":\"396eea87f26358c6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/initialDownload.js\":\"39ed8e1ad84b435f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/initializeClientDatabase.js\":\"0a3b0cf9a0ee7ba8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/jsonCanonical.js\":\"fb73ec77611993a5\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/kernelInvalidation.js\":\"af5d0a844ef00b98\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/kernelProcessors.js\":\"7e6b62e2de88180a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/kernelQueries.js\":\"74ef8367b5a6e3d6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/mergeTypeMembershipProcessor.js\":\"a967594c311047ff\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/normalizeReferencesProcessor.js\":\"be75b143f1c715a8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/poolInstrumentation.js\":\"c6ceb0ddd96ecb88\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/processorRunner.js\":\"973bdfe9f8c5d8ec\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyCellBackfill.js\":\"21d754e2753de239\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyChildMint.js\":\"e6a90557412d3794\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyChildrenProcessor.js\":\"f0aa1d906deb5a8c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3e13aebdb928543e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyDefinitionSynthesis.js\":\"b2d03ce38858bafa\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyKeyScan.js\":\"8ac6e4ae8441f1b0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertySchemaResolution.js\":\"af51fcf418103491\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/propertyValueEdits.js\":\"8a43e2623e4ad0c7\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/raiseProtocol.js\":\"3d1cf9da71c61ee3\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/readBatch.js\":\"cc1a806006d2ef5b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/refProjection.js\":\"74f26e60b6f59422\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/referenceTargetLookups.js\":\"d31d33b9bde21775\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/referenceTargetProcessor.js\":\"d90cf8a7e455df71\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/replayMerge.js\":\"cf42e4e106f80edc\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/sqlBinds.js\":\"d570f181a43e0296\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"64e50c0bb13f9c94\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/arrivalProcessors.js\":\"67b48c8cb9a9c026\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/invalidate.js\":\"c3b9f2fd10f20172\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/materialize.js\":\"bf8ef196d1df6c06\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/observer.js\":\"477ec822a369718d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/syncObserver/reconcile.js\":\"4b02c96d370b0d7d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/timingMetrics.js\":\"47fd3fb976b17305\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/treeQueries.js\":\"828233e1a7554ebc\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/txEngine.js\":\"ca7ab4e847938987\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/txSnapshots.js\":\"285719e33eea88b0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/typedBlockQuery.js\":\"7cd94726259b8d56\",\"/knowledge-medium/pr-preview/pr-1865/src/data/internals/undoManager.js\":\"995a9161561ce24c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/invalidation.js\":\"9847a7181308457d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/kernelDataExtension.js\":\"888c58c7a325cb5a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/kernelPage.js\":\"4c36ccaa1016d890\",\"/knowledge-medium/pr-preview/pr-1865/src/data/kernelValuePresetCores.js\":\"3d301c5a3c293374\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localDbCorruptionSignal.js\":\"8fcaf873ace8f43f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localDbStorage.js\":\"962ae3fe7a3e7d47\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localDbVfs.js\":\"bcbe9eb1ac90b1d0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/localSchema.js\":\"80c417d5846c4dc0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/maintenance.js\":\"08baeebf386d25a6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/mergeProperties.js\":\"60f30c16c0a2bfbb\",\"/knowledge-medium/pr-preview/pr-1865/src/data/metricsConsoleHook.js\":\"8d3722f04e6fad6e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/migrationsPage.js\":\"7d9a48b4253c8f2c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/mutators.js\":\"517490d603c240b1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/orderKey.js\":\"a1cbad4de34d5fad\",\"/knowledge-medium/pr-preview/pr-1865/src/data/orderKeyPlacement.js\":\"6c3f1c1c95835d4b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/outlineSurface.js\":\"9f40464ea5067dfa\",\"/knowledge-medium/pr-preview/pr-1865/src/data/pendingEditorContent.js\":\"5abdf0cf113beb2d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/pendingUploadsSql.js\":\"7fc285ae1b36ef5d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/pluginStateExtensions.js\":\"ceebb4e37fcbe0b0\",\"/knowledge-medium/pr-preview/pr-1865/src/data/powerSyncLogger.js\":\"16d97fe57f5d6297\",\"/knowledge-medium/pr-preview/pr-1865/src/data/projectorRuntime.js\":\"9d6487f40f10f6aa\",\"/knowledge-medium/pr-preview/pr-1865/src/data/properties.js\":\"e5a4e5a9a6ec9098\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertiesPage.js\":\"9e18322c109b1b8c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyChildren.js\":\"6268849a3fb2ef1d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDefinitionFanout.js\":\"d0e071eb5628ee00\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDefinitionMetadata.js\":\"6b455c0c99d9313e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDefinitionRegistry.js\":\"ad1a810fa566f308\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyDisplayMode.js\":\"a09d549d73709924\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertyRowCreation.js\":\"fd04b633c3280f61\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertySchemaCreation.js\":\"93e22fbee6ff09be\",\"/knowledge-medium/pr-preview/pr-1865/src/data/propertySeeds.js\":\"eb35c0cb0821cc9d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/recentsPage.js\":\"572aa68dff6a2641\",\"/knowledge-medium/pr-preview/pr-1865/src/data/referenceBlock.js\":\"750d2ec25d1cd061\",\"/knowledge-medium/pr-preview/pr-1865/src/data/rejectedUploads.js\":\"8dbdeb20a5c5a3dd\",\"/knowledge-medium/pr-preview/pr-1865/src/data/releasePowerSyncConnection.js\":\"ffc34caa7903efbd\",\"/knowledge-medium/pr-preview/pr-1865/src/data/repo.js\":\"6eee6f2548fbd95b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/repoProvider.js\":\"195f516680752b4c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/rowProperty.js\":\"8437754d8e59fb8d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/searchFilter.js\":\"647372e9683de010\",\"/knowledge-medium/pr-preview/pr-1865/src/data/seedIdentityLedger.js\":\"b98af5e34c412bec\",\"/knowledge-medium/pr-preview/pr-1865/src/data/stateBlocks.js\":\"c3563b334b0bc920\",\"/knowledge-medium/pr-preview/pr-1865/src/data/structuralEditPolicy.js\":\"aea98cccddc5ccf6\",\"/knowledge-medium/pr-preview/pr-1865/src/data/subtreeDelete.js\":\"8c22318747128439\",\"/knowledge-medium/pr-preview/pr-1865/src/data/syncStreamLock.js\":\"705ae2242174b8fd\",\"/knowledge-medium/pr-preview/pr-1865/src/data/syncedTableSqlRecognizer.js\":\"119c0df8429bd329\",\"/knowledge-medium/pr-preview/pr-1865/src/data/syncedTableWriteGuard.js\":\"b129e3c9080e062b\",\"/knowledge-medium/pr-preview/pr-1865/src/data/targets.js\":\"68a097d647bf4db1\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeColors.js\":\"7fcdc5cc51008156\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeDefinitionMetadata.js\":\"473921f3430098f8\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeDefinitionRegistry.js\":\"d913824d7c75be62\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeExtraction.js\":\"1dd6e10ca02e9339\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeInitialValues.js\":\"2d84c009b2d09a07\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typePropertyGroups.js\":\"46add3f1f69e7887\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeSeeds.js\":\"3f3ed3fce2cf125a\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typeTagger.js\":\"28e3d051882b936c\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typedRecords.js\":\"7505081754945f7e\",\"/knowledge-medium/pr-preview/pr-1865/src/data/typesPage.js\":\"c4f5dc4c78a2d33d\",\"/knowledge-medium/pr-preview/pr-1865/src/data/userPrefs.js\":\"b9e198d50b72dcc9\",\"/knowledge-medium/pr-preview/pr-1865/src/data/userSchemasService.js\":\"d0254b9450c14765\",\"/knowledge-medium/pr-preview/pr-1865/src/data/userTypesService.js\":\"a2fb0ac882b47415\",\"/knowledge-medium/pr-preview/pr-1865/src/data/valuePresetRegistry.js\":\"ba44a52da0795daf\",\"/knowledge-medium/pr-preview/pr-1865/src/data/visibleChildren.js\":\"31e43765d31d8e63\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceConversion.js\":\"ea50dbc42bbc3d30\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceFirstSync.js\":\"fb1b6e48ad604868\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceIdNamespace.js\":\"ff9ceb0fc477920f\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaceSchema.js\":\"ab780e4dc3df56ac\",\"/knowledge-medium/pr-preview/pr-1865/src/data/workspaces.js\":\"1eee26e72089c6c9\",\"/knowledge-medium/pr-preview/pr-1865/src/data/writeAheadLog.js\":\"73876d50c6567472\",\"/knowledge-medium/pr-preview/pr-1865/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/BlockPasteShellDecorator.js\":\"90a4454db5f800eb\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/atTrigger.js\":\"ed9d5f58ca6379bc\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/autocomplete.js\":\"12c910bcce8d01a2\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/codeMirrorExtensions.js\":\"df98f03973052f6a\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/contentFlush.js\":\"63aa1ab22b003e5d\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/defaultInteractions.js\":\"9ddd044c08bd909e\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/editSettleSignal.js\":\"0e93535da01b958f\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/insertImage.js\":\"0290dd09990e0f2c\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/referenceCompletionRange.js\":\"d3eb4b891105535e\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/referenceTargetTypes.js\":\"1146aa4e40a1c0c6\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/syntaxContext.js\":\"2f0482dc69bb2171\",\"/knowledge-medium/pr-preview/pr-1865/src/editor/triggerMatch.js\":\"f285a91f1ba14519\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/AppRuntimeProvider.js\":\"53b36baa53d99d3d\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/BlockFocusShellDecorator.js\":\"355c5d35184f2745\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/ExtensionRenderBoundary.js\":\"452300a6966db45e\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/PanelContentRecovery.js\":\"42c9397420d5d66a\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/apiCatalog.js\":\"f5644e70b92df6ff\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/approveExtensionHere.js\":\"0a23bb7781b7eb44\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/armedCutAppMount.js\":\"98f6e7f4cd7f260f\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/batchableKeyedStore.js\":\"b083efe176c3429b\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/blockInteraction.js\":\"df25ad42d85b09d1\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/blockSelectionAction.js\":\"a2991ee06e920a4e\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/compileExtensionModule.js\":\"b96104bfaaed7f8d\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/compiledModuleCache.js\":\"f1a6c769d6be5fe0\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/continuousGestures.js\":\"de364ca285607291\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/core.js\":\"7289e3d7866fc072\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/defaultRenderers.js\":\"deae08c9485829a7\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/definitionFanoutAppMount.js\":\"7e55a044cf7fec6e\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/dialogAppMount.js\":\"11970f3280322698\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/dynamicExtensionSeeds.js\":\"68826381ff88d0c9\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/dynamicExtensions.js\":\"7af1003ea76b3814\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/exampleExtensions.js\":\"37d33bd1d0174a08\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionApprovalStatus.js\":\"b2d5b42d246b75c0\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionLoadErrorToast.js\":\"94429758d83f2fbd\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionLoadErrors.js\":\"042f0e3f4dad96a0\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionLookup.js\":\"a5be1b3d61c0bfd2\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionToggles.js\":\"e2ec37770c0d3eb2\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/extensionUtilitiesCss.js\":\"386a0a7e812eaece\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/kernelPageDeletionGuard.js\":\"9544af8c1742be82\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/liveRuntime.js\":\"d90a40d95cf87903\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/openExtensionsSettings.js\":\"51854fba6df892e5\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/overridesCache.js\":\"7c217408435a31c3\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/pluginIds.js\":\"0f0ef79f8a10a9eb\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/processorRejectionToast.js\":\"4e88b50cf41a2dee\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/runtimeActions.js\":\"0ad527f9c289c021\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/runtimeContext.js\":\"285793e031f96fa7\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/staticAppExtensions.js\":\"8a18461ecdf6837d\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/staticDataExtensions.js\":\"1bf508cb9dfd6b7e\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/toastAppMount.js\":\"e1168257741a3364\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/useOverrides.js\":\"1f8e609e27606dec\",\"/knowledge-medium/pr-preview/pr-1865/src/extensions/useShortcutSurfaceActivations.js\":\"49f580b1509750bd\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/discoverToggleTree.js\":\"06ef79796d09b882\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/facet.js\":\"8fbc930b92d72bb7\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/resolveAppRuntime.js\":\"fe7bec04c8669384\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/runtimeEvents.js\":\"6eea28ad70c9365c\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/togglable.js\":\"666b62ce89271a32\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/variantFacet.js\":\"d2828dd27c634309\",\"/knowledge-medium/pr-preview/pr-1865/src/facets/verbFacet.js\":\"59293f647f0c3d75\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/block.js\":\"914ef599bddfa6ad\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/focusedChild.js\":\"a34bffc3586cf912\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/propertySchemas.js\":\"844f653856daa414\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/typeRegistry.js\":\"42809b268487c808\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useAncestorCrumbs.js\":\"0b18d966af0edd1b\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useAutocompleteListbox.js\":\"d50b598c1698278c\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useDebouncedSearch.js\":\"834bdfae8b4c8690\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useDebouncedValue.js\":\"939605bbfaac0b8f\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useIsFocalRender.js\":\"666984a01125d828\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useIsReadOnly.js\":\"42c9296df17e50b1\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useMaterializeBacklog.js\":\"80c503ee4b64b873\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useMinuteClock.js\":\"305e411111e9649b\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/usePanelLayoutProjection.js\":\"30e4ae75afdb02f9\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/usePendingInvitations.js\":\"c3ca8319034d6fb5\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useRendererRegistry.js\":\"089020a33489c92b\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useRetainedFieldRows.js\":\"1b27e385d26646f2\",\"/knowledge-medium/pr-preview/pr-1865/src/hooks/useWorkspaces.js\":\"0be0989650be62cb\",\"/knowledge-medium/pr-preview/pr-1865/src/lib/utils.js\":\"87f02c730321a559\",\"/knowledge-medium/pr-preview/pr-1865/src/main.js\":\"b7e01077746f1445\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/MarkdownImage.js\":\"605a2faf24717654\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/blockSeparators.js\":\"6c44b98db56a2462\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/context.js\":\"6833536b5d31e50b\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/defaultMarkdownExtension.js\":\"952f379dea4713ca\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/extensions.js\":\"51743eb891fa2f68\",\"/knowledge-medium/pr-preview/pr-1865/src/markdown/renderMarkdownHtml.js\":\"e19f04b79df1cb30\",\"/knowledge-medium/pr-preview/pr-1865/src/minimal-editor.js\":\"fff5f17b22965479\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/armedCut.js\":\"488bd8ab8af06cd3\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/captureMediaVerb.js\":\"c3542fd45dccc231\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/clipboard.js\":\"3f9da71285cfe554\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/decision.js\":\"a4d775f5c40f332d\",\"/knowledge-medium/pr-preview/pr-1865/src/paste/operations.js\":\"1a7f1e2d67f6ec76\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/account-header/AccountHeaderItem.js\":\"08c7c2f9c8360b99\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/account-header/index.js\":\"e5cc08ef06b756ef\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"68b5d5b2e68da6c0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/askAgent.js\":\"f7d2d74a34d2136e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/askedStore.js\":\"cba07dcfd29a5456\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"da8fdf7dd24eec0f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/chipState.js\":\"3d7bd61fbb28d8f9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d93c5700a94037c8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/index.js\":\"89c4f5f870b472a9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9b8d4d6959165d4b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-dispatch-companion/schema.js\":\"32c708d18a8a7af8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0f148ca4037cad3e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c7355fd2f0ce2dc8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/addMedia.js\":\"7e14d5bf2dc47552\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/backlinks.js\":\"12b9e3b57c6a1c71\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/block.js\":\"e7f8247efccba7a8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/context.js\":\"de1429f9d0610890\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0cb5e7d6930c7dc2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/index.js\":\"d8b86d847bfef100\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/memoryIndex.js\":\"1c1bf13ffd55e9ed\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/outline.js\":\"24ce9030807fd35b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/properties.js\":\"feb444cf995816c6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/refs.js\":\"81883ba2d518ea59\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bd7c822da4fed07e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/search.js\":\"3824d21e3f7bd44e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/shared.js\":\"8855d998a236dea2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"dccdf1bbd1714ce9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentViews/text.js\":\"459b8f707f5fe14b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/agentWrites.js\":\"206b4e058d6fd52e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/authoringCatalog.js\":\"bb585fa2a1423ed9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/blockRefTargets.js\":\"8983d699ba6d2827\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/bridge.js\":\"bc2d4b099cb25273\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/bridgeLoop.js\":\"f679e86e41c0eb43\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/changeHistory.js\":\"67d62823dee836b6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/commands.js\":\"ff46c26dc295d88e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/commentsCommands.js\":\"4124911a1fde79e2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/dataExtension.js\":\"8818799e8d300f1d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/dataModelGuide.js\":\"81b10603ca4f3dc1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/describeRuntime.js\":\"1e01a768a06b2993\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/extensionLint.js\":\"ef872ab30ffc6fb3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/grainAudit.js\":\"e95f316a11392405\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/healthCommand.js\":\"37f443ec055fee5f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/index.js\":\"fb77221612f4c9c0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/presetIdentity.js\":\"5d3b09da8b0621ed\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f9ad9f6dabb65126\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/readMedia.js\":\"eb1e8010c37fc3bf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/schema.js\":\"17d7af33d9e3dbf0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/serialization.js\":\"7360a8ee0275e8a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/targets.js\":\"b605b83d23dfb94a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/tokens.js\":\"735216a34338cd5f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/watchEvents.js\":\"1af993968865acde\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/workspaceGuard.js\":\"865495b784de1d2f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/agent-runtime/writeCommands.js\":\"2b898c64ff606fa2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/AliasCollisionToast.js\":\"af76156051f53175\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/DuplicateNameBanner.js\":\"8e98cedde81e6145\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/collisionMerge.js\":\"50f37574a37f6868\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/dataExtension.js\":\"f5b7b6bb70781f7a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/index.js\":\"c5a1ded2107f52c9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/mergeCollisionAction.js\":\"fa547aab749c9cef\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/pageStyling.js\":\"1c71e015177bab8b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/rejectionToast.js\":\"541ce6ce069a1549\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/alias/syncProcessor.js\":\"c4acafa58702fa50\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/actions.js\":\"c644fa65a7c75482\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/addComment.js\":\"e82d7dde5888a050\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/anchor.js\":\"51a7bbdc938e1061\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/anchorState.js\":\"8db4342c879f4b9d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/commentLinks.js\":\"caadb198739d28ad\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/confirmThreadDeletion.js\":\"e7a25582ec10c231\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/container.js\":\"829f7a3f92c738ea\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/dataExtension.js\":\"71ef51088d611ab4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/deleteComment.js\":\"c5cc65d617902830\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/highlights.js\":\"51a1abae3528d775\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/index.js\":\"218fcfd20ca4e384\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/linkedCommentsPill.js\":\"ad9d1931795c1dc2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/margin.js\":\"08965c63e3aab64d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/marginSchema.js\":\"b518668e0632ec7b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/newComment.js\":\"24f57315ce288f25\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/ownThreadPicker.js\":\"fc2b678f014f5532\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/placement.js\":\"8f14bb53f8864a34\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/queries.js\":\"d67f385dcb4a9056\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/quotePosition.js\":\"529edec895417c00\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/quotedIn.js\":\"b0e6063fbae6a06d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/quotedRange.js\":\"6203657d449359f8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/rangeRefs.js\":\"1e4059f44082deeb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/readHighlights.js\":\"cf67899f3f49c9a6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/readSelection.js\":\"2693bbede23dd6fd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/readSelectionUi.js\":\"58985c16506c4da6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/reanchor.js\":\"e9f667ee238f3953\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/schema.js\":\"6ba4a59411750cd8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/scope.js\":\"c79858733d90375b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/scopeThreads.js\":\"83b5a4c6a3dfda07\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/splitRetarget.js\":\"c0172408fc02935c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/suggestionCard.js\":\"bc5a9cdf065a9d20\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/suggestions.js\":\"959ba5293cfaa711\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/summaries.js\":\"9eaaa3e6efcaf470\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/summaryBatch.js\":\"4e5b02e802c14555\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/surface.js\":\"3abb6ae66e8de158\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/threadNavigation.js\":\"58ca7e8261298c71\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/threads.js\":\"78abf426ce9e7f47\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/ui.js\":\"6cc4bff2489504ad\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/annotations/uiStore.js\":\"ad1ddf0fcdb4f58e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-intents/appIntents.js\":\"8b42302fa8a5f7bd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-intents/index.js\":\"9442ee495667dfb2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-update-prompt/index.js\":\"33ad62a415b74801\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/app-update-prompt/status.js\":\"9eff0893a359e312\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6626fd3dd3287390\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/MediaBlockRenderer.js\":\"c1ffee0879edc5bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d896d37c80dbc656\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/MediaUploadReconciler.js\":\"a5533dd65afce8d4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/assetDownLane.js\":\"8cdf4c2e6da026f9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/assetResolver.js\":\"e7ed152dbca1aeb1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/assetUpload.js\":\"70ae396ac6e18e82\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/attachmentCleanerIO.js\":\"9d12907739de9625\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d70f0a25a7c4ffbd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/blobStore.js\":\"3d102b93787aa789\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/browserMedia.js\":\"df49770cc8b9291c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/byteStore.js\":\"5c046c82ea6d5b4e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/cleanerIO.js\":\"848bbad0d89df2d3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/cleanupAttachments.js\":\"307dea307a1fb499\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/dataExtension.js\":\"14e9cec2b327bbb3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/downLane.js\":\"1aa35b86629c5b5b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/index.js\":\"59c7c1bb506207b2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/insertImageContribution.js\":\"ce588d77458f84f2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/laneArming.js\":\"a915a40a71887be2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/laneLock.js\":\"d883f767043291a7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaBlock.js\":\"05821b521802bcf0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaCapture.js\":\"c8cdcd1485d57625\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaLanes.js\":\"f0d194b2672421d9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaViewers.js\":\"5113646c11d9bd08\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/mediaViewersFacet.js\":\"62dfdf11fec03431\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/pasteCapture.js\":\"6c45d2f9d98a93b4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/resolver.js\":\"098676249553849e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/retryUploadsAction.js\":\"29239c6781836034\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/storagePaths.js\":\"29ddb73f22a7f869\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadDrain.js\":\"82e75a6757a5afe9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadLaneStatus.js\":\"8ba30b382a7576b1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadReconcile.js\":\"f096bf04493844c4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadRecovery.js\":\"2cbfc5ccb92b1623\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/uploadStore.js\":\"4d50adfcd5856e4d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/attachments/useAssetObjectUrl.js\":\"efa60ff62275a6c7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"36a599ab96b7029d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/BacklinksViewSection.js\":\"437d5882570e2d78\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/facet.js\":\"d6561c7c08d9422a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/index.js\":\"4aa62ea5ce6fc795\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks-view/prop.js\":\"d91c9eb599026274\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/BacklinkFilters.js\":\"d020b14dbe224513\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"84729bde72e11f23\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/BlockEntry.js\":\"184dad3fda0a8bc1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/LinkedReferences.js\":\"721c4092202237cd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8d2b693c5c42c58d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/dailyNoteDefaults.js\":\"2f8da07b51817021\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/dataExtension.js\":\"627bbd3e133fc6ea\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/edgeExclusions.js\":\"6d74a8c794823503\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/filterProperty.js\":\"8a539776926be9fa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/index.js\":\"1921b1165417bff1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2cf6cdd5faa8d0f2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/applies.js\":\"df0ba6682b3d9147\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/countQuery.js\":\"872f9bd4b5e61020\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/expansionStore.js\":\"30d2bd8b99ac6cf3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/index.js\":\"c354ecfff5f1a906\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"34faf06a4705180c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/presentationInvalidation.js\":\"2714877831af9dec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/propertyEditorOverride.js\":\"133ce3c72d3658a8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/propertyFilter.js\":\"5c18e5038fc34c8a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/query.js\":\"6f026084b4eed467\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/resolveFilter.js\":\"2abfce3f8df1f202\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/sourceBatch.js\":\"43fdaad21dd9b57b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/sources.js\":\"03f3a7c370f895ca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/useBacklinks.js\":\"b8442c7b5bc1ec9f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"59387a0c2379a2c1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/BirthdayCelebration.js\":\"425751a8835da473\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/BirthdayOverlay.js\":\"d063825c7129cdcb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/gate.js\":\"5cca225af9ae537e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/index.js\":\"e57ad194133076d4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/birthday/wolfTheme.js\":\"f497bfb2193f0620\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/BlockDragLayer.js\":\"b75f529d5ce4fff3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/dragController.js\":\"faefe47ac0dd6f09\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/dropTarget.js\":\"fc3a715907aa099c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/index.js\":\"14537e8c7842d3a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-drag/projection.js\":\"866fd3deba1dfb82\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-info/BlockMetaCard.js\":\"3a8d8922b801204a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-info/index.js\":\"034389bc1006209c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/AddTagDialog.js\":\"645cbd7629cead45\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"130e37f70bbaffc0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/TagNameIssueHint.js\":\"c8d0939dd1f3d01f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/addTagAction.js\":\"e25197604b99b1c7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/appendTag.js\":\"b9106f1ad3da6868\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/config.js\":\"b508201974593361\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/dataExtension.js\":\"384c592701e8e825\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/index.js\":\"c494f5e897480e5c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/block-tagging/propertyEditorOverride.js\":\"0e2c553981c4b1ea\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7ea5b6d1cedd1a5d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"32adcc982c3e89f1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8d2727ab59dbdd16\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b397fdf57a440218\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b25ddeaa28e79487\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/index.js\":\"61bd654f92f16cb9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"021c80c31a1e5315\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/CharacterCountItem.js\":\"92f8fde7c7212c64\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/ProfilePropertyEditor.js\":\"316001daa578a926\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/actions.js\":\"e87939eb43f5ef64\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/blockType.js\":\"10c7608e9b616351\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/charCount.js\":\"b9737b01828b062a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/dataExtension.js\":\"e79c748de238e411\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/index.js\":\"867a5920df4e337b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/profiles.js\":\"fdda0af3b3cde0ad\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/properties.js\":\"178df7e1756d3f49\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/character-counter/textCounts.js\":\"b627b52cfcd475d5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/colemak-keybindings/index.js\":\"c8ac36af20c3f2cf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/CommandPalette.js\":\"e2c1b54c428753ab\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/HeaderItem.js\":\"b7958668b1e6c045\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/context.js\":\"9cb99da4e261cbd8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/index.js\":\"04946992e0591ed9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/selection.js\":\"d7583af0a192cbbd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/toggleStore.js\":\"52df0dc8e1182654\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/command-palette/useCommandPaletteActions.js\":\"5a89c60328ab4153\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/ContributorBadges.js\":\"db62ba46f2f8aa5d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/author.js\":\"90e98de85f4e420f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/codeMirrorExtensions.js\":\"94f67a255d7b45c2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/dataExtension.js\":\"fa174639986aaaa3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/index.js\":\"a1d8891ac87789e8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/mentionAutocomplete.js\":\"5cb190a4d7bb8145\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/processor.js\":\"880c6a7015eace9e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/profiles.js\":\"743bbec6440c8345\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/queries.js\":\"5267aa2cdd1a09d5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/contributors/schema.js\":\"247d25ccd17fc6b4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f3c71dcf753b246d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b1eda4677d07c514\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/index.js\":\"0ae266e9d8dd5f2a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"adf8224cc8a6f30e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"de8f0787a700b42e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/CalendarGrid.js\":\"2b79201819b6315b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DailyNotePicker.js\":\"ea32be1217669908\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"065f46e3b193b0a5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DateNavDecorator.js\":\"aeec3fb591c500dc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/DateScrubOverlay.js\":\"4d1064da0702e1da\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/HeaderItem.js\":\"1e561f6d1e6dfb24\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/ReschedulePicker.js\":\"3847e94d77b1c285\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cf8411f3b69eb135\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/actions.js\":\"13dc65805c0ed599\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/blockDateAdapter.js\":\"d5aa97420f469b49\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/calendar.js\":\"562b408be9a13eec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dailyNotes.js\":\"847d0cb7d18fac4e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dataExtension.js\":\"463e7a7cfaa829fa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubActions.js\":\"cc32ba2952e3dd2c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubGesture.js\":\"fd6d68b96337cadd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e3e5647cb2a2a99f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1a7c14a091c49792\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/deletionGuard.js\":\"fc4e55786e93d2b3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/dueQuery.js\":\"21fe0c812a3c4821\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/index.js\":\"068d44d3b979ee88\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/landing.js\":\"edb9eb875132226f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/localSchema.js\":\"378d3c460350fd93\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/referenceDateAdapter.js\":\"ae71ab41c358fa46\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/rescheduleAction.js\":\"f39a671874a5b2ad\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/schema.js\":\"9dc672bb1146f235\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/spreadBlockDates.js\":\"0238a8a3a308e703\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/spreadDatesAction.js\":\"5e4a77cc24e1cb4d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/today.js\":\"34711ed3d8261fd9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2940e9fc241f0ce3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a6f39c8fc2732f3f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/audit.js\":\"ba9f00357e67b979\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/auditAction.js\":\"6ede3b628445bc51\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/auditRanges.js\":\"6ed28992ba24733c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/diagnosticsSource.js\":\"616a72ad743e046d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/divergenceScan.js\":\"2bbcb22dd8d28f2c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/index.js\":\"f104cc48e1fc0108\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/propertyChildrenChecks.js\":\"bf0924bf5d85281b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/referencesMirror.js\":\"c5dd142cb270045c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/rowJson.js\":\"a80423895eac3793\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/schedule.js\":\"dd1a52fd5c526b9a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/data-integrity/store.js\":\"668dd8240944851c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-maintenance/action.js\":\"0445747267c77c94\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-maintenance/index.js\":\"5488f7c7a391e0f8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-maintenance/plugin.js\":\"058117011bdd11c1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a245dcfd99987420\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/actions.js\":\"a2eaa10b0a178a6d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/changeMarker.js\":\"d13d0874db4640af\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/diagnostics.js\":\"5b5d00a66e8bb2c7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/fileSystemAccess.js\":\"4e1ae240a18b6606\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/filenames.js\":\"3f6486cbc7a510bb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/index.js\":\"82d807ca5e710729\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/mirror.js\":\"3b66fe957fe5163d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/runLock.js\":\"8f7a3608952a7e60\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/runtimeHealth.js\":\"5a63d83002affd52\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/schedule.js\":\"1b49fbde8798f83b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/db-mirror/store.js\":\"54fd6f59ef3ae56c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/default-themes/index.js\":\"57565324ff0297d1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/default-themes/themes.js\":\"2dde8361131ac0ff\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/diagnostics/facet.js\":\"5ccc64fdc3cf14a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/diagnostics/useDiagnostics.js\":\"4bab349a4642137a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/dismissals.js\":\"afd02756f6247f8a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/index.js\":\"b3afdd68b19abc26\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/status.js\":\"2a11b68bda79ccb9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extension-prompts/store.js\":\"a300b7a742bf86b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ccbc4aaeb57d831c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/ExtensionsSettings.js\":\"759a8b2aa6023dca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/actions.js\":\"a2021ee168f38c9f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/config.js\":\"918bd00cbc0acf47\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/dataExtension.js\":\"1e4858cbdda014f6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/effect.js\":\"1ffe85710db2ec63\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/index.js\":\"bbcaadeb92e19c3c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/propertyEditorOverride.js\":\"39c14fa8e7bc5fe7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extensions-settings/useToggleTree.js\":\"f45c27c7245d3c2c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/ExtractTypeDialog.js\":\"c233ecb5fab912a2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d9781b95ded0b422\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/PropertyShapePicker.js\":\"5ca3e239f2bf6888\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/action.js\":\"f419b7ea27160093\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/extract-type/index.js\":\"c28ff96f6e771033\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/FindReplaceDialog.js\":\"a5989a96356727cb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/HeaderItem.js\":\"8a14b994cd4131ce\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/dataExtension.js\":\"c2b702b6702365bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/index.js\":\"3ece82807bb79a3a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/search.js\":\"e78cb70adafc8332\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/toggleStore.js\":\"a6637a9fe85a63ab\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/LocationPropertyEditor.js\":\"411f0e1a186fea63\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/MapView.js\":\"cb966b9716bc2111\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/blockTypes.js\":\"16c792b1c384113d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/codeMirrorExtensions.js\":\"c82b9962bdec56e7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/createOrFindPlace.js\":\"6265ddbff8dde8bc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/currentLocation.js\":\"c56108826bc7168e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/dataExtension.js\":\"b9e5a4f5c53607a0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/geoContentDecorator.js\":\"aa5eae99d08606c9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/googlePlacesClient.js\":\"2cc51259703afbad\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/index.js\":\"2c6b694b2f3b484a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/locationsPage.js\":\"e6ae0255f0f80a9d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/mapViewport.js\":\"d867b58c108c670c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/pickCurrentLocation.js\":\"f70b19761f87eb94\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/placeAutocomplete.js\":\"d6830fa7234de310\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/placeNameCollision.js\":\"f5e9869e7ea42ad5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/properties.js\":\"f2c85fa970b67faf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/propertyEditorOverrides.js\":\"fcd4baf38524de26\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/query.js\":\"23b80e3744a159f6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/geo/usePlaceSearch.js\":\"f215f348fe8724b6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d1bec042e17c18fa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b26ef938eb721c74\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"49540d7728fef0cb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/config.js\":\"061473772955b5ed\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/dataExtension.js\":\"f8be975818a71dee\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/facet.js\":\"bfd74d3e7a2e2518\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/grouping.js\":\"54534ab2f5a14cf4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/index.js\":\"2c5886a56d7a441a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"40459ad11cdd533a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/query.js\":\"71704b8991ab1e0e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/resolveConfig.js\":\"4c95ec6d81ffcb5f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4d56739252ab5dff\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"20e36849742b206f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/HtmlDocumentContent.js\":\"03714ad5fd741152\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/HtmlFrame.js\":\"8c4fa9b4457dd524\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/actions.js\":\"6829993e41bd83f2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/blockType.js\":\"d85ff74403de93ef\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/confirmRunScripts.js\":\"5de164f649900c02\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/dataExtension.js\":\"3c2bc1b4157bee68\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/frameAnnotations.js\":\"47fcabd901c38ed3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/frameDocument.js\":\"3e1b0fa6108d6d1b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/frameTheme.js\":\"ac9d33b09210e1e6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/index.js\":\"d36e494ee7167a82\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/scriptConsent.js\":\"949adb303e25d3f3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/sourceMap.js\":\"735e7704a5c14766\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/html-document/useDocumentScripts.js\":\"c59bbbc71495f898\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/index.js\":\"d99cac2f22e74c59\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/record.js\":\"47fdabe85842ab49\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/recordStore.js\":\"1a2ff9bc98b0ffda\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/responsiveness.js\":\"2783508ea207a7c4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/schedule.js\":\"e5655bda4cee76bb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/interaction-metrics/sessionContext.js\":\"99b1564d2a8a2c42\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f81fca7a216596b7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"83f599bf2cb6042f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/actions.js\":\"80c5cec71a0d4944\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/config.js\":\"eaabc9c06469136c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/dataExtension.js\":\"f04434c48141f331\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/effect.js\":\"8a62b0c1b216d9d6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/index.js\":\"0112769c3c754da6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/keyCapture.js\":\"12cf5c8eabc0046d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/overrideStore.js\":\"f2e93b0792f3a925\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"72ee872c55fa354d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/HeaderItem.js\":\"b17ae0b5b69d1072\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/LeftSidebar.js\":\"5c8704a5317788d5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/actions.js\":\"3720f27543180953\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/facet.js\":\"492e56a54446118e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/index.js\":\"13c01cb1fffa35e7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/shortcuts.js\":\"5628aebb22d3e2fc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/left-sidebar/toggleStore.js\":\"867bf5fd127c86c0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/MergePicker.js\":\"1d8362707ee2169f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/index.js\":\"9f31875c57dea9ec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/mergeAction.js\":\"759c08ce077bc024\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/merge-blocks/strategy.js\":\"e89b1596e371209e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/Button.js\":\"040de4305596cd8f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8f8f546d8a5e04a5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/defaultItems.js\":\"bcd01f4cb7a2fe0a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/facet.js\":\"86da0e00c6adc9ff\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-bottom-nav/index.js\":\"92dd1f716eee32ba\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a7e3fb20d927d4d7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f4e6d0f44ff54723\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9b9cdff36f1009e4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c0580f0dabd088eb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/mobile-keyboard-toolbar/index.js\":\"e272805a577b9cd3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bf3eeaaa88a2d1b6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/blockSubtreeMembership.js\":\"cd42e531bcfe41dc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/contextMenuItem.js\":\"665113453e633ed7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/index.js\":\"df046f72fa25b889\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/moveAction.js\":\"c3e6471d02cac47e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/moveBlocks.js\":\"2111fd1004cd5c19\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/move-blocks/selectionAfterMove.js\":\"6cedc93b2c0468e8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/TutorialBanner.js\":\"12d1c814aae4d011\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/action.js\":\"f3fd58eac95b53e9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/bannerDismissal.js\":\"7498eae8d33257ad\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/documents/cheatSheet.js\":\"447f3a72772f57e7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/index.js\":\"727427a3f813009d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/keys.js\":\"472e9cf27f5ae01c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/landing.js\":\"7e96930ddf0ca56f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/outline.js\":\"4377ef7313b1792c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/onboarding/seed.js\":\"6d7064ece50ad30f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c7795d9be8565f88\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/analyze.js\":\"d830b7e00260c6fb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/diagnosticsSource.js\":\"b2f8a42b1c382a41\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/index.js\":\"cbdea9bbc5505147\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/load.js\":\"3fee4a492471bacf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/monitorRun.js\":\"73b1351b0d9a4237\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/schedule.js\":\"34fbcdf531a64f8a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/series.js\":\"3d73098f5d4e0c4e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/store.js\":\"aafddfd748097e7b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/trendAction.js\":\"a5074ff686faf398\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/perf-monitor/verdict.js\":\"446ad617ca93a8fa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/plain-outliner/clickToEditAction.js\":\"e34fac7d17eb81dc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/plain-outliner/index.js\":\"cd16895a4f23511e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/plain-outliner/interactions.js\":\"de686dbc1f6c46e0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1826cda75a4a7b22\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/MigrationGate.js\":\"3b72c12af8574c52\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/MigrationGateDialog.js\":\"812361689042bd2b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/action.js\":\"c5685172dfb0165d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/index.js\":\"8f8cda94aacd9cf9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/localRunMessage.js\":\"594c5b7ec26932dd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/plugin.js\":\"f95c92f9c726a5d7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/progressReport.js\":\"7aa32e1c5ceaa374\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/properties-migration/sweepProgress.js\":\"5babddf2cabdd107\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/FieldRowRenderer.js\":\"cdffbe60a6c6e4b4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/ValueRowRenderer.js\":\"39b8f11587862290\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/actions.js\":\"6ef4c0f8c0cf8d68\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/autocomplete.js\":\"1425f08f548f69b0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/fieldRow.js\":\"7fe13c85dc8465e3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/index.js\":\"eef13e2a2a0e345e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/referenceWarning.js\":\"e62076a51559b91b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/valueAutocomplete.js\":\"d0b7589649a8bc7b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/property-rows/valueSchema.js\":\"12bf7b372ba87655\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/HeaderItem.js\":\"3127e20d7019b2b3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/QuickFind.js\":\"25b89b1502d61e4f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/index.js\":\"7f6ec6572f65dbab\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/recents.js\":\"c325f071da01357d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/resultItems.js\":\"31eb915532213791\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/selection.js\":\"d9322db4d8890d33\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/quick-find/toggleStore.js\":\"581eac2887f229ea\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/HeaderItem.js\":\"9602fa907484248b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b583de9c9d7a124e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/grouping.js\":\"8953e57c452fcbf5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/index.js\":\"a832380d245e9af3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/recents/target.js\":\"f80f0841fa4f2e8e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/codeMirrorExtensions.js\":\"616430fbead7a48c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/contentPrefill.js\":\"26f45f83a6f69341\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/dataExtension.js\":\"d4df4f715fc291e8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/index.js\":\"422ae8e8bc0b9a35\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7fed3e72814ea3c9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/invalidation.js\":\"81af881d9e86bdb1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/localSchema.js\":\"7e37d93a29b94f77\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/blockrefs/index.js\":\"0329571f0b2d9cc0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"864d27a7ebad8814\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/index.js\":\"84ed0915dd796c26\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/referenceNode.js\":\"673a2c8d9caccca6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/remark-reference-occurrences.js\":\"eb4b420aba2c27c3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e8ea6849718fcdc8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/index.js\":\"dbbfdffe2f20c8b9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b481cfaceaf2f037\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9902bbdebf983520\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/mergeRetargetProcessor.js\":\"0e1240668c72dcf5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/parseFence.js\":\"eb9b96d565772463\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/referenceParser.js\":\"d83b7c15924db145\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/referenceProjection.js\":\"f95294229d28eb86\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/referencesProcessor.js\":\"11ba17319efaa7bf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/renameProcessor.js\":\"878b7245db59c71d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/references/spanReplacement.js\":\"884e15e9721cfc5f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/htmlToOutline.js\":\"c016fa76315b73d0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/index.js\":\"ba415be4327e83df\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/normalizeClipboardDom.js\":\"95cafb1c51bf4f9c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/rich-paste/pasteDecision.js\":\"c3ebea5c0c13a621\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/action.js\":\"d511f27067f125b0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/blockIds.js\":\"462fde9f035906c4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/content.js\":\"a2d910330362419d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/effect.js\":\"45cdcc044f838af9\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/ids.js\":\"1709cca04f9e6214\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/import.js\":\"306e8d15e15e1826\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/index.js\":\"5f73ddb9326833e2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/plan.js\":\"4ee7a386c3a50e4a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/plugin.js\":\"951e65bc7642143e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/promotion.js\":\"52a049d91230b35c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/properties.js\":\"26b0af8a4ed8858c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/references.js\":\"6765db2b149eb384\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/report.js\":\"25c6b05ce875e5a1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/roamMemo.js\":\"e7d2a373bd9ccfdb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/runtime.js\":\"6abf91458e95a765\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/schemaReconciliation.js\":\"c5e1540339683956\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/srsMarkers.js\":\"e00e3581783aa4e1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/todo.js\":\"ad5bebb4ef5e48d6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/typeCandidates.js\":\"5624963a608b7e44\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/roam-import/types.js\":\"4a7c7507dd8cfef2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/search-health/index.js\":\"788bddde3d629904\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/search-health/store.js\":\"4b5967ddbac824f1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/HeaderItem.js\":\"3bd9b2d43413928e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f912c222bbeb2f8f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/index.js\":\"aa620f4d3589d169\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/model.js\":\"e9977d7d227e2570\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/toggleStore.js\":\"a4557236be4e3af3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/shortcut-help/useKeyInspector.js\":\"dbc99268ae603bc6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a7411ebaf4863c41\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/ShellDecorator.js\":\"df0cf8ee7b214203\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/actions.js\":\"f6d7bd221b0576da\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7ceb936823f6e681\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/index.js\":\"424e2caf9b36527c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/shell.js\":\"e9661c59da81c852\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/surface.js\":\"ac73eb54bc2f4660\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/spatial-navigation/walker.js\":\"d30e16e8f3758067\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8c054a01a6bae88b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/dataExtension.js\":\"b0f35818179d5c96\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/index.js\":\"b205121f4e6e2c53\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/indicator.js\":\"7d38da3e2004f1ec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/moveSrsState.js\":\"449c3f9a5d07a653\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7edbe0a402663fa2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/scheduler.js\":\"2248bbb75e4587f6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/schema.js\":\"8e1277b537ad7f26\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"82314103530c7ef3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/srsClipboard.js\":\"cec276f99a1c6d84\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b8723fff3f70634d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/DailyNoteReviewHint.js\":\"309014338e9a7f2a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/DeckPicker.js\":\"98de268a92a2a4d3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/ReviewControls.js\":\"91186837b8a84c98\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c257b8969e981818\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/ReviewSession.js\":\"274dcb8ba12b57b6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/actions.js\":\"325e05537e1a0f43\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/archive.js\":\"20a42005ce263c64\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/dataExtension.js\":\"a480d69121f95851\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/deck.js\":\"02ebac7003922fdc\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/dueQuery.js\":\"f107eb9c76c35130\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/gradeDecision.js\":\"213e6680299c01c0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/index.js\":\"07ef037509393576\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/keyHints.js\":\"5a8275632c571d1d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/reviewCardLayout.js\":\"e719126ba861cf75\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/reviewProgress.js\":\"fbbc8468fbde7b77\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/schema.js\":\"f1282a558740456a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/srs-review/useDueCards.js\":\"77bcc2f5f8a38e6b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/startup-metrics/index.js\":\"77b0f7cf84655596\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/startup-metrics/record.js\":\"34cd60cdfea8d59e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/storage-persistence/index.js\":\"af27aa04163ce86e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/storage-persistence/persistenceStatus.js\":\"0f2f3445eebe1a87\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/storage-persistence/requestAction.js\":\"304823ddc41ad61d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/TypeChipsDecorator.js\":\"eb423554a9d4a4ec\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/codeMirrorExtensions.js\":\"824a87e353ffa778\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/index.js\":\"1533c81fb45c3f80\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/supertags/typeAutocomplete.js\":\"052eed4b80e35ea1\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6575e17b273d1758\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/actions.js\":\"6b4fbab101119f4a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/anchor.js\":\"8124a27257dd7e66\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/events.js\":\"6fda39d291813879\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/gestureActions.js\":\"be8b71a8fb090def\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/index.js\":\"dd465845a4b425a6\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3975ce2da205b753\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/sync-metrics/collect.js\":\"76618f85b87ede18\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/sync-metrics/index.js\":\"5d21e04e2d43a4a3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/sync-metrics/record.js\":\"7fabecd7a768ac45\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/RejectionDialog.js\":\"978971ce432a27b0\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/SystemStatusHeaderItem.js\":\"49d683a0b18a4b9c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/index.js\":\"19056a7389e72726\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/model.js\":\"ce46fddb4c659cda\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/queueCounts.js\":\"bc0737c99a8c3160\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/rejectedHelpers.js\":\"49f3a68f97aed0a8\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/rematerializeAction.js\":\"ba957c56229d482b\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/system-status/useHysteresis.js\":\"bd760f32ef5a0b4a\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/ColumnHeaders.js\":\"83b3c1a0d93c2e59\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/QueryUi.js\":\"7cd2de9e4d846680\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/TableLayout.js\":\"66d82f627c0e784e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/actions.js\":\"707a4f3cd359cf47\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/cellEdits.js\":\"7399543b0109dad5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/columns.js\":\"11aa8a481404590c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/controller.js\":\"be0132906a2baad4\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/convert.js\":\"3c80b6584bae1e99\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/dataExtension.js\":\"2e3b342d4c1035e2\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/index.js\":\"eaffd6419c447539\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/keys.js\":\"81913c9fd67c9fcb\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/model.js\":\"7ab0577346eac663\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/navigation.js\":\"0de2e531ab6a37f7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/backfill.js\":\"caaab6c4c04431c3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/completion.js\":\"73ef49451dafaeaf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/format.js\":\"946edf12be6d19cd\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/parse.js\":\"ae79a486e83aaf2c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/queryValue.js\":\"ea525bec971b4413\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/query/source.js\":\"a8cff46863b9aa61\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/registry.js\":\"43ce8e3e20cd1aaf\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/rowGutter.js\":\"da55ea23ceda8713\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/rowVerbs.js\":\"6948304122452029\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/schema.js\":\"0a94a431a005bf5e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/tables/sort.js\":\"f8d5b1339e8a3025\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/theme-toggle/effect.js\":\"bf3bfc0057bce2e3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/theme-toggle/index.js\":\"d39aa49d908a9945\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/theme-toggle/theme.js\":\"905afcf6fed232e3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/actions.js\":\"6deb4c0a0e54b0e5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/dataExtension.js\":\"2769075bc2e53e75\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/index.js\":\"0877588dc1260778\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/todo/schema.js\":\"b288bddb4b44e3fa\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7cdd28ee60b97ee7\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/actions.js\":\"0ecc55c559bfc536\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/defaultItems.js\":\"6b6dc7e438570cb5\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/facet.js\":\"476612258a6a219f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/holdRecognizer.js\":\"721af7940ede1f0d\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/touch-selection/index.js\":\"1d749b43924e5c1c\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/update-indicator/UpdateIndicator.js\":\"a8d282e24cc42f02\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/update-indicator/index.js\":\"4e74a3a511e449ca\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/update-indicator/loadTimes.js\":\"d8331755581e9b50\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/VideoNotesRenderer.js\":\"13eff658c8d02c9e\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/VideoPlayerRenderer.js\":\"356a971c1ca63406\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/VideoTimeStamp.js\":\"5dd80eb5581a7be3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/actions.js\":\"609780440fb50750\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/index.js\":\"fc511025b1990508\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/markdown.js\":\"4a017daf435f85de\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/notes.js\":\"4965a51e39a03eb3\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/registry.js\":\"4133a2cf84292c44\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/remark-timestamps.js\":\"136bd852237d0968\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/video-player/view.js\":\"475208b7e9cabc28\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/LinkHints.js\":\"1f6b80bd99bcec5f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/index.js\":\"6d681df8b6d40b30\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/model.js\":\"7374d9f294d4cf3f\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-link-hints/settings.js\":\"2b1d3c06729cd135\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-normal-mode/actions.js\":\"9d25059eec2c9117\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-normal-mode/index.js\":\"9199f1b520137681\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/vim-normal-mode/interactions.js\":\"5e51402ede61bc65\",\"/knowledge-medium/pr-preview/pr-1865/src/plugins/workspace-header/index.js\":\"97ef11717b4e6279\",\"/knowledge-medium/pr-preview/pr-1865/src/registerServiceWorker.js\":\"a042bcfbc46a8082\",\"/knowledge-medium/pr-preview/pr-1865/src/requestPersistentStorage.js\":\"20774adccfc211fb\",\"/knowledge-medium/pr-preview/pr-1865/src/services/authRequestDeadline.js\":\"cba54f9f4b75d3e6\",\"/knowledge-medium/pr-preview/pr-1865/src/services/authStorage.js\":\"a242de0b33788ce4\",\"/knowledge-medium/pr-preview/pr-1865/src/services/powersync.js\":\"f898685ed5ee9bde\",\"/knowledge-medium/pr-preview/pr-1865/src/services/supabase.js\":\"d5947e7776547d05\",\"/knowledge-medium/pr-preview/pr-1865/src/services/uploadErrorClassifier.js\":\"64255d4f4bb5848e\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/ActiveContexts.js\":\"5354fdae77b8a501\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/HotkeyReconciler.js\":\"275eb26a4c782c4f\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/WipeLocalDataDialog.js\":\"f3040ab166867501\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/actionDispatch.js\":\"49e3963430f4fddd\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/actionRefItems.js\":\"c52e54e4a7fbcbbd\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/applyKeybindingOverrides.js\":\"c8412b4107d9cc52\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/blockActions.js\":\"ae58c28cf8fa582b\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/blockMergeGesture.js\":\"9ee45ad91647a7e6\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/canonicalizeChord.js\":\"b4037689cae4d533\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/defaultContexts.js\":\"d8d74b58921f8419\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/defaultShortcuts.js\":\"90c923129b11d4b4\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/effectiveActions.js\":\"0a781497b5e68be7\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/gestureAction.js\":\"8c02da3134c816b7\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/gestureBinding.js\":\"9e02a3b22b726213\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/holdRegistry.js\":\"73e917db5e874126\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/keybindingConflicts.js\":\"ef8dd92ff2f87d9c\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/keybindingOverrides.js\":\"6a4f4e50480fd2fb\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/pointerAction.js\":\"c29416d632263761\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/resolve.js\":\"84c1074b2d62da6f\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/runAction.js\":\"b2c29f0141a8f434\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/sequenceMatcher.js\":\"1d41693678d563d1\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/types.js\":\"3e2ffe16d5af7e13\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/useActionContext.js\":\"54e01d700a474dbe\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/useActionDiscovery.js\":\"f65c615861061d8f\",\"/knowledge-medium/pr-preview/pr-1865/src/shortcuts/utils.js\":\"46645b5934b99f77\",\"/knowledge-medium/pr-preview/pr-1865/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1865/src/sw/bootStore.js\":\"eefe08264e10c5eb\",\"/knowledge-medium/pr-preview/pr-1865/src/sw/previewDatabases.js\":\"5987f4f4040dff49\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/byteTransform.js\":\"0015b312ce2fb670\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/attachmentCleaner.js\":\"471106fc13d74788\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/attachmentParts.js\":\"00e63b8a9fe51959\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/bundleParts.js\":\"4fe99d9748da28f9\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/bundleRecord.js\":\"68d55a79acc30dcd\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/manifest.js\":\"1f5ed7a68aba8694\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/takeBundle.js\":\"3f5174fca5b9500a\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/bundle/verifyBundle.js\":\"29cf475f001d767b\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/cleaningStage.js\":\"2380abb7831a0153\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/conversionKey.js\":\"3b3beff7617baaf5\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/conversionServer.js\":\"f4d0973f7376711b\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/flip.js\":\"066f6013867e3de9\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/flipAttempts.js\":\"49396e4d9194d09a\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/pages.js\":\"7e1a85ad3ffc2aac\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/preflight.js\":\"9c7c2d70250557c7\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/reseal.js\":\"7d9fa92fb80fee1c\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/runConversion.js\":\"8a2e4135c418b7e8\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/runLock.js\":\"3affd6172075559d\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/sealing.js\":\"8c81816d1c4b1919\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/sealingStage.js\":\"c1ff76e851dfd6c9\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/stage.js\":\"b04b579b41c02b3b\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/conversion/verifyReseal.js\":\"066fb5487bcf508e\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/aad.js\":\"0d79ca63a7e5e080\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/aead.js\":\"b83be30afe8270c5\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/base32.js\":\"931f1ffa26f2b3be\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/base64url.js\":\"2bab5fe628b90eea\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/binaryEnvelope.js\":\"cfb4a8088135b3ad\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/byteAead.js\":\"86a48452f90ad401\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/canary.js\":\"ed78ef020987c02d\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/contentHash.js\":\"82da595c9e69f829\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/contentKey.js\":\"5212b2598cc99aca\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/derivedIdNamespace.js\":\"0f89fda9cc698e15\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/envelope.js\":\"b7fdca03d51a00a2\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/hex.js\":\"ba59b6ef9c99802c\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/sha256Hex.js\":\"b5b536ad27938976\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/crypto/workspaceKey.js\":\"8929085520a46202\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/conversionState.js\":\"01a0179d697fdb8b\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cc9bd03b99fc371c\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/pastedKey.js\":\"865a422b54aa9552\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ca2829db3c5070fc\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/flows/upgradeWorkspacePin.js\":\"69bbe9fc9da0a3fc\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/keyStore.js\":\"89a564f7fb8740e7\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/mintWorkspaceKey.js\":\"9e0555096713766b\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/modePin.js\":\"e029938a04790f02\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/openWorkspaceKeys.js\":\"31cd5c5634bda366\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/resolveWorkspaceEntry.js\":\"bf2376302218413d\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/resolver.js\":\"3110d47345ffa035\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/keys/workspaceAccess.js\":\"c7c7f770b27d93f8\",\"/knowledge-medium/pr-preview/pr-1865/src/sync/transform.js\":\"4213e41b37268130\",\"/knowledge-medium/pr-preview/pr-1865/src/themeBootDefaults.js\":\"db86de6824be7e68\",\"/knowledge-medium/pr-preview/pr-1865/src/types.js\":\"ab9c206129a688bb\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/ClientLocalSettings.js\":\"fdd85d3246d859e4\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/abortableSleep.js\":\"62e1b3e3e44f5d6c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/array.js\":\"cafa95dd5e178749\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/backlinkAutocomplete.js\":\"cb6baed57f4afaf3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/blockCrumbs.js\":\"ff1d286b187c5c73\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/blockrefAutocomplete.js\":\"17182443e234612a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/cadencedIdleJob.js\":\"efd144b4211b5783\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/callbackSet.js\":\"83470cb2bf97ad35\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/clientId.js\":\"663ab1335533ca7b\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/codemirror.js\":\"ec3c42f126286789\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/codemirrorCompletion.js\":\"37d481ebdc5779ad\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/copy.js\":\"4681fd42da8cc0d4\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dailyPage.js\":\"e1bc7fbe7343024b\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dbForensics.js\":\"3c7e78c0ed48212e\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dbForensicsHooks.js\":\"036cc4e7fc364574\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/deleteBlockThroughUi.js\":\"b31426a996f4e9a1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dialogs.js\":\"5c1e1e366f73e14c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/dom.js\":\"517f1556d2848328\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/downloadBlob.js\":\"1f0c20f44a3b45cc\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/exportSqliteDb.js\":\"71d2e172893b7af1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/fileSystemAccess.js\":\"fc1306bf7929be19\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/flipSlide.js\":\"d28089fba03afead\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/fnv1a.js\":\"6d47262a378f2930\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/formatBytes.js\":\"06cb9ffd25da756a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/fuzzyRank.js\":\"c2797fd8bb84f6f1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/idbKeyedStore.js\":\"85526511732f346e\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/idleCallbackPolyfill.js\":\"4d3c5ae1683a9c50\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/keyboardAwareScroll.js\":\"19db18b5f3baf894\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/keyboardViewport.js\":\"a67e9455142fd86a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/lastWorkspace.js\":\"43abeca68fe0dc0d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/layoutColumns.js\":\"17c4e94162b99c50\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/layoutSessionDom.js\":\"3f07e32d0757ae0b\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/layoutSessionId.js\":\"53df65eefdab8d83\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/linkClickGestures.js\":\"a030269c36326613\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/linkTargetAutocomplete.js\":\"087766dfa8dc24c3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/localDbCorruption.js\":\"9732baba29b7f9e3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/localDbRecovery.js\":\"b49b64cd79c49726\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/markdownParser.js\":\"3bc374fa1bed9356\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/memoize.js\":\"80fe9eaff3b2550c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/nameFieldCommit.js\":\"0f9bb8f7813a68a0\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/nameList.js\":\"7bc4e26976e621f9\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/navigation.js\":\"6ba80de90210e793\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/omnilinerNamespace.js\":\"384148c60dbd9a40\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/opfsPageScan.js\":\"ed19aea9e76e8d6a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelClearance.js\":\"a5b2ecee0a2cf934\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelHistory.js\":\"f3a8a0388ec036c3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelLanes.js\":\"b4ca1cf33341b7f1\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelLayoutProjection.js\":\"29b88868688f2166\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelScrollAnchor.js\":\"b16d4d88ab76db6d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/panelUrlFlags.js\":\"cf35ae20554597c6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/platform.js\":\"4371496c9efb9c53\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/pluralize.js\":\"5c61a43808af4e04\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/propertyCreation.js\":\"cb34f201c45c480d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/propertyNavigation.js\":\"c0a7a0c5b24585fd\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/propertyValueContext.js\":\"033df4cd3accb846\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/react.js\":\"f426656deeed673e\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/relativeDate.js\":\"2d4fc82d05317bd6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/relativeTime.js\":\"c267078943af1196\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/renderScope.js\":\"9189ac4c0bea332e\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/resolvedThenable.js\":\"e7c3a82450541ff3\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/routing.js\":\"2ee347afa7206a61\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/safeMode.js\":\"71f589daa5b9dbae\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/scheduleIdle.js\":\"9e38a792d1e3139c\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/screenWakeLock.js\":\"8921c36729aa1e77\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/selection.js\":\"8012f009acbf8c1d\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/softKeyboardGrab.js\":\"63e50636fbc288ec\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/startupTimeline.js\":\"0588426d14db37cf\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/state.js\":\"39575153696dadfe\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/string.js\":\"22500579871e6161\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/surfaceZoom.js\":\"745f4e72d79f6a43\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/time.js\":\"354978dac3c535e7\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/toast.js\":\"fc572a41e168a9f2\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/toggleStore.js\":\"91a0c00c79b6944a\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/untilStopped.js\":\"dcafd6fa3f779b25\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/userActivity.js\":\"aefc686fbae8d096\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/viewTransition.js\":\"5ffceb554327f706\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/viewport.js\":\"5310746e45eda928\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/webLock.js\":\"145b0a7586d40467\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/workspaceRecovery.js\":\"57c4d97fff771e19\",\"/knowledge-medium/pr-preview/pr-1865/src/utils/workspaceSnapshotStore.js\":\"76860ed24ea4d5e6\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-compiler-runtime.js\":\"4f25ad69360f6b14\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-client.js\":\"3233187ab94ebb1b\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-server-edge.js\":\"45b7c28be41e6fc2\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-server.js\":\"1b42ba26b66904d4\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-static-edge.js\":\"ee43229213f1a7cb\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-static.js\":\"b3f464da48e304e7\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom-test-utils.js\":\"b26d3ee5e4f4de74\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-dom.js\":\"868cb7b411322eba\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react-jsx-runtime.js\":\"98fad07b70c7c6b8\",\"/knowledge-medium/pr-preview/pr-1865/src/vendor/react.js\":\"f474749de8a691e0\",\"/knowledge-medium/pr-preview/pr-1865/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1865/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1865/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
