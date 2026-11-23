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
		buildId: "5b791d9d7606-841ef0a3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/\":\"7e085320ac71fbab\",\"/knowledge-medium/pr-preview/pr-1868/index.html\":\"7e085320ac71fbab\",\"/knowledge-medium/pr-preview/pr-1868/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1868/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1868/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1868/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1868/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1868/assets/FacadeVFS-B1MpbFzA.js\":\"c9d4b2a672b40d53\",\"/knowledge-medium/pr-preview/pr-1868/assets/OPFSCoopSyncVFS-BBTzTvG2.js\":\"fbd34d856318b8bc\",\"/knowledge-medium/pr-preview/pr-1868/assets/OPFSWriteAheadVFS-50XVw2lA.js\":\"8a5796845aeabbfd\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-Dp1ApXit.js\":\"b8cfab4e914551ae\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-async-DIHY8YLk.js\":\"6da179d18007e500\",\"/knowledge-medium/pr-preview/pr-1868/assets/worker-Bl0ZNVmu.js\":\"6d5d80ba2a3aaa26\",\"/knowledge-medium/pr-preview/pr-1868/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1868/chunks/app-D52m2qj5.js\":\"265581e60b8087a7\",\"/knowledge-medium/pr-preview/pr-1868/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1868/index.js\":\"a461fd6f2a00e2f3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1868/assets/AccessHandlePoolVFS-eh6aOhOe.js\":\"9a51738371bdfc7c\",\"/knowledge-medium/pr-preview/pr-1868/assets/IDBBatchAtomicVFS-CuxpBoSE.js\":\"72d03a08cb64dbc9\",\"/knowledge-medium/pr-preview/pr-1868/assets/MemoryVFS-DxFe1Fo1.js\":\"d58b5999fc6b418f\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-M7xxHz78.js\":\"78b9eaff7b7378ad\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-async-qO7VJkSo.js\":\"7b62faa94ef36901\",\"/knowledge-medium/pr-preview/pr-1868/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1868/chunks/AccessHandlePoolVFS-vNcUuLdv.js\":\"e3a348649c3ed923\",\"/knowledge-medium/pr-preview/pr-1868/chunks/FacadeVFS-CJWGzktL.js\":\"274bd27396b81d50\",\"/knowledge-medium/pr-preview/pr-1868/chunks/IDBBatchAtomicVFS-IZgf3-VP.js\":\"7b3c16f16ae6de35\",\"/knowledge-medium/pr-preview/pr-1868/chunks/MemoryVFS-CMSiqoq-.js\":\"840aba9c75174434\",\"/knowledge-medium/pr-preview/pr-1868/chunks/OPFSCoopSyncVFS-DxfsS_uR.js\":\"c3ecf7aea15b674c\",\"/knowledge-medium/pr-preview/pr-1868/chunks/OPFSWriteAheadVFS-DxElhXTQ.js\":\"f639235842d2b486\",\"/knowledge-medium/pr-preview/pr-1868/chunks/Preview-BUhHHxB-.js\":\"a1147f71f3df8d0d\",\"/knowledge-medium/pr-preview/pr-1868/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1868/chunks/card-Bd8MDWfE.js\":\"3e0a9f8764bb191c\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-8Sz1DiaZ.js\":\"bc755c33bf3a9540\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1868/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1868/chunks/mc-wa-sqlite-DkSLlo8u.js\":\"506235e092371067\",\"/knowledge-medium/pr-preview/pr-1868/chunks/mc-wa-sqlite-async-DFQqKPKI.js\":\"8d5112008cdd6598\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-BNo2e57U.js\":\"758468c063c99c64\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-BrAR6rRt.js\":\"3b4d5465ecb9dc2e\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-CDjlr3pj.js\":\"78bb6985cf228f19\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-CEcVndY1.js\":\"8d45f36ddfdf6212\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-CXrz7iKx.js\":\"b3da3d8de3134aa4\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-EdEr0kfm.js\":\"3be1c2a810a57ba6\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dPSkLzip.js\":\"f50c062962e3b545\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server-legacy.browser.production-B1RBv7t_.js\":\"19f69205064ef0e8\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server.browser.production-DwyyE26x.js\":\"f60ac6a44470f233\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server.edge.production-BY8r055A.js\":\"8e4df2496c421d6e\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-nzMSNhIq.js\":\"e6f1fd3258028e86\",\"/knowledge-medium/pr-preview/pr-1868/chunks/server.browser-CUMfeT-2.js\":\"64a2f712e691a7b7\",\"/knowledge-medium/pr-preview/pr-1868/chunks/textarea-DpudRj-Q.js\":\"8b0e452bf4a56a35\",\"/knowledge-medium/pr-preview/pr-1868/chunks/ui-BtId0RuC.js\":\"c879cb7a1fcb8614\",\"/knowledge-medium/pr-preview/pr-1868/chunks/wa-sqlite-BVcp6u9J.js\":\"6ce9167e6be5d795\",\"/knowledge-medium/pr-preview/pr-1868/chunks/wa-sqlite-async-DSBBl4QG.js\":\"edda67ad6161db88\",\"/knowledge-medium/pr-preview/pr-1868/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1868/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1868/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1868/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1868/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1868/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1868/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1868/src/App.js\":\"f730b4a26072a02d\",\"/knowledge-medium/pr-preview/pr-1868/src/appUpdate.js\":\"0e256bab62fe175a\",\"/knowledge-medium/pr-preview/pr-1868/src/appVersion.js\":\"420250d1d93b1a9a\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/initialLayout.js\":\"8fb8937becc3adfb\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/openWorkspaceData.js\":\"0484cdc253b80163\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/resolveWorkspace.js\":\"11fc98b07e55c9bd\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/workspaceBootstrap.js\":\"fd77a2e42d981758\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockComponent.js\":\"24eaacafdc03c1ac\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockCrumbs.js\":\"7dad824bf9cb56bd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockEditor.js\":\"6232146bcac36346\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockLoadingPlaceholder.js\":\"68ebf4d7a292b457\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockProperties.js\":\"68d1d88511d083ba\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockSearchPicker.js\":\"48f3c8cf0a855477\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ConfirmBulkDeleteDialog.js\":\"1b63b525698efef4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/DividerHandle.js\":\"44025f97f37a5347\",\"/knowledge-medium/pr-preview/pr-1868/src/components/DraftEditor.js\":\"7feb707ba2b7f4ac\",\"/knowledge-medium/pr-preview/pr-1868/src/components/GutterPill.js\":\"34df96a7da7e84fe\",\"/knowledge-medium/pr-preview/pr-1868/src/components/Header.js\":\"d9e5bcfc7ea19693\",\"/knowledge-medium/pr-preview/pr-1868/src/components/LazyBlockComponent.js\":\"7d1f66ef15a759d7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/Login.js\":\"71b4e83bf08756fd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ZoomableSurface.js\":\"b9dabab0a38c3f7b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/editModeKeepalive.js\":\"316f768ab8df14be\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyDisplay/PropertyDisplayScope.js\":\"aef034a6d7852f3a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"56f77ac9bdd0e853\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/RefPropertyEditor.js\":\"b2ad858ddd892768\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/RefTargetTypePicker.js\":\"e2b58105ae1016ee\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/SelectPropertyEditor.js\":\"9fc584a263c2e57e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/TypesPropertyEditor.js\":\"2b9fb1bf398b296f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/defaults.js\":\"55a08fae76bba89f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/kernelValuePresets.js\":\"de21ef6bee4db180\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/selectablePresets.js\":\"4124f33b2f76d26d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/typesPropertyUi.js\":\"2e07688adebb920f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/AddPropertyForm.js\":\"f22f6d31a5b07117\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/PropertyPicker.js\":\"deddcb756cf3ef41\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/PropertyRow.js\":\"cfc3fda218b3dcc5\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/Rows.js\":\"4a450bb7ce0ccb35\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/actions.js\":\"72751fb990158a6b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/declarationOnly.js\":\"5896b6fe9e9fc84c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/layout.js\":\"544df851d3140f55\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/model.js\":\"fb0b885921c5439b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/shapeUi.js\":\"cbb991dee4d69e4e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/shapes.js\":\"a294c5f79259ad80\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/usePropertyEditingActivation.js\":\"94626429d0a136de\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/visibility.js\":\"b6abad36b6e75034\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanelSections.js\":\"8b1eb8538d178977\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockEmbed.js\":\"58c766bf2aaabb6f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockLink.js\":\"2887791a0b5b9a5f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockRef.js\":\"75c16d5782b0e73a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/ReferenceLink.js\":\"1c3b6ff20260bdb1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/cycleGuard.js\":\"837118d72dd5106e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/cycleGuardContext.js\":\"293bb493cdfbfcd8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/linkInteraction.js\":\"77b2037de567eafd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/referenceLayout.js\":\"d54ce36fe85935e6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/useBlockRefAncestors.js\":\"028d9cb56549d280\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockGutter.js\":\"7128044367851479\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockInfoDialog.js\":\"d08e4b963e82b9f7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockTypeBlockRenderer.js\":\"60c13cabc806ffe5\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BulletHoverCard.js\":\"e6314053b4994ff2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/CodeMirrorContentRenderer.js\":\"c05c606a548525e7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5097d6622e2fcb2c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/ColumnResizeHandles.js\":\"b301b13e7a71fb84\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2bda70ba39558aec\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/DefaultBlockRenderer.js\":\"c8e0e34c62e717a6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/LayoutRenderer.js\":\"ca9e08886f6dd5dc\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/MarkdownContentRenderer.js\":\"5ce63556b234d687\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/MissingDataRenderer.js\":\"e20bb9f4c2b060ef\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/PanelRenderer.js\":\"0f540c084e0bcfcd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e08bf356f48ad5a8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/TopLevelRenderer.js\":\"097a39a62b4499ba\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/blockGutterMode.js\":\"9a6403f1a14ced98\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/blockTitleText.js\":\"496e7970832c9fab\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/fieldCreationKeydown.js\":\"c7950daddc85d6f6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/layoutRootContext.js\":\"e58dffeb0967a33e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/typeChip/TypeChip.js\":\"61ffd0deec35bff9\",\"/knowledge-medium/pr-preview/pr-1868/src/components/typeChip/chipStyle.js\":\"db296a0b4ac46075\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/anchored-floating.js\":\"69536dc8fcd50ff8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/button.js\":\"a70097ae113bd4ad\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/card.js\":\"559f3affa8bdb21d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/checkbox.js\":\"31ff6012a8ae69c1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/collapsible.js\":\"ae3e3128efc6dd85\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/command.js\":\"4005cf8f157f8f71\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/context-menu.js\":\"1826848166f0b872\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/dialog.js\":\"bb709e59df44e1c9\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/dropdown-menu.js\":\"eeafa95ba48ddada\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/floating-listbox.js\":\"3fb84a9ecf5bc3f0\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/index.js\":\"05257985f8e3f9b7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/input.js\":\"951421ce0239c593\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/kbd.js\":\"f9f656c3a41aae7b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/label.js\":\"57b1f5bc61cefe07\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/textarea.js\":\"584177359d2c6704\",\"/knowledge-medium/pr-preview/pr-1868/src/components/useEditModeYieldKeepalive.js\":\"9ef1ba9e688c4774\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/BootFallback.js\":\"b469e61f835fa0e4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/FocusedRowLazyMount.js\":\"403b25289a34b0fc\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/LazyViewportMount.js\":\"c204443422efd4cf\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/LocalDbCorruptionFallback.js\":\"a4ac44bf69b27e89\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/error.js\":\"2f305e11a44d8344\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/lazyMountRegistry.js\":\"48ccccf08a984144\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/suspense.js\":\"9726dba3e4d6c78c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/CreateWorkspaceDialog.js\":\"4f53e32d2003550d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/PendingInvitations.js\":\"a633837716f119a5\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/SyncProgress.js\":\"4d3caa1e8ae22d0e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/UnlockProgress.js\":\"e539cd86b2d6edda\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceKeyGate.js\":\"ea272332a8f15098\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSettingsDialog.js\":\"67600cd86b9167a1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSwitcher.js\":\"f9a15eedfd9aa323\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSyncGate.js\":\"92c584bd955f2684\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/ConversionFlow.js\":\"1387889461849b6e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/ConversionFlowHost.js\":\"d0276941fa021153\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/EncryptionSection.js\":\"cd17e816155a127a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/attachmentPrompts.js\":\"b8242b15e3a87e83\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3e1809613210054f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/conversionFlowDeps.js\":\"61ff487b80972a0f\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/conversionFlowStore.js\":\"64bc097bc29a7d01\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/flowUi.js\":\"9f1ea32417d5af32\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/useConversionRun.js\":\"e9014dc49f2ba688\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/keyUi.js\":\"1c243538e71ad152\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/useCloseOnKeyLoss.js\":\"ef7f8045ae865982\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/useCloseOnServerE2ee.js\":\"a028328ecdf57834\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/workspaceUnlocked.js\":\"522fb2d147372bc1\",\"/knowledge-medium/pr-preview/pr-1868/src/context/backgroundSubtree.js\":\"a61f8cdbc863fc3c\",\"/knowledge-medium/pr-preview/pr-1868/src/context/block.js\":\"793a4acb7d9e12ea\",\"/knowledge-medium/pr-preview/pr-1868/src/context/layoutWsContext.js\":\"37ad5ae29b45ab0d\",\"/knowledge-medium/pr-preview/pr-1868/src/context/propertyDisplay.js\":\"be44af260343e3c3\",\"/knowledge-medium/pr-preview/pr-1868/src/context/repo.js\":\"9721ddcf8eab2793\",\"/knowledge-medium/pr-preview/pr-1868/src/data/aliasClaim.js\":\"103d48a411bdb84c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/aliasSeatNamespace.js\":\"011e03c84c719853\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/blockData.js\":\"6f69497d002e9d4e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/blockType.js\":\"2fbe39f0a9004ada\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/changeScope.js\":\"b1b0fa3fc4415de7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/codecs.js\":\"e9c52810ac4c5dfe\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/derivedData.js\":\"aba3d7455f3a67d2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/errors.js\":\"bf6d0be315b55f56\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/events.js\":\"da31787b18c2ed87\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/handle.js\":\"5b880c03e226fd47\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/index.js\":\"3add28ae446a434a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/mutator.js\":\"f542e8b6d3481d3a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/processor.js\":\"45725bb66a75d14f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/propertySchema.js\":\"31fadb77aef7e5fc\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/query.js\":\"ed6c041b56e52fe2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/sameTxProcessor.js\":\"f710c6a2481df33b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/schema.js\":\"5b880c03e226fd47\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/tx.js\":\"5b880c03e226fd47\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/typedBlockQuery.js\":\"b56409a31364129e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/user.js\":\"731d75ab54f223cb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/valuePresetCore.js\":\"df767802c756d248\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/valuePresets.js\":\"7005f8ea4c19f129\",\"/knowledge-medium/pr-preview/pr-1868/src/data/attachmentCleanerIOVerb.js\":\"ac077f8fee88ae61\",\"/knowledge-medium/pr-preview/pr-1868/src/data/block.js\":\"06788c2a69a71bf6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockCache.js\":\"d1fc8dd034c2d934\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockId.js\":\"342a06810027eaf1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockLiveness.js\":\"3e45f1165f6360b3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockMerge.js\":\"d1d032170bb2cac3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockSchema.js\":\"02b6996d3a2aacac\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockTypeLookup.js\":\"aa3b5d1eac37f24c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockTypes.js\":\"5a40c67d80769f1e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/childrenView.js\":\"7e0cf92c379d870b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/clientContext.js\":\"ee381af8f19f28a8\",\"/knowledge-medium/pr-preview/pr-1868/src/data/dbFileSiblings.js\":\"c873a5497c10f2f6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/definitionSeeds.js\":\"65b9e948a67e4890\",\"/knowledge-medium/pr-preview/pr-1868/src/data/derivedIds.js\":\"a1ed203b049d2ddf\",\"/knowledge-medium/pr-preview/pr-1868/src/data/drawnSubtree.js\":\"f77ede86087b6ba1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/facetBridge.js\":\"1b27ffb34adfd825\",\"/knowledge-medium/pr-preview/pr-1868/src/data/facets.js\":\"62e34e4af0d4c2c6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/globalState.js\":\"7c8de32a70f00f02\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/aliasClaimRederiveProcessor.js\":\"d2ee00f3a134e417\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/ancestorBatch.js\":\"dadac6b951c2c190\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/blockTypeTypeifyProcessor.js\":\"29fef1aa1fab3ae5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/clientSchema.js\":\"4ec3820289dd4b4a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/commitPipeline.js\":\"b0c096a635d966b2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/devAssertions.js\":\"4479dd80601671ad\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/firstSync.js\":\"18a706ca2fbcecd5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/freshInitialLoad.js\":\"fd487f0aae324b5a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/graphBackfillClaim.js\":\"76c2891955b8f264\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/handleStore.js\":\"e1f0635b7aa4c992\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/idleMarkerJobs.js\":\"3a17206007749ab4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/initialDownload.js\":\"6660921fe99b3e6f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/initializeClientDatabase.js\":\"de031af5d0af07bb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/jsonCanonical.js\":\"83588dc35aad878e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelInvalidation.js\":\"5e2ad3e9fdd56e3f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelProcessors.js\":\"74916938f1cfe08c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelQueries.js\":\"012c3f8bbd72d2b7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/mergeTypeMembershipProcessor.js\":\"44e5a8402ad9fa21\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/normalizeReferencesProcessor.js\":\"9e0ecb4f1d759b68\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/poolInstrumentation.js\":\"cb1ffdc60065791f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/processorRunner.js\":\"2e9227397bcdf6ef\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyCellBackfill.js\":\"215fc18f60ab06eb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyChildMint.js\":\"e9b82d03a9fcb212\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyChildrenProcessor.js\":\"f491ccc84781bfd9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyDefinitionChangeProcessor.js\":\"88cd08964699ba1c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyDefinitionSynthesis.js\":\"4e2a74d217735055\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyKeyScan.js\":\"910bd9b6b26205c6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertySchemaResolution.js\":\"c2708d5552d0172a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyValueEdits.js\":\"815148254f2a39e1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/raiseProtocol.js\":\"104e6458bde02a0c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/readBatch.js\":\"8f6877e120a28974\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/refProjection.js\":\"448c700ebd1a4559\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/referenceTargetLookups.js\":\"de0e5496dd5195ff\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/referenceTargetProcessor.js\":\"561769781a94924f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/replayMerge.js\":\"1ebc2c2d5ebcb749\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/sqlBinds.js\":\"b4affec5f5d9f000\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f4372879b504b0a1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/arrivalProcessors.js\":\"d2f105778473852c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/invalidate.js\":\"c379c47b970cace3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/materialize.js\":\"1d75697875cc957f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/observer.js\":\"30c4abce11f68637\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/reconcile.js\":\"c2e510658063fbcb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/timingMetrics.js\":\"5ead061c84b8bbd3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/treeQueries.js\":\"50dbd307e460ddf4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/txEngine.js\":\"e6e36dd78296331b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/txSnapshots.js\":\"9166fab8e7cbbfde\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/typedBlockQuery.js\":\"9477b08ea74ffc9a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/undoManager.js\":\"af079d7da3bc7aff\",\"/knowledge-medium/pr-preview/pr-1868/src/data/invalidation.js\":\"42d800ac43726b6c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelDataExtension.js\":\"a49db4e99746fe15\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelPage.js\":\"b51c3f3429154021\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelValuePresetCores.js\":\"0be7140b201c592e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbCorruptionSignal.js\":\"e6f37e4442db939e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbStorage.js\":\"13e7069ba2a53b78\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbVfs.js\":\"b38cddabc036d0fc\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localSchema.js\":\"4e4554332d1819a1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/maintenance.js\":\"1c93c321b34fe727\",\"/knowledge-medium/pr-preview/pr-1868/src/data/mergeProperties.js\":\"d6ac20dcf891b8f1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/metricsConsoleHook.js\":\"27c3371c09235746\",\"/knowledge-medium/pr-preview/pr-1868/src/data/migrationsPage.js\":\"ef8cada6cc282de1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/mutators.js\":\"a816ba5c9c82b36b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/orderKey.js\":\"29dad75ceac88434\",\"/knowledge-medium/pr-preview/pr-1868/src/data/orderKeyPlacement.js\":\"5e3f50625ed19c02\",\"/knowledge-medium/pr-preview/pr-1868/src/data/outlineSurface.js\":\"b16bc10a8e4ff0db\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pendingEditorContent.js\":\"cd931f1acac77b4d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pendingUploadsSql.js\":\"4ff86091b9012ea1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pluginStateExtensions.js\":\"72a235ef26b9ca9b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/powerSyncLogger.js\":\"5027669ad669f07c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/projectorRuntime.js\":\"da26e9d745358354\",\"/knowledge-medium/pr-preview/pr-1868/src/data/properties.js\":\"463806f6a5cbc4fc\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertiesPage.js\":\"734049adfedb6add\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyChildren.js\":\"8b4ce2e784d7ac7b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionFanout.js\":\"6a0ed668d8250e84\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionMetadata.js\":\"385948488755a8b3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionRegistry.js\":\"a78ab270449cb48e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDisplayMode.js\":\"770f3195c1b81123\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyRowCreation.js\":\"c8060b0ab172f8ab\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertySchemaCreation.js\":\"fbaca783c5243979\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertySeeds.js\":\"8d4b1203a1d119fc\",\"/knowledge-medium/pr-preview/pr-1868/src/data/recentsPage.js\":\"9c009301c475cbc3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/referenceBlock.js\":\"d809c1022bfc4093\",\"/knowledge-medium/pr-preview/pr-1868/src/data/rejectedUploads.js\":\"b36779fe296b7d4c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/releasePowerSyncConnection.js\":\"6a4606a997b5cd5d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/repo.js\":\"48a7559a5612d0ce\",\"/knowledge-medium/pr-preview/pr-1868/src/data/repoProvider.js\":\"42ade277f51dcd4c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/rowProperty.js\":\"86bdc261b502a1d6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/searchFilter.js\":\"c0867f7b194b62ca\",\"/knowledge-medium/pr-preview/pr-1868/src/data/seedIdentityLedger.js\":\"568202eaf42e2b58\",\"/knowledge-medium/pr-preview/pr-1868/src/data/stateBlocks.js\":\"7f44d7aa90cd4709\",\"/knowledge-medium/pr-preview/pr-1868/src/data/structuralEditPolicy.js\":\"3f42c10f26d4f43a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/subtreeDelete.js\":\"77797f2b9cee0263\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncStreamLock.js\":\"18fbb490294a48e9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncedTableSqlRecognizer.js\":\"c9c2a84dc896d596\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncedTableWriteGuard.js\":\"7387d56ab90e4f3f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/targets.js\":\"be1f33ffa79f9b8a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeColors.js\":\"18b7c2bd202cbde0\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeDefinitionMetadata.js\":\"32c4f941e3da7e83\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeDefinitionRegistry.js\":\"9a8f2006f0e65dd0\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeExtraction.js\":\"f615082fbad56d70\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeInitialValues.js\":\"188124c8d0b61d04\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typePropertyGroups.js\":\"d5b0e4b700bab9cd\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeSeeds.js\":\"104d398be493bb61\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeTagger.js\":\"d601a4355bb3c55d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typedRecords.js\":\"21d31db2b7ec7d69\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typesPage.js\":\"0be05f1857b09b21\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userPrefs.js\":\"20c453ae4a72fffd\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userSchemasService.js\":\"6130da1f09c0be4f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userTypesService.js\":\"45df84fd428ca978\",\"/knowledge-medium/pr-preview/pr-1868/src/data/valuePresetRegistry.js\":\"e3646eb3f60e7391\",\"/knowledge-medium/pr-preview/pr-1868/src/data/visibleChildren.js\":\"636795530628deee\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceConversion.js\":\"1fa9011e2ca1c4cf\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceFirstSync.js\":\"b88b99813eb2437f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceIdNamespace.js\":\"aed471ab602147f0\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceSchema.js\":\"66cb055bc538d965\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaces.js\":\"62da0404ce45605a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/writeAheadLog.js\":\"19b90267e789614f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/BlockPasteShellDecorator.js\":\"bcec2014ef3e1fb7\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/atTrigger.js\":\"a0b9ad02fcfe89a9\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/autocomplete.js\":\"c71ac791bed9a327\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/codeMirrorExtensions.js\":\"64328c4a515dc983\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/contentFlush.js\":\"f6d32acdf517ee6b\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/defaultInteractions.js\":\"a4177d9f945aefe6\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/editSettleSignal.js\":\"c86d3649e0b6e396\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/insertImage.js\":\"1f732beeb669e99d\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/referenceCompletionRange.js\":\"40d437bd60815705\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/referenceTargetTypes.js\":\"18df6bd87c0ac2f1\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/syntaxContext.js\":\"0ddd2701d6623323\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/triggerMatch.js\":\"c595f41effafdd4b\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/AppRuntimeProvider.js\":\"cb4e5799b5bec681\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/BlockFocusShellDecorator.js\":\"5559be3bb57da4fe\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/ExtensionRenderBoundary.js\":\"3f0408a9742ef456\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/PanelContentRecovery.js\":\"5625521d175b423f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/apiCatalog.js\":\"0c649b84cfc49268\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/approveExtensionHere.js\":\"55aa1bb9990adcb6\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/armedCutAppMount.js\":\"16095c6a67862b7f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/batchableKeyedStore.js\":\"12019869355c59c3\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/blockInteraction.js\":\"3a2be62586985f39\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/blockSelectionAction.js\":\"0e9ac72a14a072f3\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/compileExtensionModule.js\":\"6c3c90eaa00fd486\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/compiledModuleCache.js\":\"31acc754468929af\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/continuousGestures.js\":\"4ac9240354c9607d\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/core.js\":\"7dea32697471c39f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/defaultRenderers.js\":\"6663570b9f48c89b\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/definitionFanoutAppMount.js\":\"fef181ed71e40971\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dialogAppMount.js\":\"205aac2b9f40565a\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dynamicExtensionSeeds.js\":\"0398a3156d40cf64\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dynamicExtensions.js\":\"e8a2c5901786da6e\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/exampleExtensions.js\":\"c0f7595ba77ed8f8\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionApprovalStatus.js\":\"6e6fb3d65de64739\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLoadErrorToast.js\":\"5676ef339c996c68\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLoadErrors.js\":\"0c5d27ef3ee80516\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLookup.js\":\"56b12bea5bbde025\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionToggles.js\":\"8b7dda5e187bef45\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionUtilitiesCss.js\":\"571549aa964964b3\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/kernelPageDeletionGuard.js\":\"1bcfab2f5591a60f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/liveRuntime.js\":\"61ed703a654d8016\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/openExtensionsSettings.js\":\"a4df1dfd352d0c41\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/overridesCache.js\":\"d9a427e215609760\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/pluginIds.js\":\"80478eb2bacc2e9f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/processorRejectionToast.js\":\"c9c34d5f2366ebb5\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/runtimeActions.js\":\"131f1e8f1ae3e86a\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/runtimeContext.js\":\"53f37ed3b6694dc9\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/staticAppExtensions.js\":\"7361acccdfafccca\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/staticDataExtensions.js\":\"7bd2d4ec9a7f16ca\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/toastAppMount.js\":\"6f86a70505cbf8c7\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/useOverrides.js\":\"3f7ac358ca976fb3\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/useShortcutSurfaceActivations.js\":\"4299cefe717e81f7\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/discoverToggleTree.js\":\"e75e286cd69c428a\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/facet.js\":\"564b28d5d7c59974\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/resolveAppRuntime.js\":\"0584581951f180b5\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/runtimeEvents.js\":\"d1b7ae69c2701e79\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/togglable.js\":\"16f7d1d702d428b7\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/variantFacet.js\":\"ff1c0bfeab6d925d\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/verbFacet.js\":\"d167ca23e6e287c1\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/block.js\":\"a6066c71df7dc5e2\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/focusedChild.js\":\"74cfac122e9d6052\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/propertySchemas.js\":\"963399c498d5d1d1\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/typeRegistry.js\":\"3054530db68fb0c2\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useAncestorCrumbs.js\":\"60bc2aa8a0437387\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useAutocompleteListbox.js\":\"6ba70216ad9c0ed2\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useDebouncedSearch.js\":\"8ffde88e905b8a6c\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useDebouncedValue.js\":\"ee0819e8f000af7f\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useIsFocalRender.js\":\"a89e1fd52361fa70\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useIsReadOnly.js\":\"286ceb85dd073e1a\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useMaterializeBacklog.js\":\"2bf64cce4484d7cf\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useMinuteClock.js\":\"4c3928c33cdec890\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/usePanelLayoutProjection.js\":\"4da17ac46c7199da\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/usePendingInvitations.js\":\"021b31b1ae4da227\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useRendererRegistry.js\":\"49f70f98b59f92c7\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useRetainedFieldRows.js\":\"c59598943a70dc27\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useWorkspaces.js\":\"4b0bf918928539bc\",\"/knowledge-medium/pr-preview/pr-1868/src/lib/utils.js\":\"24071a4fbff501b6\",\"/knowledge-medium/pr-preview/pr-1868/src/main.js\":\"13d248a8dcc04824\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/MarkdownImage.js\":\"d08addc2d8b657bc\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/blockSeparators.js\":\"fde5c55a404e9050\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/context.js\":\"004a06426cff16b1\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/defaultMarkdownExtension.js\":\"350b004dd7c6cb04\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/extensions.js\":\"40a0bf30b705fa23\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/renderMarkdownHtml.js\":\"a566c091631ab45d\",\"/knowledge-medium/pr-preview/pr-1868/src/minimal-editor.js\":\"177c5f4c66ac68f5\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/armedCut.js\":\"b158e85143105e16\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/captureMediaVerb.js\":\"78439dc1fd1a3224\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/clipboard.js\":\"346204e464e6258c\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/decision.js\":\"7e99dc5f83c39ed7\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/operations.js\":\"969774b95b86cba6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/account-header/AccountHeaderItem.js\":\"d86f74f9cc65c64a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/account-header/index.js\":\"52aa56c39e50fe1a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4c323906f5d45f23\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/askAgent.js\":\"179604ebc5a66690\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/askedStore.js\":\"24da156610123a93\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a3dde120ec8b277e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/chipState.js\":\"c90164e368ebe8c3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0b1622ce9fea3139\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/index.js\":\"ec3c3f6bd868ba22\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6bc38115f42eb27b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/schema.js\":\"8fc2a756851fbd8a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8c440b76fb73e432\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7eebd391bebc5847\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/addMedia.js\":\"08eb0c1c5616a400\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5e1821c046a79403\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/block.js\":\"0a9675c9e7586108\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/context.js\":\"5da3ed48ef00dfde\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d5cae48904e6842c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/index.js\":\"f113f12605bf30e0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/outline.js\":\"170a846f232cae07\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/properties.js\":\"f41d5284699c9768\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/refs.js\":\"10c8ce3affb16e0d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d1400fecdc335abd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/search.js\":\"e30a94b0e5bacb4b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/shared.js\":\"f481981953c41bd1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1289d109427e5758\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/text.js\":\"00456e869f4706b1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentWrites.js\":\"4e5836a4b4a2cffe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/authoringCatalog.js\":\"1ff99c3457045bf0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/blockRefTargets.js\":\"8aad227b64879d81\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/bridge.js\":\"f95259bc3d2830d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/bridgeLoop.js\":\"9d11d9f5b347b923\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/changeHistory.js\":\"4ac283f0e1411f86\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/commands.js\":\"d6c4b2958bd3c9d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/commentsCommands.js\":\"4a8562e98890dfe8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/dataExtension.js\":\"f479731eacb6228d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/dataModelGuide.js\":\"053e5295c5bb38f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/describeRuntime.js\":\"330e66b969ace810\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/extensionLint.js\":\"c77ef0dc7c2b9f62\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/grainAudit.js\":\"234634e5098ff116\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/healthCommand.js\":\"8e689d3a15fba18b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/index.js\":\"325c3b7406cbc1b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/presetIdentity.js\":\"e5ae867922493379\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0aca0329bdc6c1f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/readMedia.js\":\"19387f2307b01260\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/schema.js\":\"07dc07d07e279a6e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/serialization.js\":\"173672b2be603eb2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/targets.js\":\"426473d88e6d2386\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/tokens.js\":\"9ae77e5baf157a4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/watchEvents.js\":\"0a72effbb22f63cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/workspaceGuard.js\":\"eb82118fef223f1c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/writeCommands.js\":\"9782b0dd6d2341e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/AliasCollisionToast.js\":\"d636bd67647f7955\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/DuplicateNameBanner.js\":\"37a32261bcac79e1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/collisionMerge.js\":\"84878b51f05b90a0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/dataExtension.js\":\"a18120daf95c1e5f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/index.js\":\"93d4b9a6c81e3980\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/mergeCollisionAction.js\":\"c62e2e7529e322be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/pageStyling.js\":\"b6f36223c84cacc9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/rejectionToast.js\":\"30df6c9c767301b4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/syncProcessor.js\":\"54a79607c911c9b9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/actions.js\":\"f909119dfa3be44e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/addComment.js\":\"3d8c710a97a5f80a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/anchor.js\":\"b7e0f8f717b4cc9e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/anchorState.js\":\"4f0333ac50263680\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/commentLinks.js\":\"dea7dfddad34e399\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/confirmThreadDeletion.js\":\"152c42a381b77833\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/container.js\":\"0714442d02f8a9ba\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/dataExtension.js\":\"7a1ee9c8cdd14b88\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/deleteComment.js\":\"5ca8922a7d0ec03b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/highlights.js\":\"e4863503949d1b0d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/index.js\":\"b18847cd00e788fa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/linkedCommentsPill.js\":\"e36e7cf4c2373123\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/margin.js\":\"d170a230e8e1db30\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/marginSchema.js\":\"c006a3a2725c0d0f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/newComment.js\":\"e4b3e674cc6d67bf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/ownThreadPicker.js\":\"97a6f797c43409e7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/placement.js\":\"e97ec16e76db5cdf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/queries.js\":\"2a96740e3fd9c490\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotePosition.js\":\"20fbd1ecc1ebe8a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotedIn.js\":\"c9d6d0ffb3ffcc81\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotedRange.js\":\"00897cced840a763\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/rangeRefs.js\":\"8709ec87dc6aba71\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readHighlights.js\":\"d4967ed3dc832537\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readSelection.js\":\"3bce83e6bf09ca06\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readSelectionUi.js\":\"135d08ccf6b530e2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/reanchor.js\":\"2e0fb74bfc0b02ee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/schema.js\":\"0940d50ea7f63b90\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/scope.js\":\"4d174ff9fb5b4b96\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/scopeThreads.js\":\"b67a7553c7c3ed2b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/splitRetarget.js\":\"5ca33c06ed9aff2c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/suggestionCard.js\":\"a03fc0e069abb631\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/suggestions.js\":\"4fae7b71707f6527\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/summaries.js\":\"9354ca747f262074\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/summaryBatch.js\":\"797e5a01292bf63d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/surface.js\":\"ed305a603360952f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/threadNavigation.js\":\"bc3050f7d9e55011\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/threads.js\":\"8f902de8db2b4425\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/ui.js\":\"59e205f423ae3452\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/uiStore.js\":\"6bb255676f707ad4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-intents/appIntents.js\":\"a7cd1b55b1af4d99\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-intents/index.js\":\"1f7821b368e4b387\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-update-prompt/index.js\":\"d0e31f67514c9378\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-update-prompt/status.js\":\"c9fae48460faa723\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"07fb6ddc32e5068c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaBlockRenderer.js\":\"3692c3e5d601d39a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaDownLaneReplicator.js\":\"23161505a4d59024\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaUploadReconciler.js\":\"7d23aa2f8cff0c8d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetDownLane.js\":\"2b3241cd4dabda45\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetResolver.js\":\"98a21a74eb1a9209\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetUpload.js\":\"14036377d9976f6d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/attachmentCleanerIO.js\":\"4847d90f66f49e99\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f00af9a4eedd0a18\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/blobStore.js\":\"ac43b3d0d4c8f0cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/browserMedia.js\":\"ff4050433de07a1a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/byteStore.js\":\"3a4b5810b382a660\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/cleanerIO.js\":\"aaac0d8ddd7aa663\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/cleanupAttachments.js\":\"aa91f74160af6208\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/dataExtension.js\":\"79d611d8eb7d3396\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/downLane.js\":\"5955466ba7587d77\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/index.js\":\"3e7dde8f36b168dc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/insertImageContribution.js\":\"cdcab8b438bc6cd0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/laneArming.js\":\"983fbec5cd9250df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/laneLock.js\":\"23cb0471b649aaeb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaBlock.js\":\"1bf687aa585da41b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaCapture.js\":\"be8f9bd1c84804ab\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaLanes.js\":\"921ab01f08370200\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaViewers.js\":\"9f9db46d69145fd8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaViewersFacet.js\":\"9ec43dd7bb700f64\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/pasteCapture.js\":\"fbffad905e9e7ee9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/resolver.js\":\"44d1db5adf4ecd22\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/retryUploadsAction.js\":\"5445357ed3345bca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/storagePaths.js\":\"e92c387e13e2544f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadDrain.js\":\"236b51e6d6200b66\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadLaneStatus.js\":\"f1747310cb7174e9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadReconcile.js\":\"d6996380df37e884\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadRecovery.js\":\"26b49ea178e0f563\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadStore.js\":\"a3135135155f5220\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/useAssetObjectUrl.js\":\"e29e53d62c2b50f2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f256a3936103110d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/BacklinksViewSection.js\":\"719b48f2f0a639b9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/facet.js\":\"e81b8668416ac238\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/index.js\":\"4312bda61ac425ae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/prop.js\":\"efbfd1763b5133d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BacklinkFilters.js\":\"5847f610797e5e82\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8e18a1f8d9e2344b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BlockEntry.js\":\"0cadd3d6643391ca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/LinkedReferences.js\":\"ca6d2987b7e634cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"11e7aaef91fff567\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/dailyNoteDefaults.js\":\"64846b5dd91cdad9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/dataExtension.js\":\"f7f2b019a071a171\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/edgeExclusions.js\":\"c9c539cf9281bcc5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/filterProperty.js\":\"9e824d4be719866b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/index.js\":\"02efee401246b79a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"14e3a0a1d3da8888\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/applies.js\":\"8cf479047420a5dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/countQuery.js\":\"c4524e0973afe28a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/expansionStore.js\":\"35d197a7d9bff26a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/index.js\":\"fa8a6098e3ef36ec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"cda6d5ddec60bd8a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/presentationInvalidation.js\":\"e9814a24659cb9ff\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/propertyEditorOverride.js\":\"e918a080ba2b8a6a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/propertyFilter.js\":\"fe90dd26d5e02288\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/query.js\":\"199399c42a5479cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/resolveFilter.js\":\"3454d55d3af03f0d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/sourceBatch.js\":\"d0aa8034efdf11f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/sources.js\":\"9cafa1f20269dff2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/useBacklinks.js\":\"9ab3d0006ca63622\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a02cf7b4af6a43a2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/BirthdayCelebration.js\":\"6bb5c42a2fc75bad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/BirthdayOverlay.js\":\"37ca182d04a096a8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/gate.js\":\"44b31db4c193107c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/index.js\":\"f7e7dbfa547362bf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/wolfTheme.js\":\"b64d677507e42193\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/BlockDragLayer.js\":\"8407ffbd0a38aca7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/dragController.js\":\"51d28d00b1c89dc4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/dropTarget.js\":\"9d750f1b06ccd55e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/index.js\":\"3bc326d6627f8faf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/projection.js\":\"95c5775de11934b8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-info/BlockMetaCard.js\":\"0141095d4d7c67a3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-info/index.js\":\"27e2a35de1b59948\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/AddTagDialog.js\":\"61c9c8a2d745fad8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5931e0404a4feb01\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/TagNameIssueHint.js\":\"b31b153f1de8bfc0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/addTagAction.js\":\"e48db769d8d8798a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/appendTag.js\":\"3a13556477630c32\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/config.js\":\"8d737172d80bb7e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/dataExtension.js\":\"738fbd3ec54e60a5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/index.js\":\"13b17ea51515f533\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/propertyEditorOverride.js\":\"96fb239a6de068b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ae7e91e7d7d76949\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"56d14ddc3050f2b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/Breadcrumbs.js\":\"880e5b7dbbdea109\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9602f7d90776c068\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0ae8a31ec39a353d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/index.js\":\"df333eafd268eff7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1fcc9c6b4d6f4fd2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/CharacterCountItem.js\":\"91187c2963f0748f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7f8ba39b4fd94dca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/actions.js\":\"e64a6d76e965dbbc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/blockType.js\":\"cd5a890fad3652c8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/charCount.js\":\"194a60506b9fab19\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/dataExtension.js\":\"bf46943292898fc7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/index.js\":\"14511da2d7daecf8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/profiles.js\":\"46b717a35cae94a1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/properties.js\":\"27313dc3c1fcd9ab\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/textCounts.js\":\"c7d46fdd370b9862\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/colemak-keybindings/index.js\":\"a7a4266fbe010dd2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/CommandPalette.js\":\"0c7dcdbdbacb9a0a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/HeaderItem.js\":\"70e027574152a243\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/context.js\":\"2bc4e2b31e5e96b9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/index.js\":\"60b1509adb489a52\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/selection.js\":\"ccb14465090d106f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/toggleStore.js\":\"d537c34109e33de1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/useCommandPaletteActions.js\":\"28258b058ac32aed\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/ContributorBadges.js\":\"5b93bff4e54404b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/author.js\":\"2a6c0a55f83d952e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/codeMirrorExtensions.js\":\"8136f46eb5e8b135\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/dataExtension.js\":\"fb5d17fc18ad91ee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/index.js\":\"4f16bf002f4b0e39\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/mentionAutocomplete.js\":\"16f16dec094db0de\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/processor.js\":\"be83d6b54129c947\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/profiles.js\":\"9cc813515b72b53f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/queries.js\":\"ac1ebe32e04aeb71\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/schema.js\":\"15ab19e40d08d58e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9114bb2b414b86d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/followOrigin.js\":\"50785755890f2eb9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/index.js\":\"514a01b39f0f9d85\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"93123e755f590e4b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"fca6d9f0ba70049b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/CalendarGrid.js\":\"5bfdca9dd58071f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DailyNotePicker.js\":\"a6decbcb945d8a8e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ce16aae2fc9a14b3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateNavDecorator.js\":\"ee26de54d602f0b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateScrubOverlay.js\":\"e552347020b195dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/HeaderItem.js\":\"e7996acd420f754a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/ReschedulePicker.js\":\"c1124287dba9982a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/SpreadDatesDialog.js\":\"443c2ac7bb0f1253\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/actions.js\":\"92b5b2dce74f7471\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/blockDateAdapter.js\":\"d84f6b5e05fd0e2a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/calendar.js\":\"f436bd8ce13577df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dailyNotes.js\":\"aac69edbf56d9d02\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dataExtension.js\":\"4d74548e6cd6ab6b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubActions.js\":\"6a576f730779a883\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubGesture.js\":\"dd15ea4a072f32cc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fb5f5d19527ed5f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0ec334dbeb156949\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/deletionGuard.js\":\"2fdca477c7fca9b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dueQuery.js\":\"3485f63e3c57236a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/index.js\":\"09ffecdd49930324\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/landing.js\":\"cc6e6860c19b2e6f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/localSchema.js\":\"fbe4d553f0306138\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/referenceDateAdapter.js\":\"cdcfec97b2e77d85\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/rescheduleAction.js\":\"56876f1c2295d3f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/schema.js\":\"3efd259441187ac4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/spreadBlockDates.js\":\"d6083fb972b74a21\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/spreadDatesAction.js\":\"6587bec2d3b8811c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/today.js\":\"2c4646f6313cdc53\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9916758fb98bc0ef\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"41cb110283dcd9ef\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/audit.js\":\"28f4db72495e6557\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/auditAction.js\":\"09912f3c98b7965b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/auditRanges.js\":\"a9da25d457a48af9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/diagnosticsSource.js\":\"2c1de592dd7cebb2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/divergenceScan.js\":\"d9800a6cfc2eed3b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/index.js\":\"9f2170ab23f833f9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c668905fe1897f35\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/referencesMirror.js\":\"aad3a8186111f771\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/rowJson.js\":\"c7461306793b445c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/schedule.js\":\"917d4ad71a894db9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/store.js\":\"ae7626daf2ee8a3f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/action.js\":\"b725f96a12ffb813\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/index.js\":\"0520cf4aa74a733a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/plugin.js\":\"6b61dc668ce2fdd5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6f7addb6ca75bb69\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/actions.js\":\"7914d40339303d3b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/changeMarker.js\":\"087064ca2f227e0d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/diagnostics.js\":\"6104439990035f0d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/fileSystemAccess.js\":\"75f2ee3f9ae1bc5b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/filenames.js\":\"4c57fe68d8e14093\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/index.js\":\"657c3e363768b903\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/mirror.js\":\"5b2918235dd0ab96\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/runLock.js\":\"76d275641eaca6ce\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/runtimeHealth.js\":\"ddb8c80edf31dfd5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/schedule.js\":\"0922cc893868e1e2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/store.js\":\"ad0b6dd918ae6099\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/default-themes/index.js\":\"a12447dec8a74ef4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/default-themes/themes.js\":\"33392f683a43931f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/diagnostics/facet.js\":\"b43359a388eb643e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/diagnostics/useDiagnostics.js\":\"fa6dd4e35b3d145c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/dismissals.js\":\"39101dd4af76d057\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/index.js\":\"d48335086a5eaf16\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/status.js\":\"3cb989af4517cc54\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/store.js\":\"2078576e5ae6ae73\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"524b473b8f115ad9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a7b8f934525aa442\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/actions.js\":\"30f76579bfe8e39b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/config.js\":\"8b980142a34a6d64\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/dataExtension.js\":\"310cf986ecdc0078\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/effect.js\":\"7959236ae5afec02\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/index.js\":\"081526b4d50a2852\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/propertyEditorOverride.js\":\"e3008a739dc1a3c0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/useToggleTree.js\":\"7920404de24bc17e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/ExtractTypeDialog.js\":\"dd34005da94fd612\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c184a9bf01fa4e1e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/PropertyShapePicker.js\":\"9c04b312213543f4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/action.js\":\"33b183915e6ef7ae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/index.js\":\"45eefb6bcc6caf29\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/FindReplaceDialog.js\":\"82de0c9f6e7c3698\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/HeaderItem.js\":\"290f6707180530e8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/dataExtension.js\":\"101ff95a174d4f21\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/index.js\":\"2bf644edaa872c3a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/search.js\":\"2ccab6fe42e671dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/toggleStore.js\":\"fa5499275855ffd6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/LocationPropertyEditor.js\":\"d74018e16230fbfb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/MapView.js\":\"b2ad1438c6c2deb9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/blockTypes.js\":\"8f942eb42cfcc7db\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/codeMirrorExtensions.js\":\"9ecdf4141aabeafa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/createOrFindPlace.js\":\"1a79df716b5b82b2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/currentLocation.js\":\"8600aacb825d38c3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/dataExtension.js\":\"a934513f082ff17e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/geoContentDecorator.js\":\"21cc83bfdfe10856\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/googlePlacesClient.js\":\"14e2d6f615a98b91\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/index.js\":\"34d977dc22e56f74\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/locationsPage.js\":\"666d008c875fe973\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/mapViewport.js\":\"9cfe98b48ae98b1d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/pickCurrentLocation.js\":\"cb1bdc9295e711f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/placeAutocomplete.js\":\"f9d59813230da6ff\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/placeNameCollision.js\":\"db25e902f3264f29\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/properties.js\":\"fa1a1d0e1e84be11\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/propertyEditorOverrides.js\":\"84cf4706b477406e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/query.js\":\"d9fd448b01a92658\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/usePlaceSearch.js\":\"e882c34b21de1371\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"09694115fc885156\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0bd48bf912ad9e25\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"88c58713d1e41aed\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/config.js\":\"a7291260434b9b00\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/dataExtension.js\":\"ff442b4a4bfe6d17\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/facet.js\":\"53f822c3b109e9b3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/grouping.js\":\"04b408197ff75d59\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/index.js\":\"49d406faa2d789ca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"aa4e35b3644b420d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/query.js\":\"e826d9dd44290faa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/resolveConfig.js\":\"cad39a1252ecb4af\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"90e58acd0b009325\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8406e7b61a6ca5ec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/HtmlDocumentContent.js\":\"5e1ec2c0dec12246\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/HtmlFrame.js\":\"41afb351d9d840d8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/actions.js\":\"00ac30d5600c4124\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/blockType.js\":\"a49f62841e026646\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/confirmRunScripts.js\":\"72c9f2bad82b32f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/dataExtension.js\":\"953cdd5d3d15c3b1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameAnnotations.js\":\"d6a4a5709dd2ff4e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameDocument.js\":\"26344d169f682e0a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameTheme.js\":\"ea833442bd555927\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/index.js\":\"25512c85bed60e4c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/scriptConsent.js\":\"cbc527c1c466b3ef\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/sourceMap.js\":\"dae9b6f129dc1627\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/useDocumentScripts.js\":\"4a5b0e4e88202bf3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/index.js\":\"869ab3d91cfcfb4b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/record.js\":\"398f1a3fdbf3ce7f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/recordStore.js\":\"f1b2c43adcd1fdbb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/responsiveness.js\":\"b513c12254b95337\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/schedule.js\":\"2d6e1d3692cf6859\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/sessionContext.js\":\"46cc43412ab52828\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"901e723d01663473\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e4f310b4a02d51f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/actions.js\":\"97ce5486d70067f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/config.js\":\"d4e90434c0388b55\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/dataExtension.js\":\"626ee28558ef6f11\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/effect.js\":\"3a55008cbda24e6f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/index.js\":\"d41aef0aed9df5d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/keyCapture.js\":\"30ad8627ef175eb4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/overrideStore.js\":\"731c47fa5f84e90c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"76f7c363728ce390\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/HeaderItem.js\":\"85941a0080d52e68\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/LeftSidebar.js\":\"496c75c4441c9e1c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/actions.js\":\"6759b597bcaba0b3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/facet.js\":\"525452403302aad7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/index.js\":\"c48048ba48c49d42\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/shortcuts.js\":\"c48ea4a868eac668\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/toggleStore.js\":\"ca8366e86b64c4bf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/MergePicker.js\":\"43befb75e22d56a0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/index.js\":\"9e76244d3e3338e2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/mergeAction.js\":\"7967af866702a353\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/strategy.js\":\"49fa0c56267aa410\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/Button.js\":\"5a8efe0ae05dd044\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"eb886fc265d141cc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ce6f8b4295feb3ad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/facet.js\":\"e4f9695c41b514d7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/index.js\":\"d387fd2da2dbbbdc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ba63a8fe36ee3fb0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5c09b5a75c4736d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d13eaf200dcbe71a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6f9003b00e83f11f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/index.js\":\"c2a52873ad75437f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3faae893a378c8ca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9e06b07921d5426d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/contextMenuItem.js\":\"d55b88e502e52248\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/index.js\":\"30f251f8cc823d32\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/moveAction.js\":\"866489dc42abadcf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/moveBlocks.js\":\"a257bd0763c31eb5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/selectionAfterMove.js\":\"2d735353ee7e339a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/TutorialBanner.js\":\"af7d753ab91704a8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/action.js\":\"c88771687c57c751\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/bannerDismissal.js\":\"ebb25199e921ce05\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/documents/cheatSheet.js\":\"fedcdc10a60ff886\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/index.js\":\"76f53bbfc60230e3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/keys.js\":\"c513b9087f77dcd4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/landing.js\":\"85c80e6d299fb83e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/outline.js\":\"8a32755d300f2e9d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/seed.js\":\"95bd5a3b52342346\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8ecd47160d112670\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/analyze.js\":\"6a2919c95185027a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/diagnosticsSource.js\":\"c33710fbf1732acb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/index.js\":\"8a31e8aa71261298\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/load.js\":\"29d35094cdf2dc4c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/monitorRun.js\":\"25b41e0a7b55654e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/schedule.js\":\"af97b3c12bdb4a51\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/series.js\":\"2166724cdf092034\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/store.js\":\"5f6a23e27b0b3607\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/trendAction.js\":\"91caec5c22bd5bb6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/verdict.js\":\"121aac3295934bb3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/clickToEditAction.js\":\"2b70c9011fef12a8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/index.js\":\"93f729929d89c5b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/interactions.js\":\"1b6c41dcf87d2f13\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5628f53a7f9d0e06\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/MigrationGate.js\":\"80c49754e957c72b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/MigrationGateDialog.js\":\"bde9ffa1297ea5d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/action.js\":\"10941f30549af9f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/index.js\":\"62816da5abef47fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/localRunMessage.js\":\"c515383cb373d8b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/plugin.js\":\"353576789468f15b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/progressReport.js\":\"ff03b872bddb4421\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/sweepProgress.js\":\"d0ea65ef095274d3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/FieldRowRenderer.js\":\"1ad9dd430c31c5b5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/ValueRowRenderer.js\":\"5bc8873bf1b97761\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/actions.js\":\"c877064f80778d8e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/autocomplete.js\":\"fe9929b7f90e0242\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/fieldRow.js\":\"a6ba3f749218d6b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/index.js\":\"6ea4d539305676fd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/referenceWarning.js\":\"3824a19db3754de5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/valueAutocomplete.js\":\"32794445dfb13368\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/valueSchema.js\":\"abc7d0248317d740\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/HeaderItem.js\":\"48190eb1e0196c79\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/QuickFind.js\":\"d5ef9db2bab78b09\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/index.js\":\"4ffc9e5c0da87f98\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/recents.js\":\"a99629158c455014\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/resultItems.js\":\"a8f07791789b7f3f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/selection.js\":\"b168778819e8f338\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/toggleStore.js\":\"35593fbdc1caab4f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/HeaderItem.js\":\"5262466066d11fe3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e78b47a308453b18\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/grouping.js\":\"b5632a10e5e000d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/index.js\":\"dce015b381f03d3c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/target.js\":\"7f8ec7c37387762a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/codeMirrorExtensions.js\":\"092848c4075df392\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/contentPrefill.js\":\"e672cfb167f3a086\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/dataExtension.js\":\"4dccb997817f417e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/index.js\":\"9a3a413ce1521839\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7e85f181dfb3372f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/invalidation.js\":\"89e63eda0c6ba2fb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/localSchema.js\":\"223979c92ae5b859\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/blockrefs/index.js\":\"ce7a61cb78b343cf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"19ff9a2baba5a7d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/index.js\":\"8900eceb01813420\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/referenceNode.js\":\"28e8438ad3dec107\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fe7ecc23ad2a6f59\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"747cb2114f14f908\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/index.js\":\"684d7cfbab3f3bb6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b8faec13aa350f99\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"69a291cc485e5da5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/mergeRetargetProcessor.js\":\"c00719a9826b42cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/parseFence.js\":\"1cd431aa5d27a9a3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referenceParser.js\":\"9f70c646201b1d0b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referenceProjection.js\":\"e5ab47a80d2910d8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referencesProcessor.js\":\"5b979149b31657e5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/renameProcessor.js\":\"970a0768af3f48c6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/spanReplacement.js\":\"83e5132f5df9c1d3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/htmlToOutline.js\":\"1c8c1dfd2f4a0737\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/index.js\":\"e6033ae294a8d0f7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3c18ab47293808d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/pasteDecision.js\":\"ea2f278dc8358a75\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/action.js\":\"7fcfc2bbc459bd6f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/blockIds.js\":\"431de56c27f6eac6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/content.js\":\"dfb2dbcca1e61246\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/effect.js\":\"f65890ed58d94c08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/ids.js\":\"ee2baa7519f233cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/import.js\":\"ecd1e31cc116ddb2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/index.js\":\"25f59571ec75af11\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/plan.js\":\"aeba1ff90d770625\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/plugin.js\":\"52a485ffd56433ce\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/promotion.js\":\"f1e5d64485377a10\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/properties.js\":\"a9aaf1b1df7f2ba4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/references.js\":\"c15a8f44dd1cd63a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/report.js\":\"79cda4fa47c32995\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/roamMemo.js\":\"823610334d0e4857\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/runtime.js\":\"65aa97e1fb86383d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/schemaReconciliation.js\":\"13bb34c6c80032f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/srsMarkers.js\":\"2d697ec88d33da60\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/todo.js\":\"928b0af035d4d9b0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/typeCandidates.js\":\"d7fa8c8e10c95bf6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/types.js\":\"7775cab92d9a497e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/search-health/index.js\":\"0821b4021738f799\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/search-health/store.js\":\"2fb17a15eeab6795\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/HeaderItem.js\":\"c643015eebc9aeb9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f326fc6b0dcca0fb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/index.js\":\"97e15e82d774740b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/model.js\":\"2b78d2d97fe16803\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/toggleStore.js\":\"6f4ae7409d6c4622\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/useKeyInspector.js\":\"017d891fa1215392\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"847d14bff2b0cc37\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/ShellDecorator.js\":\"918a3622a46ad22a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/actions.js\":\"08f817125dabe884\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/exclusionsFacet.js\":\"59557e653f707fc2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/index.js\":\"005e356b94ee05b7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/shell.js\":\"71c919f3f2f4fd04\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/surface.js\":\"e7bb9611b755d81a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/walker.js\":\"a3ef988195ebb4e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c210f28ff5f3fac2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/dataExtension.js\":\"4fc1b3d0e6f1271b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/index.js\":\"f3fc740560b173df\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/indicator.js\":\"20d0a5a4bc2551dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/moveSrsState.js\":\"0bb2519f9ab612c7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"93dd8ee687b24125\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/scheduler.js\":\"d7bc0e766744d0b5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/schema.js\":\"f34fd50d18107782\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e99c44885f7a5a90\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/srsClipboard.js\":\"abcd03011bf654c2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f120871f5d144064\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fdaaf9b627968f18\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/DeckPicker.js\":\"e67b12a0f688f848\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewControls.js\":\"904c4c42b2a7c819\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cf70088de23050c9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewSession.js\":\"678e5a2aa0773dbb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/actions.js\":\"83f2d602d9977f8d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/archive.js\":\"c7fb34003b03ec2a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/dataExtension.js\":\"6cb0d5ba3b0003ac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/deck.js\":\"f2da5ee38532bd4d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/dueQuery.js\":\"d59ecdcbd0f5e17f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/gradeDecision.js\":\"befe5b201612b835\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/index.js\":\"92b5201528e9fdb6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/keyHints.js\":\"0f0094e224b6bcb0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/reviewCardLayout.js\":\"3ef586c4beaca4d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/reviewProgress.js\":\"644d5ee7dad6d2f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/schema.js\":\"98b767579a0f622c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/useDueCards.js\":\"e94fd09a2635d97f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/startup-metrics/index.js\":\"187c4a9034ce6f2c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/startup-metrics/record.js\":\"3ac4cf7e546d1ee2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/index.js\":\"c9127dede263c48c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/persistenceStatus.js\":\"10c5ae727bf6ba83\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/requestAction.js\":\"f20efad4b2e66cca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/TypeChipsDecorator.js\":\"7e8ed9f1366e4a1f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/codeMirrorExtensions.js\":\"0e512b44e07653d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/index.js\":\"633405ef528cf18d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/typeAutocomplete.js\":\"b9c58da64dd9eda9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"428b62aae846eb8b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/actions.js\":\"05b70da4bf33132d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/anchor.js\":\"3f19b92361cd621b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/events.js\":\"5dfc4d7e0293b818\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/gestureActions.js\":\"b6b68762404e33f8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/index.js\":\"53b4fb3bab040e3b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"afe0961770636aa2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/collect.js\":\"06c16836d9ab325c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/index.js\":\"a1c6d1e3c9a7f6ab\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/record.js\":\"859a9eba6fc8c481\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/RejectionDialog.js\":\"1a4a977995eb480d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/SystemStatusHeaderItem.js\":\"aad5b94a6769c601\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/index.js\":\"bc3457690e0d87ee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/model.js\":\"af9b0a6a2bf4393e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/queueCounts.js\":\"94d31b1af7c7fcb8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/rejectedHelpers.js\":\"6b88d34ba8ce72ad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/rematerializeAction.js\":\"f501cb5735f7909b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/useHysteresis.js\":\"8d6aeb7448b992eb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/ColumnHeaders.js\":\"eebe526db262ec8e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/QueryUi.js\":\"ea5d933da7ae6930\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/TableLayout.js\":\"457c2f3f934d6a6a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/actions.js\":\"12f8cca9f0582a2d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/cellEdits.js\":\"a156f426ebba7a90\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/childrenViews.js\":\"b222ac0f7cc49f7d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/columns.js\":\"0bad60dbdf2958d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/controller.js\":\"df1ca05e70dca71d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/convert.js\":\"3d6115b7d59fbcca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/dataExtension.js\":\"a02e5be86bf7acd1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/index.js\":\"f7ff988dfc92ee27\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/keys.js\":\"f9186f2579a48774\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/model.js\":\"8574810a0c0aef2d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/backfill.js\":\"b00b948fbacf81f2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/completion.js\":\"7989f7783679c772\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/format.js\":\"68d7f89aa9fe3a91\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/parse.js\":\"6e72ee8db20eda9f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/queryValue.js\":\"ccae067cc4e799a8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/source.js\":\"34c73d39ae9f9a18\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/registry.js\":\"72d8728a4c3e356a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/rowGutter.js\":\"0051e9c17bab30e2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/rowVerbs.js\":\"46f8a27ae7271261\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/schema.js\":\"2110da039a49b642\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/sort.js\":\"188e3c4e37106abc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/effect.js\":\"50f25f2d30513f02\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/index.js\":\"6938b7029f363414\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/theme.js\":\"9133857315a5935c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/actions.js\":\"f57ba7b2c2489808\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/dataExtension.js\":\"abbed122869dde70\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/index.js\":\"1146ee0403f83ebe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/schema.js\":\"d2ddb6b46c5124cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4d34f0e18cf45a0f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/actions.js\":\"d1d8122f175b0607\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/defaultItems.js\":\"0f072cd802404009\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/facet.js\":\"98642ededa5c7ddb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/holdRecognizer.js\":\"de44975dd8759ac7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/index.js\":\"65637d7418c1c576\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/UpdateIndicator.js\":\"e3322313b5991cd8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/index.js\":\"59a3f98eb9f3b214\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/loadTimes.js\":\"2f7da20df335dd11\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoNotesRenderer.js\":\"75b3440426b38875\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoPlayerRenderer.js\":\"6be0905e312627cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoTimeStamp.js\":\"2ce119e591ae50bd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/actions.js\":\"1be57c7d02513e7e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/index.js\":\"e38d7d5aa84cd794\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/markdown.js\":\"e9cdf57a0150ae64\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/notes.js\":\"a12bbf6b9910560c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/registry.js\":\"f180759e58667d57\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/remark-timestamps.js\":\"6d7c7c9c94bc63fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/view.js\":\"269591363f7bed8e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/LinkHints.js\":\"2d96eb5e27c4e694\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/index.js\":\"9016c78d57e419ae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/model.js\":\"f6b421f5cac283ed\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/settings.js\":\"43793d40fdcfcfc0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/actions.js\":\"c40797a66caf6985\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/index.js\":\"e389db94af742fd0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/interactions.js\":\"04d8b32dde9ee788\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/workspace-header/index.js\":\"74586d7b98e46606\",\"/knowledge-medium/pr-preview/pr-1868/src/registerServiceWorker.js\":\"7aa726f7509e6860\",\"/knowledge-medium/pr-preview/pr-1868/src/requestPersistentStorage.js\":\"51094171a560c202\",\"/knowledge-medium/pr-preview/pr-1868/src/services/authRequestDeadline.js\":\"42145bafeaa72970\",\"/knowledge-medium/pr-preview/pr-1868/src/services/authStorage.js\":\"c2b5f74275fa9edc\",\"/knowledge-medium/pr-preview/pr-1868/src/services/powersync.js\":\"00606aa09a681cb4\",\"/knowledge-medium/pr-preview/pr-1868/src/services/supabase.js\":\"7c7757a0b95b1b4d\",\"/knowledge-medium/pr-preview/pr-1868/src/services/uploadErrorClassifier.js\":\"f84681e436ae0543\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/ActiveContexts.js\":\"23381d754267b6f1\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/HotkeyReconciler.js\":\"6060cb2ac0df2e16\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/WipeLocalDataDialog.js\":\"b1977b210a8ec7a3\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/actionDispatch.js\":\"623422294a5ba475\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/actionRefItems.js\":\"7e3f6b9d102dc63b\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/applyKeybindingOverrides.js\":\"371a8e1667a63c9f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/blockActions.js\":\"b86de0563ac7b0bb\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/blockMergeGesture.js\":\"99e83777086e7743\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/canonicalizeChord.js\":\"ca5764d7927ff804\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/defaultContexts.js\":\"73be4f65bcefb736\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/defaultShortcuts.js\":\"8b80b04eb01e2bb3\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/effectiveActions.js\":\"b1c239bf047cd10d\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/gestureAction.js\":\"4f281421e71b1d99\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/gestureBinding.js\":\"ccb2cffa51805aff\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/holdRegistry.js\":\"0f2ad4f1140313a8\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/keybindingConflicts.js\":\"18b73cb1291ccdb5\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/keybindingOverrides.js\":\"b5db21e7e016ae63\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/pointerAction.js\":\"80164fe0bf59d244\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/resolve.js\":\"b354404fac7191e6\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/runAction.js\":\"e1fc6d15ad3eac0f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/sequenceMatcher.js\":\"e207c6b397bae049\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/types.js\":\"bd5c360adccdac93\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/useActionContext.js\":\"0a212a577a8169f9\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/useActionDiscovery.js\":\"915870502ea1d6f6\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/utils.js\":\"cc27ea1ebdbe3b19\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/bootStore.js\":\"5e96b5d5f8f55c8c\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/previewDatabases.js\":\"daf874ebf9b96054\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/byteTransform.js\":\"d7816069792c1496\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/attachmentCleaner.js\":\"ba5dacccab091b5a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/attachmentParts.js\":\"91a5a4f69bb42bc4\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/bundleParts.js\":\"e56ab9107304bb69\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/bundleRecord.js\":\"76b3d46e54fc1c5a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/manifest.js\":\"7eef01727913803b\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/takeBundle.js\":\"225e6315c2342afb\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/verifyBundle.js\":\"2c6b5bcb90436645\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/cleaningStage.js\":\"1980d0219d7de118\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionKey.js\":\"538feda3e005ca29\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionServer.js\":\"064b0454c0585d73\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/flip.js\":\"970e6257ba7f50d7\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/flipAttempts.js\":\"5951394f9ea6c785\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/pages.js\":\"6c91bf3dad0b29df\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/preflight.js\":\"bcf21e63c0e5f656\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/reseal.js\":\"ace747406c538df8\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/runConversion.js\":\"19a43a2c3c7448c2\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/runLock.js\":\"88c8c5d8eece6bd5\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/sealing.js\":\"8cdd4e62aafdff4f\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/sealingStage.js\":\"5fbe596bd87e454d\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/stage.js\":\"73c6252298f3444a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/verifyReseal.js\":\"709dfa550f9648bc\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/aad.js\":\"7ac5b3e6bf662226\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/aead.js\":\"d903ddb2548db66e\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/base32.js\":\"89a92acbe1baabe9\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/base64url.js\":\"55d46ffa2583b7ab\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/binaryEnvelope.js\":\"df7346cc1066a3a6\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/byteAead.js\":\"c0a726dd5f2470a2\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/canary.js\":\"87a413d498df4b9a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/contentHash.js\":\"e390338da920a8b4\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/contentKey.js\":\"91f943ae2f07e7f7\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/derivedIdNamespace.js\":\"b40dc3d767ee8c9c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/envelope.js\":\"e198fa994e425a96\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/hex.js\":\"3e14cbdd192c2031\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/sha256Hex.js\":\"ec47e983081874bc\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/workspaceKey.js\":\"2bbc0b4b4a945fa3\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/conversionState.js\":\"c49374f4d0f0af68\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/createEncryptedWorkspace.js\":\"32d75740594be988\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/pastedKey.js\":\"962014cca6e11103\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"58cdad465031f2c6\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9ffa4953bb27d505\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/keyStore.js\":\"ec97c72fe242fc94\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/mintWorkspaceKey.js\":\"52c30110808851d7\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/modePin.js\":\"3242994bb78eabcf\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/openWorkspaceKeys.js\":\"b56e8de6dd5621e9\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/resolveWorkspaceEntry.js\":\"95e1286686c7871c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/resolver.js\":\"98ff5074de52feab\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/workspaceAccess.js\":\"8223f63e8e2b90be\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/transform.js\":\"c3863eb65555f5c5\",\"/knowledge-medium/pr-preview/pr-1868/src/themeBootDefaults.js\":\"9f4d7e6cb61a310c\",\"/knowledge-medium/pr-preview/pr-1868/src/types.js\":\"90548ee416cfd441\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/ClientLocalSettings.js\":\"f855b30bfd259e4c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/abortableSleep.js\":\"4ccdc03f736ef1e8\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/array.js\":\"6cfdbfab385b7851\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/backlinkAutocomplete.js\":\"326c7e992ca511da\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/blockCrumbs.js\":\"f9b774cf7c0cce89\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/blockrefAutocomplete.js\":\"cbb9967cd85dd333\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/cadencedIdleJob.js\":\"9a8fd90b382484eb\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/callbackSet.js\":\"7c85d2232fb09f77\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/clientId.js\":\"a58a645108ce1c59\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/codemirror.js\":\"4f357129881f1ec8\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/codemirrorCompletion.js\":\"2ee8cf3a346ff484\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/copy.js\":\"38f8fb772186e1c3\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dailyPage.js\":\"0cb2b0452b541df7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dbForensics.js\":\"8ef19574a53344b1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dbForensicsHooks.js\":\"eacad0d28d36ddc9\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/deleteBlockThroughUi.js\":\"e916ab5bd6d4f450\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dialogs.js\":\"a9cbb592c41a4222\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dom.js\":\"ddd9ee0815618ff8\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/downloadBlob.js\":\"9549070a36a374ab\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/drawnWalk.js\":\"939086e03a621106\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/exportSqliteDb.js\":\"717f42bc9cf048fb\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fileSystemAccess.js\":\"e243884508381f21\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/flipSlide.js\":\"ced8a0f9a81b468e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fnv1a.js\":\"eb7c9aae78edc2b4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/formatBytes.js\":\"bfbf62f4753b9588\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fuzzyRank.js\":\"c7aad1313dc11891\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/idbKeyedStore.js\":\"b34d3da4a048bf48\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/idleCallbackPolyfill.js\":\"f870310e4feeeca4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/keyboardAwareScroll.js\":\"bcecd1eff1e6834b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/keyboardViewport.js\":\"2eb7aec967a8c8d2\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/lastWorkspace.js\":\"51c1ea221f4c8084\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutColumns.js\":\"c845ae024eee31f7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutSessionDom.js\":\"50ad03e57f6c0acb\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutSessionId.js\":\"fd7fa8d3f864e08c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/linkClickGestures.js\":\"31cfd3abee8f6264\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/linkTargetAutocomplete.js\":\"2373d3ce60add0bd\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/localDbCorruption.js\":\"9730cee2fe406694\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/localDbRecovery.js\":\"40af9bab96ee331b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/markdownParser.js\":\"37b541302a178510\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/memoize.js\":\"58b57cd73306c325\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/nameFieldCommit.js\":\"50ddf25b356eb81c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/nameList.js\":\"92409604d41830d5\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/navigation.js\":\"ae90c64d769f3100\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/omnilinerNamespace.js\":\"6bf86b27e9fce174\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/opfsPageScan.js\":\"7024656621ca972e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelClearance.js\":\"1ba190587fbd2021\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelHistory.js\":\"a6eba4c4295b7fcd\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelLanes.js\":\"6068a7b1e35906cb\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelLayoutProjection.js\":\"7df0098e2b4619d9\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelScrollAnchor.js\":\"fb50a07f029eb806\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelUrlFlags.js\":\"37ea33c964f4ceef\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/platform.js\":\"7ac0a5ea0586da19\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/pluralize.js\":\"ba4864c0d6fa81a4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyCreation.js\":\"553c5461d242423c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyNavigation.js\":\"1d3e64b153877c32\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyValueContext.js\":\"7eadbc2b4348f8de\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/react.js\":\"d12066e12bc82b12\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/relativeDate.js\":\"b5e9051bd0048e53\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/relativeTime.js\":\"a7cfd849d1247fa5\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/renderScope.js\":\"1caf03e03f102d12\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/resolvedThenable.js\":\"4aa7896b63a6a8fd\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/routing.js\":\"8d222bc29d45d2ac\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/safeMode.js\":\"02969c62be9ec5ef\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/scheduleIdle.js\":\"94f158295bfa8986\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/screenWakeLock.js\":\"b20c0bf0924a1375\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/selection.js\":\"3d497f848038f24a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/softKeyboardGrab.js\":\"06f1351093157c3c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/startupTimeline.js\":\"d91373d2d885ae83\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/state.js\":\"f48091be904a5945\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/string.js\":\"970c8ea5f2ed24f2\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/surfaceZoom.js\":\"2094c56ba62518a0\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/time.js\":\"6b83a8d57af749c0\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/toast.js\":\"6d4a631d55123c39\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/toggleStore.js\":\"fca82b218d952c43\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/untilStopped.js\":\"5a253d2c639c48f4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/userActivity.js\":\"e9f93da71ccc6d4e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/viewTransition.js\":\"a295bec3fcda3ed6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/viewport.js\":\"cc2e31aa631ae84c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/webLock.js\":\"5a9103640f0d94bf\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/workspaceRecovery.js\":\"c19b8cf1ca4c87e0\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/workspaceSnapshotStore.js\":\"b6dfa006ce035e6c\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-compiler-runtime.js\":\"94a02901dd5df7a1\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-client.js\":\"1df20fc3739a24bd\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-server-edge.js\":\"be8b826a19f7e8bc\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-server.js\":\"ab99e4d102dab3af\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-static-edge.js\":\"81f4ee9bc9b2e141\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-static.js\":\"dfc156e62d144eca\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-test-utils.js\":\"ebb7068197954916\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom.js\":\"42fca9a06abf6044\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-jsx-runtime.js\":\"0861c16387a2560f\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react.js\":\"c319079be731a01e\",\"/knowledge-medium/pr-preview/pr-1868/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1868/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1868/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
