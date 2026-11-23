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
		buildId: "a10e51edbb7c-0862ebe2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/\":\"0ed1fc0b357a605e\",\"/knowledge-medium/pr-preview/pr-1868/index.html\":\"0ed1fc0b357a605e\",\"/knowledge-medium/pr-preview/pr-1868/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1868/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1868/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1868/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1868/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1868/assets/FacadeVFS-B1MpbFzA.js\":\"c9d4b2a672b40d53\",\"/knowledge-medium/pr-preview/pr-1868/assets/OPFSCoopSyncVFS-BBTzTvG2.js\":\"fbd34d856318b8bc\",\"/knowledge-medium/pr-preview/pr-1868/assets/OPFSWriteAheadVFS-50XVw2lA.js\":\"8a5796845aeabbfd\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-Dp1ApXit.js\":\"b8cfab4e914551ae\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-async-DIHY8YLk.js\":\"6da179d18007e500\",\"/knowledge-medium/pr-preview/pr-1868/assets/worker-Bl0ZNVmu.js\":\"6d5d80ba2a3aaa26\",\"/knowledge-medium/pr-preview/pr-1868/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1868/chunks/app-DwCC3QFk.js\":\"b74cccc9bd38958b\",\"/knowledge-medium/pr-preview/pr-1868/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1868/index.js\":\"6e00295a7b3da78a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1868/assets/AccessHandlePoolVFS-eh6aOhOe.js\":\"9a51738371bdfc7c\",\"/knowledge-medium/pr-preview/pr-1868/assets/IDBBatchAtomicVFS-CuxpBoSE.js\":\"72d03a08cb64dbc9\",\"/knowledge-medium/pr-preview/pr-1868/assets/MemoryVFS-DxFe1Fo1.js\":\"d58b5999fc6b418f\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-M7xxHz78.js\":\"78b9eaff7b7378ad\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-async-qO7VJkSo.js\":\"7b62faa94ef36901\",\"/knowledge-medium/pr-preview/pr-1868/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1868/chunks/AccessHandlePoolVFS-B-au8Rvo.js\":\"33e2a92d803ebb03\",\"/knowledge-medium/pr-preview/pr-1868/chunks/FacadeVFS-CSRGPjKH.js\":\"2ea138c8dcca0e82\",\"/knowledge-medium/pr-preview/pr-1868/chunks/IDBBatchAtomicVFS-IWGQBpfq.js\":\"c13e533bb34c7037\",\"/knowledge-medium/pr-preview/pr-1868/chunks/MemoryVFS-8XzsaUon.js\":\"3e13538541f02309\",\"/knowledge-medium/pr-preview/pr-1868/chunks/OPFSCoopSyncVFS-CyTvSaDx.js\":\"933eccec6631aa5d\",\"/knowledge-medium/pr-preview/pr-1868/chunks/OPFSWriteAheadVFS-CYvHf0_1.js\":\"1de28030bbd6d866\",\"/knowledge-medium/pr-preview/pr-1868/chunks/Preview-DKtHnOID.js\":\"3a1b055c7b97fec2\",\"/knowledge-medium/pr-preview/pr-1868/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1868/chunks/card-CaJWXd6Q.js\":\"97131869b010387b\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-m_u_bHlw.js\":\"fb1a5995347f2a4f\",\"/knowledge-medium/pr-preview/pr-1868/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1868/chunks/mc-wa-sqlite-DkSLlo8u.js\":\"506235e092371067\",\"/knowledge-medium/pr-preview/pr-1868/chunks/mc-wa-sqlite-async-DFQqKPKI.js\":\"8d5112008cdd6598\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-2XaR7Rsk.js\":\"8212a9b7e261f803\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-4C1e1WNI.js\":\"c87dafe8f79a5bfd\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-DeoYsw7Z.js\":\"1ccb12c8ed75846a\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-J38gp7dQ.js\":\"0db312a378593691\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-WnOpmvZn.js\":\"f349087ac3864f54\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-X2hsRcbB.js\":\"47f5669a9803e383\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-aAiBu3Eu.js\":\"bd7ce1236a1db568\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-bvaRcqXf.js\":\"a61d4ddeda9b867a\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server-legacy.browser.production-CHUjGm46.js\":\"0fc4ee937a29315c\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server.browser.production-Cu-xCOdq.js\":\"ba89f8a59b887ecb\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server.edge.production-BgmZFwZl.js\":\"6b8c2e731440bca5\",\"/knowledge-medium/pr-preview/pr-1868/chunks/server.browser-Cd3A3LGG.js\":\"947d7ad515570242\",\"/knowledge-medium/pr-preview/pr-1868/chunks/textarea-BjB16Ith.js\":\"8a941f3753796438\",\"/knowledge-medium/pr-preview/pr-1868/chunks/ui-B1k3Nl75.js\":\"57b3355619775258\",\"/knowledge-medium/pr-preview/pr-1868/chunks/wa-sqlite-BVcp6u9J.js\":\"6ce9167e6be5d795\",\"/knowledge-medium/pr-preview/pr-1868/chunks/wa-sqlite-async-DSBBl4QG.js\":\"edda67ad6161db88\",\"/knowledge-medium/pr-preview/pr-1868/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1868/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1868/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1868/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1868/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1868/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1868/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1868/src/App.js\":\"e67f9f28c82046ce\",\"/knowledge-medium/pr-preview/pr-1868/src/appUpdate.js\":\"2afa67d4d334c3cb\",\"/knowledge-medium/pr-preview/pr-1868/src/appVersion.js\":\"97febc28c04a258e\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/initialLayout.js\":\"8f8b3d0ab971587c\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/openWorkspaceData.js\":\"0fecac9d69df20fd\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/resolveWorkspace.js\":\"26f74c1aabb6466a\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/workspaceBootstrap.js\":\"40f7cb2d16482116\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockComponent.js\":\"1dcb31b908e2fe47\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockCrumbs.js\":\"33edbde4d8345b67\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockEditor.js\":\"61ebb5bacf37894c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockLoadingPlaceholder.js\":\"3c38f6ddd703ff55\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockProperties.js\":\"3dcfea37e11e7d6f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockSearchPicker.js\":\"00f6870f91a30c33\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ConfirmBulkDeleteDialog.js\":\"8b01e303cd3c8dd0\",\"/knowledge-medium/pr-preview/pr-1868/src/components/DividerHandle.js\":\"b81e93ab0bf96d87\",\"/knowledge-medium/pr-preview/pr-1868/src/components/DraftEditor.js\":\"89a84fe99dd4b0a6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/GutterPill.js\":\"e1c32921e4a3c43d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/Header.js\":\"ec44f0af1fa3382d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/LazyBlockComponent.js\":\"4a31a6f5b2b62c49\",\"/knowledge-medium/pr-preview/pr-1868/src/components/Login.js\":\"c7c44052fda21b72\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ZoomableSurface.js\":\"96c7d237eb271c5b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/editModeKeepalive.js\":\"6d7bf0600fe69bdc\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyDisplay/PropertyDisplayScope.js\":\"393ada97b503829b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6844f1745177dba4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/RefPropertyEditor.js\":\"e37887742948da46\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/RefTargetTypePicker.js\":\"5dfa673adb841cad\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/SelectPropertyEditor.js\":\"0fa9c0da8ec8b6fd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/TypesPropertyEditor.js\":\"90de4001d4830076\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/defaults.js\":\"ee1010201cbacca5\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/kernelValuePresets.js\":\"b08668b028af9c0f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/selectablePresets.js\":\"d54e0e0c4f66b37c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/typesPropertyUi.js\":\"c1afb0af0325d8c8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/AddPropertyForm.js\":\"8c031467af6f0194\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/PropertyPicker.js\":\"b0e2e76c0f4b83ca\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/PropertyRow.js\":\"b801e8bc0ac6c80f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/Rows.js\":\"fc2675184db67a6f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/actions.js\":\"7de912559d43001c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/declarationOnly.js\":\"fd9b7da49a332d80\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/layout.js\":\"cea730832fdc4c0e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/model.js\":\"c9c92bb36bbecfd8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/shapeUi.js\":\"bd2ac1e8c70dad91\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/shapes.js\":\"72c90348e4545454\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/usePropertyEditingActivation.js\":\"849b635b4ed43d9b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/visibility.js\":\"07b2beeac22bd264\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanelSections.js\":\"961ce5ffae802ab1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockEmbed.js\":\"2222f7d96dfdcef3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockLink.js\":\"bbf347df4c79758b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockRef.js\":\"fe9919b6c47aa8bc\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/ReferenceLink.js\":\"0b06975dec9b6902\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/cycleGuard.js\":\"56501ff27fe3611b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/cycleGuardContext.js\":\"5119e78894ec6ebf\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/linkInteraction.js\":\"74493ded9949fea8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/referenceLayout.js\":\"623d89b2fb820a7f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/useBlockRefAncestors.js\":\"3404212be9fe3a4b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockGutter.js\":\"52375dc950d7e678\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockInfoDialog.js\":\"7ceef2ccf1e4f94c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockTypeBlockRenderer.js\":\"201e470e23fc883f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BulletHoverCard.js\":\"846d410b3f7948ef\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/CodeMirrorContentRenderer.js\":\"172caafd6e1ea092\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"446429e519c1cb7c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/ColumnResizeHandles.js\":\"509e5ca38d978a9f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1a261b15776f4083\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/DefaultBlockRenderer.js\":\"90b5a471786c7a96\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/LayoutRenderer.js\":\"bee6b63e0111a9b4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/MarkdownContentRenderer.js\":\"642db2c13f8d891a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/MissingDataRenderer.js\":\"1b8b7d6dbb0fc479\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/PanelRenderer.js\":\"8a7cc9d02f635e8d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/PropertySchemaBlockRenderer.js\":\"baaf6a23ba55c169\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/TopLevelRenderer.js\":\"475cd7678aceff8b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/blockGutterMode.js\":\"e5063b32738736f1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/blockTitleText.js\":\"7f2dfdd286ae26ee\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/fieldCreationKeydown.js\":\"ba70186e57edd69b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/layoutRootContext.js\":\"6914f1a05dfb9fe7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/typeChip/TypeChip.js\":\"b5824343543142b4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/typeChip/chipStyle.js\":\"2a2ca8d77a19256c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/anchored-floating.js\":\"d22b8f46aef36caa\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/button.js\":\"d7febcf6b9427dac\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/card.js\":\"f45e86f52a3a19d3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/checkbox.js\":\"4555cf227caa244a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/collapsible.js\":\"a4bc972c46ac955d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/command.js\":\"8b4c00019c1b57f6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/context-menu.js\":\"6c6f227a8316af0e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/dialog.js\":\"a9bcc9e9f83220e4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/dropdown-menu.js\":\"52caf665493bdc5c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/floating-listbox.js\":\"62689d35e14c0ce2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/index.js\":\"a4932700b6cb5d2f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/input.js\":\"4dff593a8ce51eba\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/kbd.js\":\"20ba4b67bf4c4819\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/label.js\":\"a5c5089776d0e38f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/textarea.js\":\"4cc61bc541a3f7af\",\"/knowledge-medium/pr-preview/pr-1868/src/components/useEditModeYieldKeepalive.js\":\"798680f0034a5417\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/BootFallback.js\":\"0d73dd53f0a93e48\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/FocusedRowLazyMount.js\":\"92f0f0df24d2f849\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/LazyViewportMount.js\":\"3f573c985d34584b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/LocalDbCorruptionFallback.js\":\"21331ccd4298da44\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/error.js\":\"3ec698fd3cd1c4c3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/lazyMountRegistry.js\":\"f3f05a599abb313a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/suspense.js\":\"a29d5ef38af21bae\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/CreateWorkspaceDialog.js\":\"2305c969b1029263\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/PendingInvitations.js\":\"cb756f2d727e3088\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/SyncProgress.js\":\"1def7b85e918245e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/UnlockProgress.js\":\"f17f223d4d5a8138\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceKeyGate.js\":\"5365588e878dff96\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSettingsDialog.js\":\"fdf1b0bf7dcec43b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSwitcher.js\":\"d678b5848cbc3545\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSyncGate.js\":\"6352825cf89ab29a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/ConversionFlow.js\":\"524e3c1acc637cc6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/ConversionFlowHost.js\":\"acc255edf572ed55\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/EncryptionSection.js\":\"b9e80024fad1a293\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/attachmentPrompts.js\":\"70265f44e4bdd762\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6a74fc1b6a51591e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/conversionFlowDeps.js\":\"a155948d84fb8e48\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/conversionFlowStore.js\":\"7a1b08b9cf7c2690\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/flowUi.js\":\"f150caae7abe3c95\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/useConversionRun.js\":\"89f90637aee74d82\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/keyUi.js\":\"3428719772f98bb3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/useCloseOnKeyLoss.js\":\"6e5affbfc2a98720\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/useCloseOnServerE2ee.js\":\"30f23e1b60fed737\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/workspaceUnlocked.js\":\"4194b63235c5b503\",\"/knowledge-medium/pr-preview/pr-1868/src/context/backgroundSubtree.js\":\"591826fe3c75d619\",\"/knowledge-medium/pr-preview/pr-1868/src/context/block.js\":\"a241da6ffcecaba5\",\"/knowledge-medium/pr-preview/pr-1868/src/context/layoutWsContext.js\":\"44cc471431e783a9\",\"/knowledge-medium/pr-preview/pr-1868/src/context/propertyDisplay.js\":\"739a203a9c12f056\",\"/knowledge-medium/pr-preview/pr-1868/src/context/repo.js\":\"8fcf5c8d27b884a3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/aliasClaim.js\":\"289aea36aace234e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/aliasSeatNamespace.js\":\"fcde152a5b02b98e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/blockData.js\":\"a85f489b9b16e7d7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/blockType.js\":\"a5fc39cea2139035\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/changeScope.js\":\"67992ec8f6aea5ec\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/codecs.js\":\"5b2f11a3c1bc9a66\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/derivedData.js\":\"8b870ad35b8e403b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/errors.js\":\"239f119944d8b863\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/events.js\":\"932f8fc47f6efe53\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/handle.js\":\"cf757010aed2db3b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/index.js\":\"9003bbc6dd76de9a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/mutator.js\":\"0eff297ac7d30383\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/processor.js\":\"319c8922fe98b711\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/propertySchema.js\":\"450e8586f5504b0e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/query.js\":\"4811977a920de36b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/sameTxProcessor.js\":\"e1a51f7d887dd650\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/schema.js\":\"cf757010aed2db3b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/tx.js\":\"cf757010aed2db3b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/typedBlockQuery.js\":\"e336cb4b42a2a773\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/user.js\":\"1c475e50eb441bb4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/valuePresetCore.js\":\"138e26d9bc667557\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/valuePresets.js\":\"80ac685df48ca8b1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/attachmentCleanerIOVerb.js\":\"3edd7909fdecab8a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/block.js\":\"1996c1fe31f56620\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockCache.js\":\"da95278e5393cc2b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockId.js\":\"a9daafac7afadce4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockLiveness.js\":\"1addeede10b8d786\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockMerge.js\":\"893bf4ce30eaa40a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockSchema.js\":\"ce788d8b81686882\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockTypeLookup.js\":\"d4d95f59efbfd482\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockTypes.js\":\"0e09c5136e6a7a71\",\"/knowledge-medium/pr-preview/pr-1868/src/data/childrenView.js\":\"84bbd72cc90c1000\",\"/knowledge-medium/pr-preview/pr-1868/src/data/clientContext.js\":\"ca64f8201d92a485\",\"/knowledge-medium/pr-preview/pr-1868/src/data/dbFileSiblings.js\":\"2043554064e912c5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/definitionSeeds.js\":\"bcf773cd5de5be70\",\"/knowledge-medium/pr-preview/pr-1868/src/data/derivedIds.js\":\"0038606c232f77a6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/drawnSubtree.js\":\"3bf2da3e4e92e782\",\"/knowledge-medium/pr-preview/pr-1868/src/data/facetBridge.js\":\"568a0927be1e29bd\",\"/knowledge-medium/pr-preview/pr-1868/src/data/facets.js\":\"220603f707e1df9d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/globalState.js\":\"7e30c2bf7f323e8c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/aliasClaimRederiveProcessor.js\":\"6ccb145b9e730bfe\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/ancestorBatch.js\":\"d33fb248ed79ab6a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/blockTypeTypeifyProcessor.js\":\"c0ff92d700bf5c63\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/clientSchema.js\":\"bee3f81000e5555d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/commitPipeline.js\":\"f5e27361cc42f231\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/devAssertions.js\":\"d63882bf9ccc9e37\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/firstSync.js\":\"5f6f815b39323932\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/freshInitialLoad.js\":\"a5c9838ebc028d29\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/graphBackfillClaim.js\":\"a73095dcd0021399\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/handleStore.js\":\"663a57b57aaf97e5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/idleMarkerJobs.js\":\"02b19ac1ae193b35\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/initialDownload.js\":\"58d55540c98f0422\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/initializeClientDatabase.js\":\"5485fe060701a63b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/jsonCanonical.js\":\"f9035da6748feb8d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelInvalidation.js\":\"19715de49aa9a4ed\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelProcessors.js\":\"58a71d5d8df77c18\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelQueries.js\":\"9c5080cf34c5e33e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/mergeTypeMembershipProcessor.js\":\"8db3b7de11e2a93d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/normalizeReferencesProcessor.js\":\"102653d23689c790\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/poolInstrumentation.js\":\"d018d42b46983326\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/processorRunner.js\":\"ef98b462eb531c60\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyCellBackfill.js\":\"f37a48dedab93dbd\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyChildMint.js\":\"8dddbdb00a5a0456\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyChildrenProcessor.js\":\"8814118c187116b3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyDefinitionChangeProcessor.js\":\"122e65b6e489b2f2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyDefinitionSynthesis.js\":\"cffe302a936b9ce7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyKeyScan.js\":\"4d1d2745afb890ac\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertySchemaResolution.js\":\"226f058c81a88bb2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyValueEdits.js\":\"2cd8d9dba172f893\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/raiseProtocol.js\":\"abf31598d3c3d057\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/readBatch.js\":\"c0e50c8c6fc6810e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/refProjection.js\":\"de495f11399489b0\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/referenceTargetLookups.js\":\"952f58c245cf57ed\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/referenceTargetProcessor.js\":\"e348ff9eb67b0338\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/replayMerge.js\":\"60b3d266bab25fd6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/sqlBinds.js\":\"c01e83fe12b7583e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"66bedb15554d703f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/arrivalProcessors.js\":\"a75beec10da8fd83\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/invalidate.js\":\"f2678df896e437fa\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/materialize.js\":\"2d41eaf28e75f364\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/observer.js\":\"7b29a526d2ddc3b9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/reconcile.js\":\"50cac2559f869867\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/timingMetrics.js\":\"129772b00852a245\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/treeQueries.js\":\"5fd955a583fce271\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/txEngine.js\":\"61549e9e040293ed\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/txSnapshots.js\":\"e4cbdc2d6c6bbd70\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/typedBlockQuery.js\":\"89367b91e5465e1c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/undoManager.js\":\"e4e1ff7742dfdd2e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/invalidation.js\":\"a2129e9b6ba41c56\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelDataExtension.js\":\"f4d8a5b93f3ded0f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelPage.js\":\"952e140306287555\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelValuePresetCores.js\":\"31cc9e72cba4a062\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbCorruptionSignal.js\":\"b99f57215c76bfe9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbStorage.js\":\"1a2c71c4c7c1b7eb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbVfs.js\":\"78a7052da1280913\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localSchema.js\":\"0415aa2cccc039f4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/maintenance.js\":\"da63a47053b5499b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/mergeProperties.js\":\"a406e6528f8de848\",\"/knowledge-medium/pr-preview/pr-1868/src/data/metricsConsoleHook.js\":\"2241c9f51e046138\",\"/knowledge-medium/pr-preview/pr-1868/src/data/migrationsPage.js\":\"0e39e3e285b60d89\",\"/knowledge-medium/pr-preview/pr-1868/src/data/mutators.js\":\"632165122e98209f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/orderKey.js\":\"b8f72011136cf3c7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/orderKeyPlacement.js\":\"6ddf2d1259fa4afb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/outlineSurface.js\":\"678a3b50c5632b9c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pendingEditorContent.js\":\"8251dac7d87a0386\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pendingUploadsSql.js\":\"c254eb4642538253\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pluginStateExtensions.js\":\"2a4fb54ae843e9b2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/powerSyncLogger.js\":\"f914125ea441259d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/projectorRuntime.js\":\"f91c17699952f8fe\",\"/knowledge-medium/pr-preview/pr-1868/src/data/properties.js\":\"07d9dd9781d84086\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertiesPage.js\":\"84b6ff3076f31e31\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyChildren.js\":\"578f266665e6faf2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionFanout.js\":\"5a02df9e5e02220c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionMetadata.js\":\"d6dea72a1bdb7856\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionRegistry.js\":\"29a2eb63ae9432be\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDisplayMode.js\":\"3bce2bdba1662b08\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyRowCreation.js\":\"6939ca82e3d9acee\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertySchemaCreation.js\":\"bd11f0b47116d5e5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertySeeds.js\":\"64f73a7299dd6fc5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/recentsPage.js\":\"0f1feeb52a38217a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/referenceBlock.js\":\"3d30bb805954f4d8\",\"/knowledge-medium/pr-preview/pr-1868/src/data/rejectedUploads.js\":\"a2c21124049e5913\",\"/knowledge-medium/pr-preview/pr-1868/src/data/releasePowerSyncConnection.js\":\"958da1c544934d8a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/repo.js\":\"7ea1adc4d8482fee\",\"/knowledge-medium/pr-preview/pr-1868/src/data/repoProvider.js\":\"227293a687518c87\",\"/knowledge-medium/pr-preview/pr-1868/src/data/rowProperty.js\":\"e942a3ac939222d5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/searchFilter.js\":\"4a8637fc44f1cb8b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/seedIdentityLedger.js\":\"f00aa14bb43766fa\",\"/knowledge-medium/pr-preview/pr-1868/src/data/stateBlocks.js\":\"78b11e1bfc010002\",\"/knowledge-medium/pr-preview/pr-1868/src/data/structuralEditPolicy.js\":\"50f1e9bd706c86f1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/subtreeDelete.js\":\"75e4a35026b56758\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncStreamLock.js\":\"44ab9fed2a6de3ef\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncedTableSqlRecognizer.js\":\"069cbb35575e8aa7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncedTableWriteGuard.js\":\"87132acbb7682feb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/targets.js\":\"96c61807bfafdbf3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeColors.js\":\"305e798207008403\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeDefinitionMetadata.js\":\"3b5bb550a1a77110\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeDefinitionRegistry.js\":\"8eff40f111d2ac5f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeExtraction.js\":\"3dcb936fce8ee500\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeInitialValues.js\":\"73cf3a9ee21f7803\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typePropertyGroups.js\":\"3d5ebd1a50523f9e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeSeeds.js\":\"44e1e582f189d432\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeTagger.js\":\"0fe39fe82f243cc1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typedRecords.js\":\"96ab37ca6811ae73\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typesPage.js\":\"1fddd897ee087af6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userPrefs.js\":\"41c64a5f8e4f1ce7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userSchemasService.js\":\"2ac1b7d4a78c8a66\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userTypesService.js\":\"2a091920a9b47c04\",\"/knowledge-medium/pr-preview/pr-1868/src/data/valuePresetRegistry.js\":\"7d20bca8d0031537\",\"/knowledge-medium/pr-preview/pr-1868/src/data/visibleChildren.js\":\"01dcf190e1ee5570\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceConversion.js\":\"1ecf596916d41d03\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceFirstSync.js\":\"fb56725c5d45ba87\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceIdNamespace.js\":\"e1c6b87512340ed5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceSchema.js\":\"9ac1c9662bca3e81\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaces.js\":\"ad50e8a8296e428c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/writeAheadLog.js\":\"fb276617b3d9698e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/BlockPasteShellDecorator.js\":\"12096579079fac9a\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/atTrigger.js\":\"69bcd903db2ab360\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/autocomplete.js\":\"50a263dd6367fff9\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/codeMirrorExtensions.js\":\"ad270ebe37edd521\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/contentFlush.js\":\"c0958ea10e41eb6e\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/defaultInteractions.js\":\"5057396d652c9eee\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/editSettleSignal.js\":\"5daaedeb65c5f67e\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/insertImage.js\":\"ed628fcbec78c0ba\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/referenceCompletionRange.js\":\"872523f2e11771e7\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/referenceTargetTypes.js\":\"4647bc1a37596258\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/syntaxContext.js\":\"580d999fd8077df2\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/triggerMatch.js\":\"5b3c9704a40e8c21\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/AppRuntimeProvider.js\":\"293b07f153dff497\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/BlockFocusShellDecorator.js\":\"ab73bf82d6746fcd\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/ExtensionRenderBoundary.js\":\"d05c868c35cca933\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/PanelContentRecovery.js\":\"67a7dc30a38fd783\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/apiCatalog.js\":\"1af20f8be9ffab4a\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/approveExtensionHere.js\":\"1389d7382b404219\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/armedCutAppMount.js\":\"01d110b9866577b1\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/batchableKeyedStore.js\":\"e330c4334f7828bb\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/blockInteraction.js\":\"834e7a97701637b2\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/blockSelectionAction.js\":\"4a0e4c7832d50e83\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/compileExtensionModule.js\":\"14ddf1ca909b13c4\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/compiledModuleCache.js\":\"6aba4ff3cb844ec9\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/continuousGestures.js\":\"244df716649604ee\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/core.js\":\"c017f209d9991841\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/defaultRenderers.js\":\"ae7c5195f6b61ff5\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/definitionFanoutAppMount.js\":\"17e7e3ef8fcadea4\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dialogAppMount.js\":\"ee548f5642f6eaeb\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dynamicExtensionSeeds.js\":\"dac269efb4701c94\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dynamicExtensions.js\":\"cbb1feb24336ac7b\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/exampleExtensions.js\":\"e8bf661ddd33eb48\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionApprovalStatus.js\":\"338fbf0d9d770def\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLoadErrorToast.js\":\"c6d83a942c6efb46\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLoadErrors.js\":\"0ece1260af6e1ff3\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLookup.js\":\"976c2adc46780acc\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionToggles.js\":\"ad25077513ac23b9\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionUtilitiesCss.js\":\"30346509f2312947\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/kernelPageDeletionGuard.js\":\"b5dc76576a2216af\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/liveRuntime.js\":\"cab526e43492b978\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/openExtensionsSettings.js\":\"c79f0be3570467c4\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/overridesCache.js\":\"92e2840a9b11d741\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/pluginIds.js\":\"595fbccb3ad9322e\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/processorRejectionToast.js\":\"6ece96b52412fd81\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/runtimeActions.js\":\"ffa702af1c1b3bcb\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/runtimeContext.js\":\"f068d8fc7b132230\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/staticAppExtensions.js\":\"58c366d0e1044701\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/staticDataExtensions.js\":\"6f6775cb03616ecf\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/toastAppMount.js\":\"09833901acb8b1b6\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/useOverrides.js\":\"04bd9c5d85a1f225\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/useShortcutSurfaceActivations.js\":\"cdd579d62fca210e\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/discoverToggleTree.js\":\"6c0cca562f6c60a2\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/facet.js\":\"b6577fc3bb0976fb\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/resolveAppRuntime.js\":\"b576d55090bf3298\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/runtimeEvents.js\":\"be75e4eb1e8da2d1\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/togglable.js\":\"8b1d8376371011f8\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/variantFacet.js\":\"81b37ba86aa7f32a\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/verbFacet.js\":\"44ddf18647f62e03\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/block.js\":\"ca6108e61d35eec8\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/focusedChild.js\":\"bbcbca0900284fd6\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/propertySchemas.js\":\"cf4953e2cbc8e074\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/typeRegistry.js\":\"b7f29f2807755976\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useAncestorCrumbs.js\":\"106e00d30dc14085\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useAutocompleteListbox.js\":\"dd9cbe727c7def2f\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useDebouncedSearch.js\":\"ac6625f65492561f\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useDebouncedValue.js\":\"0bc3adf0ca441606\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useIsFocalRender.js\":\"1deb247cfbdf8035\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useIsReadOnly.js\":\"78bdf9048d3613ea\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useMaterializeBacklog.js\":\"f76ed43cb81efc1e\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useMinuteClock.js\":\"cf6e8530c4b628a6\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/usePanelLayoutProjection.js\":\"0168120045d9db28\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/usePendingInvitations.js\":\"f213b741b5fcf07f\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useRendererRegistry.js\":\"b139823a9bba9e51\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useRetainedFieldRows.js\":\"610c039ac5692449\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useWorkspaces.js\":\"1c2ecd704123146c\",\"/knowledge-medium/pr-preview/pr-1868/src/lib/utils.js\":\"9fe5e698eeb9a5e1\",\"/knowledge-medium/pr-preview/pr-1868/src/main.js\":\"12b939a2e5da52a1\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/MarkdownImage.js\":\"8438c75a999a10d1\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/blockSeparators.js\":\"de2576c0934dfb70\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/context.js\":\"fffc6f6b94dfa819\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/defaultMarkdownExtension.js\":\"00575b2b2bd7dd7d\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/extensions.js\":\"a7cfeb91a12331e5\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/renderMarkdownHtml.js\":\"33a73b08b4c3fd22\",\"/knowledge-medium/pr-preview/pr-1868/src/minimal-editor.js\":\"31aeee08ea91d631\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/armedCut.js\":\"74ae66ae469973a1\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/captureMediaVerb.js\":\"d7f0314ce3656f6e\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/clipboard.js\":\"d4477a311ec82c39\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/decision.js\":\"32dcfbde292adc69\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/operations.js\":\"f2455db30101bc3e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/account-header/AccountHeaderItem.js\":\"abbe403a6e845ccf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/account-header/index.js\":\"5932b95cb68798ba\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e743203f89c82d08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/askAgent.js\":\"3dbfc61bf98b8d3e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/askedStore.js\":\"130cbaf9e97b22c8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"703650a67a6fce4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/chipState.js\":\"0d44cc4a6f476219\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/dataExtension.js\":\"851cad582136c513\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/index.js\":\"9c7117844ce84567\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"859c1dca280ec396\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/schema.js\":\"c180140e02221262\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0512f0a489982387\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ba30d8b8c8e102de\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/addMedia.js\":\"431fae1755b09802\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d6c4db9fc839d0d7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/block.js\":\"509ec344ad46c0c1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/context.js\":\"04b3e58751270e3e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/displayIds.js\":\"60fbfeef1283b046\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/index.js\":\"3bcb39f256435452\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/outline.js\":\"af507118ca4a1553\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/properties.js\":\"a6b66ec35c2b6e23\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/refs.js\":\"33782a84fc32d3d3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e46c78eeee1702f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/search.js\":\"0b36ccd644a3d373\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/shared.js\":\"449aaa5446ed468b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9de10c25a88e2843\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/text.js\":\"8692bb0e72453fe0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentWrites.js\":\"f079d36b743e141a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/authoringCatalog.js\":\"4215b9a293aa33b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/blockRefTargets.js\":\"c1a28ec3aff1bffd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/bridge.js\":\"5bfe9665999fb546\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/bridgeLoop.js\":\"8dce083a5903dcf2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/changeHistory.js\":\"f09156a1f4abd670\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/commands.js\":\"b2214a6d5a767d23\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/commentsCommands.js\":\"3413d23e5bd1fd6e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/dataExtension.js\":\"831488e276305fac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/dataModelGuide.js\":\"7c8aa33924f8fa7f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/describeRuntime.js\":\"b2c6458b6b28df36\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/extensionLint.js\":\"f50ae7e8352f6f1b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/grainAudit.js\":\"b12a89a04088c6a5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/healthCommand.js\":\"3cfb52d5341ef8fd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/index.js\":\"af2cf4c819ef7293\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/presetIdentity.js\":\"5e2ad4b5b7437cc3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b2e046d7e23ba8fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/readMedia.js\":\"681e2038a5d72b6d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/schema.js\":\"06cea1394289ea15\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/serialization.js\":\"e73a4568610f263e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/targets.js\":\"6d34786a2d3f3a49\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/tokens.js\":\"0f8eaf0a206bc29b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/watchEvents.js\":\"63d3f6037b2a73be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/workspaceGuard.js\":\"1c9b9264fd9a040a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/writeCommands.js\":\"fb79970cb30896dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/AliasCollisionToast.js\":\"20d1f98afa825a5c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/DuplicateNameBanner.js\":\"35211af2bdeef038\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/collisionMerge.js\":\"92bee89ff72c6df1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/dataExtension.js\":\"4f39ea329491b7df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/index.js\":\"91aa9efad86715c1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/mergeCollisionAction.js\":\"8794e1413c16695b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/pageStyling.js\":\"b3e3b68bf8b09763\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/rejectionToast.js\":\"5e3f07e590d57183\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/syncProcessor.js\":\"23b9234288879978\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/actions.js\":\"c5768356dadd70af\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/addComment.js\":\"f11740dbd0802ec7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/anchor.js\":\"b0833269cafdf8a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/anchorState.js\":\"4f66dcea0cb6f556\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/commentLinks.js\":\"b6d69d409d0ceede\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/confirmThreadDeletion.js\":\"8805c989b3dcc226\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/container.js\":\"79f3628a0d7a05a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/dataExtension.js\":\"69b7cd1e11e70f36\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/deleteComment.js\":\"deec14f1678b8837\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/highlights.js\":\"be77b51fd81d6fc1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/index.js\":\"98761e4b25594331\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/linkedCommentsPill.js\":\"dd569759c77ec1a5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/margin.js\":\"ab5dcf91262e040e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/marginSchema.js\":\"a353c43e9cc7a257\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/newComment.js\":\"b66470bc3f376e08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/ownThreadPicker.js\":\"92d4d8e10c68f1d7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/placement.js\":\"8180a4a386611e33\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/queries.js\":\"fcc8e8b725400810\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotePosition.js\":\"9c24e97acf4ca7be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotedIn.js\":\"25d28f2b43f170f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotedRange.js\":\"1f99aac1a3a70c22\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/rangeRefs.js\":\"2e2b0e493503aa42\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readHighlights.js\":\"3ec907cea3aa2375\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readSelection.js\":\"67a83a9a12327b3e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readSelectionUi.js\":\"21e1c1c8e112ad98\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/reanchor.js\":\"ff32ab655a233315\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/schema.js\":\"c1cd6fac0611a3cc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/scope.js\":\"deafe8d74d8421b5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/scopeThreads.js\":\"a9ba83ab2e39ed20\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/splitRetarget.js\":\"6f4db137c0129ecb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/suggestionCard.js\":\"15afa93fb767cf15\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/suggestions.js\":\"56885e0aea713858\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/summaries.js\":\"bf469cab95440a93\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/summaryBatch.js\":\"441c7fa7404bbbba\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/surface.js\":\"b660eb297ef0f094\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/threadNavigation.js\":\"b166da44104cef79\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/threads.js\":\"18d6934cf866a72c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/ui.js\":\"a6926b2560b9160c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/uiStore.js\":\"3e4af59482daeb7b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-intents/appIntents.js\":\"db0ad49b8ebac7df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-intents/index.js\":\"885d10ce3c2b6425\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-update-prompt/index.js\":\"776e8f42fbd4d0e4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-update-prompt/status.js\":\"098d5faa4a278ed4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fd8cd01b935933a2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaBlockRenderer.js\":\"22d91aef7ec1758b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0f6c046f2b140ceb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaUploadReconciler.js\":\"bdb1107cd62403b4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetDownLane.js\":\"d56df9f76bc4c3aa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetResolver.js\":\"e97ac83eaa2a6b43\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetUpload.js\":\"6eb2238b07088a6b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/attachmentCleanerIO.js\":\"670094e970fea340\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0a94ee8c4b2c9966\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/blobStore.js\":\"29695040a7df69fb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/browserMedia.js\":\"6d5a3c90d8103f42\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/byteStore.js\":\"9b234acf10a5d663\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/cleanerIO.js\":\"4e329b207974654a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/cleanupAttachments.js\":\"37c1b9b860968021\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/dataExtension.js\":\"44f8c71ab8164549\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/downLane.js\":\"e604a0c3e7f55d57\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/index.js\":\"6e3d2f81bba68d48\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/insertImageContribution.js\":\"14df8b277d3e2b37\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/laneArming.js\":\"4e6e5ad7b197fbed\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/laneLock.js\":\"ebc3d459e7fc9ecf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaBlock.js\":\"0b19754366631af6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaCapture.js\":\"e75e55ac09a9766d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaLanes.js\":\"49b4a5bc7d1c6d40\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaViewers.js\":\"e2405ebcc85d20f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaViewersFacet.js\":\"dafe6254bad630a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/pasteCapture.js\":\"c6c90e3749ca0a9b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/resolver.js\":\"a74b5a8dad91c32d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/retryUploadsAction.js\":\"607fadfc4bb849a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/storagePaths.js\":\"cb0a5d3bcd31ff82\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadDrain.js\":\"7fe7480a61b8a4df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadLaneStatus.js\":\"b9858156c5cb68ac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadReconcile.js\":\"ad2814ae63df9069\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadRecovery.js\":\"e85655d54e328d3e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadStore.js\":\"f9c143d993516b00\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/useAssetObjectUrl.js\":\"4ccd6da82318429a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"817814c2a3ee65a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8c050527336ee28f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/facet.js\":\"0b349e1938706194\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/index.js\":\"9c0bb818db26ef5f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/prop.js\":\"bc9c5bea2cd1be78\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BacklinkFilters.js\":\"85a1c170ccc4a9f9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a3791301736bab66\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BlockEntry.js\":\"dabf3e9425b2782f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/LinkedReferences.js\":\"f1e7383b9a4dc2c2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0eee7609a82a78c4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/dailyNoteDefaults.js\":\"6f298d84278656e9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/dataExtension.js\":\"d845bb8105fdbb13\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/edgeExclusions.js\":\"4d783dd6ee22c4cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/filterProperty.js\":\"19e44c99b0358bf6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/index.js\":\"5c351b1b5cfbfe24\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bf6f5b3de90be800\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/applies.js\":\"ba8c619052c2e847\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/countQuery.js\":\"e2890f69b2cfd9a2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/expansionStore.js\":\"75998717a9d2bef8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/index.js\":\"7148e0dfbe43cfd2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9ce9f090d390c050\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/presentationInvalidation.js\":\"ae5ccd9bc2095d32\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/propertyEditorOverride.js\":\"db5da3260ebeae67\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/propertyFilter.js\":\"a95dd3aa5466fd6b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/query.js\":\"982a32ac3c4740e5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/resolveFilter.js\":\"3ecad6afd47f9230\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/sourceBatch.js\":\"7782ade171e3ed29\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/sources.js\":\"3f384845c201fd5a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/useBacklinks.js\":\"2d007fb218f60c8a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"06db1242b55ca2e5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/BirthdayCelebration.js\":\"60cc5b6c65087f9d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/BirthdayOverlay.js\":\"852ecd1ba7a950fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/gate.js\":\"97f1c0efcef29241\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/index.js\":\"0d35e7048d866ca1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/wolfTheme.js\":\"b939d19ab8d592fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/BlockDragLayer.js\":\"a00f8e03a635b396\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/dragController.js\":\"6e880ce6cb734cb5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/dropTarget.js\":\"e78ece44e023a915\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/index.js\":\"cb2b976ea2227836\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/projection.js\":\"f2281cdef214ba7f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-info/BlockMetaCard.js\":\"34b84a36bb7213be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-info/index.js\":\"d6f10654d24500c6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/AddTagDialog.js\":\"c149249272825070\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f173a76b4cb0db38\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/TagNameIssueHint.js\":\"9e2223ce04187e7a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/addTagAction.js\":\"9673772382d6c472\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/appendTag.js\":\"c24bcc8be41200d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/config.js\":\"74b9e29e3afb53c1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/dataExtension.js\":\"4b91530da90421c8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/index.js\":\"d0b7e90ec05e2dde\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/propertyEditorOverride.js\":\"a8f374204b30181f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f743396e6c3a3184\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"51459c9f12a08710\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/Breadcrumbs.js\":\"0ff0ac2378928e5a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e09c5673ff25da31\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8876fa861549ab4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/index.js\":\"505cee1d62cce013\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fce47cc7c00d39cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/CharacterCountItem.js\":\"8bbb12d5947eb61f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/ProfilePropertyEditor.js\":\"08da6daac72ff5d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/actions.js\":\"7d35e4f305871a4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/blockType.js\":\"85614433b10d013f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/charCount.js\":\"88967ffacc9658f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/dataExtension.js\":\"daeff623482c7d1a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/index.js\":\"95bc8029130647ef\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/profiles.js\":\"ca1aea4f29fd4652\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/properties.js\":\"c56c49bbf8a185d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/textCounts.js\":\"bce9ba96dd194d52\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/colemak-keybindings/index.js\":\"a1d84c53a5958a8e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/CommandPalette.js\":\"33bee7bea2d99079\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/HeaderItem.js\":\"133ad90d17de449f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/context.js\":\"1e841b729236a1e8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/index.js\":\"fd6a23ed88ccbd75\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/selection.js\":\"9db22462820cfa55\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/toggleStore.js\":\"6e46be687cd54e40\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/useCommandPaletteActions.js\":\"2fad1ad93dadecfa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/ContributorBadges.js\":\"21c80426a5412d46\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/author.js\":\"8745d4919805aac2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/codeMirrorExtensions.js\":\"7015dbe2c0c8cb12\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/dataExtension.js\":\"a493289b53636a96\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/index.js\":\"53dc6ba2eb68d8ba\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/mentionAutocomplete.js\":\"9dd090bb54ba883c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/processor.js\":\"712773bebcf0a7ae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/profiles.js\":\"3403c5f154946471\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/queries.js\":\"f27577c4e360af32\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/schema.js\":\"62c7bbd4889093a9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"50d51f90e4e4a1f2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6ed3fa0aeb7e9f96\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/index.js\":\"4f08f3114e0fa782\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"77cf96a3c21b152f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6766312e3b968eaf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/CalendarGrid.js\":\"a90bbaf56fcec0e7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DailyNotePicker.js\":\"2127399cec4435a9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f97692fdf8445157\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateNavDecorator.js\":\"40b4f836c392d295\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateScrubOverlay.js\":\"f7cc018ffcf2570c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/HeaderItem.js\":\"5e4284b97c48349c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/ReschedulePicker.js\":\"25453dc932d11411\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ded83e7851e10da8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/actions.js\":\"6fd666a6033d40fb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/blockDateAdapter.js\":\"ad81081ac99edcf9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/calendar.js\":\"a3e91070948766c5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dailyNotes.js\":\"3575f7d46048df9d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dataExtension.js\":\"e42eb683b9f5991e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubActions.js\":\"8e04084f6ca7f0cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubGesture.js\":\"5f907dc0b429e954\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d71f8eb625634b41\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4132a0a8cbdf12ac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/deletionGuard.js\":\"3421763bd82dd620\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dueQuery.js\":\"e11bcc859c854480\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/index.js\":\"7d1c3c3d5ede52e8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/landing.js\":\"c848e1d22c639e94\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/localSchema.js\":\"19920556812505f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/referenceDateAdapter.js\":\"43cee404259077aa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/rescheduleAction.js\":\"edd61970c0b60092\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/schema.js\":\"8b57f3dcdb267263\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/spreadBlockDates.js\":\"13c825ae9685e7c0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/spreadDatesAction.js\":\"7a38389df8d0e4fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/today.js\":\"52426dac2bd507f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"27875728331b7788\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a9324ea0fe660352\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/audit.js\":\"7e38160b656795a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/auditAction.js\":\"24e3098415f7abb8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/auditRanges.js\":\"76c9e7c6a3f4734f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/diagnosticsSource.js\":\"40708829e62c00ef\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/divergenceScan.js\":\"700840d48e1a220d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/index.js\":\"146028d2f305b76d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/propertyChildrenChecks.js\":\"646be12a0303f1ad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/referencesMirror.js\":\"4a923efbb97e75f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/rowJson.js\":\"68084d318a17bc6d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/schedule.js\":\"a13eab60eb3f3e56\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/store.js\":\"2bedb82124dedcda\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/action.js\":\"3d27e7702215c0df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/index.js\":\"f7f64dcb4d5df8bb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/plugin.js\":\"2338072d826d19ea\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a3043ec0251ee9ab\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/actions.js\":\"784250b9b107fe60\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/changeMarker.js\":\"aab472ddd163a87c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/diagnostics.js\":\"b298107ad39f9c9a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/fileSystemAccess.js\":\"8b853b5ce26f61de\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/filenames.js\":\"df632264f871d600\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/index.js\":\"3f8a2167edc829ff\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/mirror.js\":\"2aa947f16c512c5c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/runLock.js\":\"279ff41850de4f28\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/runtimeHealth.js\":\"d50c792d7cb9b4d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/schedule.js\":\"c72f813ff09a9cbb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/store.js\":\"527532c6fcdea628\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/default-themes/index.js\":\"815e455f335235f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/default-themes/themes.js\":\"4a133d44329c324e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/diagnostics/facet.js\":\"f4f1203140c6926b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/diagnostics/useDiagnostics.js\":\"684d1d7c454ff5a9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/dismissals.js\":\"4777c8c7ed9f20e0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/index.js\":\"e567cb35cda992cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/status.js\":\"b8c19fee9afa2d85\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/store.js\":\"3b725090240c98a9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1800c5fcb146322a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/ExtensionsSettings.js\":\"faf5687cf0d96606\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/actions.js\":\"4da8d853f284f4f9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/config.js\":\"bc897dcbbdcd7396\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/dataExtension.js\":\"ed4f3177a82558a2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/effect.js\":\"95b1f0514d1c9bbf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/index.js\":\"59f13c0c1f704af5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/propertyEditorOverride.js\":\"201b567ca26a7c69\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/useToggleTree.js\":\"d9e38a8e6df1f84a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/ExtractTypeDialog.js\":\"ee72bd93d4b7b57f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"3f56a82c8f994045\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/PropertyShapePicker.js\":\"c1f3a2cb8e695dcc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/action.js\":\"159f83750936c687\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/index.js\":\"cb3d26846de3a8dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/FindReplaceDialog.js\":\"745f0c710789de5b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/HeaderItem.js\":\"cb71c34d3eea840d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/dataExtension.js\":\"b12d89caba55a85d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/index.js\":\"273b667965dbf9a1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/search.js\":\"67cd3ac740a5db6a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/toggleStore.js\":\"c4158e68881c64db\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/LocationPropertyEditor.js\":\"170e5282d28e51e7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/MapView.js\":\"c43da6b61ac408cf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/blockTypes.js\":\"a3b56b0cafae5158\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/codeMirrorExtensions.js\":\"ae80ffbf76d618d6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/createOrFindPlace.js\":\"e872f6961ec08df3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/currentLocation.js\":\"5ed40dec4162723a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/dataExtension.js\":\"95c6f37aaf26f206\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/geoContentDecorator.js\":\"db004c0c6a5312d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/googlePlacesClient.js\":\"c31f8322e9278bb3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/index.js\":\"665b7f34b19e1201\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/locationsPage.js\":\"41336d383509ae4c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/mapViewport.js\":\"521be9a81b7f7ee9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/pickCurrentLocation.js\":\"b9f079e28baf4d80\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/placeAutocomplete.js\":\"70e6532bb3f0b654\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/placeNameCollision.js\":\"dbf1a413f5b11c6b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/properties.js\":\"1498624d071303dc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/propertyEditorOverrides.js\":\"5db412b41bf129d8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/query.js\":\"c20ebe3fc39b594c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/usePlaceSearch.js\":\"0fee91e7f1c78f40\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ac8f79673587fe0b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5b5764febf1ad148\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7f62422588f4cd4c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/config.js\":\"dbfab0f35d3f5cad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/dataExtension.js\":\"3e5a666b461fca45\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/facet.js\":\"00868008e99910cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/grouping.js\":\"d940ade1c6b12f59\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/index.js\":\"1826984fd417cdf9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"915a06841e790846\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/query.js\":\"4c0e3984e2a3a86d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/resolveConfig.js\":\"0c12ced35d78dfa6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0e16de89497d73d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3c76fba5045d7fbb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/HtmlDocumentContent.js\":\"0eb8b38ac0af070c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/HtmlFrame.js\":\"122815b816a6bad4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/actions.js\":\"59ac00b327b58414\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/blockType.js\":\"cb06b3ee0d4d0b86\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/confirmRunScripts.js\":\"d55d26772f2205a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/dataExtension.js\":\"969c018cf3bea70d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameAnnotations.js\":\"3ee76e7301da4cae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameDocument.js\":\"af15c00303ad12a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameTheme.js\":\"1c5490c1054c411d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/index.js\":\"dad9767a7cb44096\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/scriptConsent.js\":\"123a08f973a4506d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/sourceMap.js\":\"89b1da2c66c74ea7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/useDocumentScripts.js\":\"2aa0f5d74e2ea9da\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/index.js\":\"67151e242d4a1150\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/record.js\":\"ac11e54942b659e1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/recordStore.js\":\"17e0c190242b6041\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/responsiveness.js\":\"e4a99a6f1833282d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/schedule.js\":\"1859092ce4e854a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/sessionContext.js\":\"9484a43a0906787d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"639e98f9acaa8d33\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e6a23c3e94656ceb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/actions.js\":\"3fbc350650fc5377\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/config.js\":\"8b26a5b1cf6a2c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/dataExtension.js\":\"a9253a6cac5d127f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/effect.js\":\"e9c38dbaeb1bb382\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/index.js\":\"7ceb38b63fe2b891\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/keyCapture.js\":\"cff4f55f7ecd01fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/overrideStore.js\":\"629faa2f04f5492c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3fe71cdb6619321f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/HeaderItem.js\":\"14f6c2a808aed889\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/LeftSidebar.js\":\"a3e18906d93d47cf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/actions.js\":\"10387486bcf2c215\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/facet.js\":\"9ecc024226b9a792\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/index.js\":\"71865950287b759f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/shortcuts.js\":\"910f1394805481fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/toggleStore.js\":\"a2511cd2381da7a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/MergePicker.js\":\"1a7bf61bd518a282\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/index.js\":\"57f30f5ac01918dc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/mergeAction.js\":\"f2577d7b64e85f90\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/strategy.js\":\"eb035299d2e4a00b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/Button.js\":\"a274da230db5cdc7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2361e74588801c55\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9d18dc48a9b08a75\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/facet.js\":\"d86addede7dfdfd3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/index.js\":\"3911a31912982beb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d8b8186ea5cf738e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/actions.js\":\"69b30267f3a0cc7d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0e42e5998711f5b5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6fca56347ebd0113\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/index.js\":\"aa4c906b466fee50\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a26a7fa85643d1e7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b24abea8c1a2176d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/contextMenuItem.js\":\"af6ed7ad4cfdddf6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/index.js\":\"087964de86800b2e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/moveAction.js\":\"daf7881f3f0cb433\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/moveBlocks.js\":\"0d1c2d8c59f38077\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/selectionAfterMove.js\":\"3b0e4b7fe92c018a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/TutorialBanner.js\":\"e36d996f39a4a8a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/action.js\":\"0a826daabf4f7653\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/bannerDismissal.js\":\"a108d62bf272dbad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/documents/cheatSheet.js\":\"2258a5b2de89bfd0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/index.js\":\"a3de2bbced6ab231\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/keys.js\":\"1277a6abe13c6975\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/landing.js\":\"132f3aa8bfe7126e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/outline.js\":\"2f7c398f5851ea92\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/seed.js\":\"25b6c73719ae2ae6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/PerfTrendDialog.js\":\"310cac7acf9f16c5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/analyze.js\":\"8e9afcfff35ee24a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/diagnosticsSource.js\":\"0afb69f55c193e9e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/index.js\":\"a9392f4e5813c019\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/load.js\":\"3213284e67749ecc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/monitorRun.js\":\"cbfed8dd1d5b9752\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/schedule.js\":\"56be738471d19f7e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/series.js\":\"c3cd311a1d5e7175\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/store.js\":\"03ad28cc78764464\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/trendAction.js\":\"aeb4caddc909f4dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/verdict.js\":\"92470bbdce28a414\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/clickToEditAction.js\":\"c8f374b4007a23f4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/index.js\":\"101ab4df9a511cbf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/interactions.js\":\"7cb6746b26735f5c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"161413a146204f68\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/MigrationGate.js\":\"67dd9d158cf75367\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/MigrationGateDialog.js\":\"d198af834e172d1f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/action.js\":\"2f962e4ca2d52c9b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/index.js\":\"4708a2c1e880902e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/localRunMessage.js\":\"9005e6b82180a8a1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/plugin.js\":\"f7ca536a0fb4c71f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/progressReport.js\":\"609fa7179e2bc2e4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/sweepProgress.js\":\"a2de1eca800df31f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/FieldRowRenderer.js\":\"d8323131105355d7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/ValueRowRenderer.js\":\"5bf96750e66ff397\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/actions.js\":\"7a6d8972b803103f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/autocomplete.js\":\"72d24322911ce7a2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/fieldRow.js\":\"19ee0597d5158491\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/index.js\":\"6d3a97b708dc07fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/referenceWarning.js\":\"037915da39b4450e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/valueAutocomplete.js\":\"3efdb84fd9568fad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/valueSchema.js\":\"84166cd4ab6212f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/HeaderItem.js\":\"a3a2ff22a72f5238\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/QuickFind.js\":\"acc8ece99fec0c1b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/index.js\":\"6e517c9b360785bf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/recents.js\":\"88775404d034cced\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/resultItems.js\":\"b360bb6fb44ff93c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/selection.js\":\"8842d56f792e9197\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/toggleStore.js\":\"91367ac01e5dc7f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/HeaderItem.js\":\"e39f3da2791a06b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2c40d059881f742c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/grouping.js\":\"de5764edc410aef8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/index.js\":\"44c5a7f3ba50c3a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/target.js\":\"f43d2ab672bee13f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/codeMirrorExtensions.js\":\"9e21b5f7edd656cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/contentPrefill.js\":\"ce008473d4109291\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/dataExtension.js\":\"7d055b18c156e9d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/index.js\":\"ac67a22a92688db2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"94996a9c21753af3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/invalidation.js\":\"938117a4d7bf5fee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/localSchema.js\":\"b644df00687b6386\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/blockrefs/index.js\":\"dcacf5e299f6ec60\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ece9ec1933d534b8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/index.js\":\"b4c2a261e30e68b1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/referenceNode.js\":\"4ec430d773421294\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/remark-reference-occurrences.js\":\"102dd66685774324\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2ea47ab25f13e2b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/index.js\":\"db3190262abfadf5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ed9aa3407a148e73\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"27664718509c972d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/mergeRetargetProcessor.js\":\"3ab4282b16a8d08e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/parseFence.js\":\"ade59c985b9b7dca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referenceParser.js\":\"fb63b5c83d9d5022\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referenceProjection.js\":\"793df1915481e390\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referencesProcessor.js\":\"385565f25d4c06a5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/renameProcessor.js\":\"2c81f3657e02437c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/spanReplacement.js\":\"c3973c8316286cb5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/htmlToOutline.js\":\"6e83999ed24fd77f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/index.js\":\"25f67e832354537e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4b3f02f9f8f3e0bc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/pasteDecision.js\":\"9caf17749b25fb01\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/action.js\":\"9e5ecb9078a89a9e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/blockIds.js\":\"f3229b449c6a809e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/content.js\":\"c8dfba6ff25bc5b5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/effect.js\":\"6cf3d018cfeb13b2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/ids.js\":\"072d0f9b1be5e6f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/import.js\":\"676f0e554fc81544\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/index.js\":\"c7c1017e4627d647\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/plan.js\":\"4701ce7bd6993dce\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/plugin.js\":\"74a6cbeb0074d46a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/promotion.js\":\"2eef511e3635ed19\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/properties.js\":\"9eb65bff6c14d1c3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/references.js\":\"ab754529eb046dfe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/report.js\":\"6a5b534a4b87f1d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/roamMemo.js\":\"cd5a6fc39ff682d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/runtime.js\":\"75495389b749e20c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/schemaReconciliation.js\":\"2325a0baf0dea75d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/srsMarkers.js\":\"abccfd5e10f1e7bf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/todo.js\":\"5802c22cd24f86ec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/typeCandidates.js\":\"af13f397154bbd03\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/types.js\":\"d91cdd4cfb2ad29e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/search-health/index.js\":\"6459bc2f69db481a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/search-health/store.js\":\"5a7e6aeaecce5a92\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/HeaderItem.js\":\"affcf711528f4e5e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fc002843de047e88\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/index.js\":\"41e523ea3cea856d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/model.js\":\"7ebd79def6ed183c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/toggleStore.js\":\"df68078c68fe8809\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/useKeyInspector.js\":\"f938b1f0b225478d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6c15be3ee6f5c052\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/ShellDecorator.js\":\"10e8282a66bcfdc1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/actions.js\":\"9bfafe3e6d5a0381\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/exclusionsFacet.js\":\"12dc8e55dba5330b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/index.js\":\"9b4977b9b97fd04d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/shell.js\":\"ae980bb3cedd58f9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/surface.js\":\"7844f37f0d2d6efd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/walker.js\":\"79351d5d42567927\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/RescheduleToast.js\":\"10d722c22513750b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/dataExtension.js\":\"6f7218bab60e9cda\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/index.js\":\"c5abbadb3f0e963f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/indicator.js\":\"a07aa2a4de5caadd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/moveSrsState.js\":\"755c5a686fea4f58\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3d28ed79906b1afa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/scheduler.js\":\"b73cfd0193522936\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/schema.js\":\"031802afc18bc05e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d0e5b301e4822d9c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/srsClipboard.js\":\"af0b4c9cd9b47f7f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bb6c8e5aa4d518f8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c66ac3f1427a861f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/DeckPicker.js\":\"3b3c6787b0c176d0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewControls.js\":\"20690418ad95455f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9c12dfdd761be74d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewSession.js\":\"9c530cc1a191eb8f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/actions.js\":\"cf297bb649395ab2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/archive.js\":\"e360c71da3cb7306\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/dataExtension.js\":\"f3b583772648a011\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/deck.js\":\"8ec25e660f957a11\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/dueQuery.js\":\"b4a831e61410c1aa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/gradeDecision.js\":\"4e076b22034135f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/index.js\":\"0f114fc9c1bc65c7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/keyHints.js\":\"38616edeba585979\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/reviewCardLayout.js\":\"43600084455b2fb1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/reviewProgress.js\":\"1e8603d5f34cb8a3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/schema.js\":\"c51158bbc7a7f3b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/useDueCards.js\":\"c397a4f46b219c06\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/startup-metrics/index.js\":\"fd557bf9dba7a4c7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/startup-metrics/record.js\":\"93bf8159a2d02f8f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/index.js\":\"752aa04e25726e9e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/persistenceStatus.js\":\"4d9d51771c0eddf0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/requestAction.js\":\"def47c263ef12775\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/TypeChipsDecorator.js\":\"8a989faad397e1de\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/codeMirrorExtensions.js\":\"53ffb076a5554e3d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/index.js\":\"3bdabd66975df7aa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/typeAutocomplete.js\":\"0078b781934e7c26\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c5b242d34efbdeb2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/actions.js\":\"4770cdbb07262acf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/anchor.js\":\"dfd713e5c033046b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/events.js\":\"d9de269c2001e83c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/gestureActions.js\":\"3a3e8b1b3e5e661f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/index.js\":\"a94fea8de32e3bb8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e4d693062df5df28\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/collect.js\":\"230695c1a4a75d2f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/index.js\":\"b278b0bf350aafc5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/record.js\":\"d290cdd0b4a0f312\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/RejectionDialog.js\":\"3605933995cf298a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/SystemStatusHeaderItem.js\":\"14e38fd772fabdc1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/index.js\":\"1965bbfac874f10d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/model.js\":\"af2fd99c7deb9088\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/queueCounts.js\":\"3f63a4d8fde355bb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/rejectedHelpers.js\":\"ddd32d4d4a02382d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/rematerializeAction.js\":\"ce85545ce08268bb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/useHysteresis.js\":\"cc8e5de21e2dc0f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/ColumnHeaders.js\":\"93850bea5dc0b92e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/QueryUi.js\":\"85d0f6d425b7f605\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/TableLayout.js\":\"907e71b22c98963e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/actions.js\":\"a71c87e88cfa8142\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/cellEdits.js\":\"e8bdeb29316bc6f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/childrenViews.js\":\"b5a477e9fd894da3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/columns.js\":\"6b5a6824f542884a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/controller.js\":\"6c47ee8eddca97e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/convert.js\":\"cbebbc0e43495ab9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/dataExtension.js\":\"cc2f9ae8d77c0b13\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/index.js\":\"ecd45ead4adde754\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/keys.js\":\"6e1db9d68a9bc615\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/model.js\":\"227fb2844d606717\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/backfill.js\":\"ceb54c288cb7149e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/completion.js\":\"c75de1d684878777\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/format.js\":\"b523d525643ad434\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/parse.js\":\"c63e63a939f4e091\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/queryValue.js\":\"c62ca17900ba05f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/source.js\":\"e6b501062dc75d0a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/registry.js\":\"140ca91de898d059\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/rowGutter.js\":\"cd95fd7f42fe02a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/rowVerbs.js\":\"a67299bd079e71ca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/schema.js\":\"ee2e1eaca2d4fdfc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/sort.js\":\"82cbe0703ec90b61\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/effect.js\":\"7d4b60963d16f450\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/index.js\":\"e202380b2db920b2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/theme.js\":\"180dd0438d216c89\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/actions.js\":\"b196958a2ab98bfc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/dataExtension.js\":\"4d2e1eb676ce40f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/index.js\":\"b0744acd25c8694b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/schema.js\":\"b62caecdfb6fd34e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/TouchSelectionLayer.js\":\"86be9514be28e774\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/actions.js\":\"9e37fcad0977f4b2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/defaultItems.js\":\"e79872513eef9026\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/facet.js\":\"2784ed67ca811a13\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/holdRecognizer.js\":\"e7e17087726cee64\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/index.js\":\"9b6e1bc4ad20e8cf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/UpdateIndicator.js\":\"d6078cfae454c135\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/index.js\":\"dec3bccb675a85f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/loadTimes.js\":\"4fa235ff6589ca42\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoNotesRenderer.js\":\"cb9c86004883eb1f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoPlayerRenderer.js\":\"b536c00ef45836f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoTimeStamp.js\":\"a22132ab546f510b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/actions.js\":\"af1225626f2d30f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/index.js\":\"a4b45b060386008f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/markdown.js\":\"0f57025821b12a0b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/notes.js\":\"4c615195bfd0769a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/registry.js\":\"75b5af9dee1790b8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/remark-timestamps.js\":\"7c95fd39fe45b793\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/view.js\":\"9a2969e9cf5b5d4d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/LinkHints.js\":\"d20715c5ff603f12\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/index.js\":\"ef05f2db450007d2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/model.js\":\"b11dd316c4021ca3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/settings.js\":\"1ad705709eb49566\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/actions.js\":\"d593958588bbd2b7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/index.js\":\"02caea1395668a68\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/interactions.js\":\"baa4dc51b4928089\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/workspace-header/index.js\":\"dc058c88b2a24530\",\"/knowledge-medium/pr-preview/pr-1868/src/registerServiceWorker.js\":\"7eb7435c61457c14\",\"/knowledge-medium/pr-preview/pr-1868/src/requestPersistentStorage.js\":\"5358f55cdc583a72\",\"/knowledge-medium/pr-preview/pr-1868/src/services/authRequestDeadline.js\":\"bb68962819432e6a\",\"/knowledge-medium/pr-preview/pr-1868/src/services/authStorage.js\":\"7f57ee0093b5438d\",\"/knowledge-medium/pr-preview/pr-1868/src/services/powersync.js\":\"e3fa8c6c0c3bda20\",\"/knowledge-medium/pr-preview/pr-1868/src/services/supabase.js\":\"231f7c9748b2ad75\",\"/knowledge-medium/pr-preview/pr-1868/src/services/uploadErrorClassifier.js\":\"19afe031b6ad51c8\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/ActiveContexts.js\":\"f6dad5a85bcf4a5d\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/HotkeyReconciler.js\":\"fbd853925ca6c41f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/WipeLocalDataDialog.js\":\"e96f0f296a76a71c\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/actionDispatch.js\":\"cc114ceecf1c62e6\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/actionRefItems.js\":\"2230a353914e041e\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/applyKeybindingOverrides.js\":\"d64a056f9cee4bed\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/blockActions.js\":\"3629785b0b595ebf\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/blockMergeGesture.js\":\"d08b67a18e4fc78f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/canonicalizeChord.js\":\"cf3247dc32974d5f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/defaultContexts.js\":\"38aebb3f104746b5\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/defaultShortcuts.js\":\"26ba16f9b4b3239d\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/effectiveActions.js\":\"09c3d34feb582bb1\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/gestureAction.js\":\"d2396aeda4f55626\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/gestureBinding.js\":\"62197a788b28fb0d\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/holdRegistry.js\":\"515f487406165aea\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/keybindingConflicts.js\":\"582cdc001b3b490d\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/keybindingOverrides.js\":\"eacf16f8a8e666d5\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/pointerAction.js\":\"2d93d0ef8ec14fe4\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/resolve.js\":\"0e0e2e1e50579c64\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/runAction.js\":\"8a9c22c187cc8b33\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/sequenceMatcher.js\":\"f05c6afbc5019a9e\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/types.js\":\"28482379a9253485\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/useActionContext.js\":\"667747a66e9cf5c4\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/useActionDiscovery.js\":\"a8c329c5d552b326\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/utils.js\":\"8a6d923a033d24e2\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/bootStore.js\":\"bbefd71e56e4f1b9\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/previewDatabases.js\":\"977e71f20bb7bb74\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/byteTransform.js\":\"cda4584e724a408a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/attachmentCleaner.js\":\"067f07c8abfbfcf2\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/attachmentParts.js\":\"8dfdd734a55ffa4b\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/bundleParts.js\":\"3740c0ddad3b0b00\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/bundleRecord.js\":\"195e065cc6e9c36c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/manifest.js\":\"00ad70b2ef7e5a6d\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/takeBundle.js\":\"234d3cb4fa20e7cf\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/verifyBundle.js\":\"92c8b0237a93e74f\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/cleaningStage.js\":\"962e233b0a087f22\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionKey.js\":\"49c265c6c077e103\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionServer.js\":\"7513802f5ad51592\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/flip.js\":\"01914e8216f5e25f\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/flipAttempts.js\":\"3be32ae57bfb8e82\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/pages.js\":\"ee7aaa1be7cc52d8\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/preflight.js\":\"a4941bfe99e6999d\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/reseal.js\":\"92034866ca8b50ad\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/runConversion.js\":\"e9774d313c071c22\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/runLock.js\":\"4eb72418c72d12b7\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/sealing.js\":\"e2dce7ca81059443\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/sealingStage.js\":\"8f54055c7abfcf7a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/stage.js\":\"e8f82ce1fe729fb3\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/verifyReseal.js\":\"9e14d0cf11dcea0c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/aad.js\":\"6466585cc50a67cc\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/aead.js\":\"12513ab2def0ed44\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/base32.js\":\"c2887d437cc4f9ba\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/base64url.js\":\"1b2bed73c5e5935d\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/binaryEnvelope.js\":\"4e669dd1c56bdb87\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/byteAead.js\":\"830ad94d4690e6ec\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/canary.js\":\"b950a88f0222c12b\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/contentHash.js\":\"d0d0a45541e32b21\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/contentKey.js\":\"1abef97c2c35de24\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/derivedIdNamespace.js\":\"b42f356fc92a7d54\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/envelope.js\":\"ca81d20b5928e84a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/hex.js\":\"4d95f37f7cb95cd4\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/sha256Hex.js\":\"77213278e2a92c85\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/workspaceKey.js\":\"3e739c64538ade93\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/conversionState.js\":\"34f0e0b1b3c515ed\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8af60bcbf60c44c2\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/pastedKey.js\":\"3a89c5b49db232e8\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"77154586c0a1b2b0\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d5177bd456b5e3e5\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/keyStore.js\":\"a3a5004b762633d9\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/mintWorkspaceKey.js\":\"d2c3a67526be389e\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/modePin.js\":\"c4634b7881285352\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/openWorkspaceKeys.js\":\"e1c6c1a79efebd9f\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/resolveWorkspaceEntry.js\":\"04503f0431c0db12\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/resolver.js\":\"32df2c86f0e10ef2\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/workspaceAccess.js\":\"4a00319b7db4282e\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/transform.js\":\"dbfd0ece395e809d\",\"/knowledge-medium/pr-preview/pr-1868/src/themeBootDefaults.js\":\"a73cb9857c55cf10\",\"/knowledge-medium/pr-preview/pr-1868/src/types.js\":\"d0e67442282e53f4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/ClientLocalSettings.js\":\"e6bd5623ac993f12\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/abortableSleep.js\":\"060785d607cf0a9b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/array.js\":\"d407c47e025a6e76\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/backlinkAutocomplete.js\":\"774acbb0bed18af3\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/blockCrumbs.js\":\"0ead3cbaa9c18e3a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/blockrefAutocomplete.js\":\"714c8c9552848b41\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/cadencedIdleJob.js\":\"53a8021056861c51\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/callbackSet.js\":\"93b17fa1e2c911b8\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/clientId.js\":\"a37d141d67af61c3\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/codemirror.js\":\"44263d3f1e76457b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/codemirrorCompletion.js\":\"1aeae04328150327\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/copy.js\":\"9a6f2307e8fe713c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dailyPage.js\":\"20519ba8f9876c5f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dbForensics.js\":\"b763b52f187c2b53\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dbForensicsHooks.js\":\"2ee6abc48bff9442\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/deleteBlockThroughUi.js\":\"8fc719a021165c9a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dialogs.js\":\"789a9415132f3fdb\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dom.js\":\"db8ce023313a0507\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/downloadBlob.js\":\"667976fc1ce74a99\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/drawnWalk.js\":\"c5a2bb53cc2456e6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/exportSqliteDb.js\":\"7711d5deff9aedb4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fileSystemAccess.js\":\"b6066fc7b89b0875\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/flipSlide.js\":\"06cc9162052be3d4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fnv1a.js\":\"7ea81354e1550f66\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/formatBytes.js\":\"5729929a06415a87\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fuzzyRank.js\":\"87e64aad962f7f13\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/idbKeyedStore.js\":\"cb3c1b7fd48bee22\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/idleCallbackPolyfill.js\":\"4b3f5c85786bc265\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/keyboardAwareScroll.js\":\"399f213e8570e3b6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/keyboardViewport.js\":\"1afbd95652e57af2\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/lastWorkspace.js\":\"d3bb9bcdff62054b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutColumns.js\":\"61c9fc6c0e4ec05c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutSessionDom.js\":\"a1ad119ea19f6e9d\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutSessionId.js\":\"119a25397c7fca11\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/linkClickGestures.js\":\"04727294a02b9f55\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/linkTargetAutocomplete.js\":\"88651fb2f89a558e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/localDbCorruption.js\":\"52ffb3b906e147e7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/localDbRecovery.js\":\"d690f61f73be6930\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/markdownParser.js\":\"befdadbac3adffaa\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/memoize.js\":\"4161bb0d23ae7ff3\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/nameFieldCommit.js\":\"c4bb7aec38859122\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/nameList.js\":\"51795a09a3b4ed52\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/navigation.js\":\"d36d5433b8d13389\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/omnilinerNamespace.js\":\"0cfc34d6fd0b0298\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/opfsPageScan.js\":\"777e5de887a2d835\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelClearance.js\":\"97062e4f7feec72c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelHistory.js\":\"bc3d77ccfb05ddf2\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelLanes.js\":\"95c45cfe72e4188c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelLayoutProjection.js\":\"6469ac57e8d83bb5\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelScrollAnchor.js\":\"50fb43a1f1f581c7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelUrlFlags.js\":\"8c7596633204390e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/platform.js\":\"9be2c3b271f02e71\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/pluralize.js\":\"8420eba56be712f6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyCreation.js\":\"6146327ef4506f89\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyNavigation.js\":\"af1abd3a6bf3bf1e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyValueContext.js\":\"770691469d8acf67\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/react.js\":\"db173811c90780df\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/relativeDate.js\":\"d2c96a3975023242\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/relativeTime.js\":\"5dd987a149dac147\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/renderScope.js\":\"2fb4f5e9e30de147\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/resolvedThenable.js\":\"b3c42362a3f042ba\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/routing.js\":\"8a7f0c1e8263d04b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/safeMode.js\":\"4c1f08cb636d9132\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/scheduleIdle.js\":\"fe25066b9d2d9613\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/screenWakeLock.js\":\"3e353c5d358c942f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/selection.js\":\"81d544da26a231c6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/softKeyboardGrab.js\":\"44ee11dc4910bcba\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/startupTimeline.js\":\"4647ddd2f4396341\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/state.js\":\"e810b88dd0d375a7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/string.js\":\"cee4f20037cbb983\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/surfaceZoom.js\":\"7f64fd9c47935b9d\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/time.js\":\"455a3a3fff41fcad\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/toast.js\":\"63bf4f1abb750f3a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/toggleStore.js\":\"46b322e2793cad9a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/untilStopped.js\":\"62a77dfc17d96ad1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/userActivity.js\":\"42ced480631d988d\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/viewTransition.js\":\"9a3670ee118110c1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/viewport.js\":\"1b3ce09905464567\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/webLock.js\":\"ca7f7b061c6b8113\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/workspaceRecovery.js\":\"940692c74900e670\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/workspaceSnapshotStore.js\":\"846bfe92a3a23f1b\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-compiler-runtime.js\":\"9bc6b2ec2c8d8940\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-client.js\":\"f9d2ef5f36c42514\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-server-edge.js\":\"bad2db9fe019858c\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-server.js\":\"3fa6ff6fa594ef23\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-static-edge.js\":\"2cd6e4799eb1d888\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-static.js\":\"31b36dcc7a8287f5\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-test-utils.js\":\"8319fe3f303a832e\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom.js\":\"e2d20ff3ead373f6\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-jsx-runtime.js\":\"000102c98a75e493\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react.js\":\"2406447857f02c71\",\"/knowledge-medium/pr-preview/pr-1868/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1868/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1868/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
