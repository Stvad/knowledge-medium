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
		buildId: "d2a72451a2a0-f3aba7a0",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/\":\"425785749c0c4bb5\",\"/knowledge-medium/pr-preview/pr-1868/index.html\":\"425785749c0c4bb5\",\"/knowledge-medium/pr-preview/pr-1868/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1868/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1868/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1868/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1868/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1868/assets/FacadeVFS-B1MpbFzA.js\":\"c9d4b2a672b40d53\",\"/knowledge-medium/pr-preview/pr-1868/assets/OPFSCoopSyncVFS-BBTzTvG2.js\":\"fbd34d856318b8bc\",\"/knowledge-medium/pr-preview/pr-1868/assets/OPFSWriteAheadVFS-50XVw2lA.js\":\"8a5796845aeabbfd\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-Dp1ApXit.js\":\"b8cfab4e914551ae\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1868/assets/wa-sqlite-async-DIHY8YLk.js\":\"6da179d18007e500\",\"/knowledge-medium/pr-preview/pr-1868/assets/worker-Bl0ZNVmu.js\":\"6d5d80ba2a3aaa26\",\"/knowledge-medium/pr-preview/pr-1868/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1868/chunks/app-DsCSZ3WM.js\":\"c22e5affd8d560f1\",\"/knowledge-medium/pr-preview/pr-1868/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1868/index.js\":\"76795d4e2048fee6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1868/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1868/assets/AccessHandlePoolVFS-eh6aOhOe.js\":\"9a51738371bdfc7c\",\"/knowledge-medium/pr-preview/pr-1868/assets/IDBBatchAtomicVFS-CuxpBoSE.js\":\"72d03a08cb64dbc9\",\"/knowledge-medium/pr-preview/pr-1868/assets/MemoryVFS-DxFe1Fo1.js\":\"d58b5999fc6b418f\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-M7xxHz78.js\":\"78b9eaff7b7378ad\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1868/assets/mc-wa-sqlite-async-qO7VJkSo.js\":\"7b62faa94ef36901\",\"/knowledge-medium/pr-preview/pr-1868/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1868/chunks/AccessHandlePoolVFS-DVghphyk.js\":\"8888647d69e05476\",\"/knowledge-medium/pr-preview/pr-1868/chunks/FacadeVFS-C0oxSJdq.js\":\"8b954eee9f5de6fe\",\"/knowledge-medium/pr-preview/pr-1868/chunks/IDBBatchAtomicVFS-DiNPDDoK.js\":\"f8ae06a40fa2d4cf\",\"/knowledge-medium/pr-preview/pr-1868/chunks/MemoryVFS-C1R2acrS.js\":\"6bd173141dec6235\",\"/knowledge-medium/pr-preview/pr-1868/chunks/OPFSCoopSyncVFS-CJALzMCZ.js\":\"6dbb5e6479455380\",\"/knowledge-medium/pr-preview/pr-1868/chunks/OPFSWriteAheadVFS-l4Pygitz.js\":\"7516e164252dbb26\",\"/knowledge-medium/pr-preview/pr-1868/chunks/Preview-D1ZLjPXR.js\":\"7fc4a1c37c24f95e\",\"/knowledge-medium/pr-preview/pr-1868/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1868/chunks/card-BSvkhWf-.js\":\"0b141df2e925830b\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1868/chunks/dist-EB_rU87w.js\":\"0bfbc1528d5af889\",\"/knowledge-medium/pr-preview/pr-1868/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1868/chunks/mc-wa-sqlite-DkSLlo8u.js\":\"506235e092371067\",\"/knowledge-medium/pr-preview/pr-1868/chunks/mc-wa-sqlite-async-DFQqKPKI.js\":\"8d5112008cdd6598\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-41-AKlJB.js\":\"f4a6cb5d6d7611b1\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-BZXpXRfK.js\":\"0afee976ad7d0e01\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-Bt4ygHt4.js\":\"1c074f1f64194b48\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-CC8STP48.js\":\"d08c44fbf4bdba85\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-DCa-Z7MA.js\":\"355cf9e0578ea23d\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-DE2GPlL2.js\":\"c932bbed813ed125\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-DmlZ0Dyy.js\":\"d50f06213078afdb\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-XPESAeTB.js\":\"1589321e1e01c456\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server-legacy.browser.production-DXGb6wPG.js\":\"a558ea5b7d972037\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server.browser.production-S3DdFJjQ.js\":\"fda9ca3bbd97da71\",\"/knowledge-medium/pr-preview/pr-1868/chunks/react-dom-server.edge.production-B7geJsh1.js\":\"82b24283e790f2a6\",\"/knowledge-medium/pr-preview/pr-1868/chunks/server.browser-hqaaUlvq.js\":\"50270f0fece6f2d0\",\"/knowledge-medium/pr-preview/pr-1868/chunks/textarea-BwjnNVrI.js\":\"7dbe3a6b744334b7\",\"/knowledge-medium/pr-preview/pr-1868/chunks/ui-BfN-vZhB.js\":\"9511539941491968\",\"/knowledge-medium/pr-preview/pr-1868/chunks/wa-sqlite-BVcp6u9J.js\":\"6ce9167e6be5d795\",\"/knowledge-medium/pr-preview/pr-1868/chunks/wa-sqlite-async-DSBBl4QG.js\":\"edda67ad6161db88\",\"/knowledge-medium/pr-preview/pr-1868/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1868/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1868/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1868/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1868/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1868/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1868/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1868/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1868/src/App.js\":\"a57f0dd038896189\",\"/knowledge-medium/pr-preview/pr-1868/src/appUpdate.js\":\"aee137fa0a0e98e0\",\"/knowledge-medium/pr-preview/pr-1868/src/appVersion.js\":\"1c7bd8e83de60743\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/initialLayout.js\":\"647e6960fd6d14f0\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/openWorkspaceData.js\":\"7d382c15d30bfcc1\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/resolveWorkspace.js\":\"7bb08446e337f6b1\",\"/knowledge-medium/pr-preview/pr-1868/src/bootstrap/workspaceBootstrap.js\":\"5901f99a33b88f6d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockComponent.js\":\"0e3dd763e12f3d29\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockCrumbs.js\":\"c45103d5bbde0bde\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockEditor.js\":\"0c0c6ee82bdd09f2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockLoadingPlaceholder.js\":\"c4095f4fdc633bb3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockProperties.js\":\"bc6da1ba0c7c1f81\",\"/knowledge-medium/pr-preview/pr-1868/src/components/BlockSearchPicker.js\":\"a45694922faf290c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ConfirmBulkDeleteDialog.js\":\"e2166c0ce6bfefc9\",\"/knowledge-medium/pr-preview/pr-1868/src/components/DividerHandle.js\":\"e8f5794dbe93c345\",\"/knowledge-medium/pr-preview/pr-1868/src/components/DraftEditor.js\":\"b95e2ec4148af67a\",\"/knowledge-medium/pr-preview/pr-1868/src/components/GutterPill.js\":\"bb17d7ed1ca107a4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/Header.js\":\"bb066af59ae335a6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/LazyBlockComponent.js\":\"c128ad4a6f8936ae\",\"/knowledge-medium/pr-preview/pr-1868/src/components/Login.js\":\"251f5bdccaa41ad6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ZoomableSurface.js\":\"ef475f43b5d1c3b2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/editModeKeepalive.js\":\"9e59429faa9c0bb3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyDisplay/PropertyDisplayScope.js\":\"dbe51ea1b2ee4575\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b9033c391524e603\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/RefPropertyEditor.js\":\"b5d34064c9f6dac3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/RefTargetTypePicker.js\":\"1d086cc0bd26cc62\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/SelectPropertyEditor.js\":\"d262e0696d36da97\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/TypesPropertyEditor.js\":\"356a5d7547f416e2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/defaults.js\":\"f140742b16dea322\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/kernelValuePresets.js\":\"fe483083fdc65cf6\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/selectablePresets.js\":\"1c125c949b5727f9\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyEditors/typesPropertyUi.js\":\"e01ab0a3f19882c9\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/AddPropertyForm.js\":\"2c041a1d8f13b7de\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/PropertyPicker.js\":\"4355e70e14b689c8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/PropertyRow.js\":\"475a3fbe385eece4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/Rows.js\":\"776f6d9deeb188d7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/actions.js\":\"42909d0a0885b3cf\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/declarationOnly.js\":\"c4f08bd9b328a535\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/layout.js\":\"89b5e4b5f71e8c3d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/model.js\":\"d2c4b82c08ae6251\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/shapeUi.js\":\"365929f57ffc59cc\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/shapes.js\":\"ba131dbd45ad540d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4bbf528dc258b926\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanel/visibility.js\":\"1b42b90c5f2d1737\",\"/knowledge-medium/pr-preview/pr-1868/src/components/propertyPanelSections.js\":\"b52cce980fa30884\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockEmbed.js\":\"7a105ec689663d72\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockLink.js\":\"78c0cffb816fe3f5\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/BlockRef.js\":\"39120cf5f55c581d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/ReferenceLink.js\":\"e3d6f5584c22c449\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/cycleGuard.js\":\"2cebd3488ec2f03c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/cycleGuardContext.js\":\"09a78612aabfdde3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/linkInteraction.js\":\"ff9283fa28b6a488\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/referenceLayout.js\":\"2bdd2bdf544fade0\",\"/knowledge-medium/pr-preview/pr-1868/src/components/references/useBlockRefAncestors.js\":\"3719431286055646\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockGutter.js\":\"1898b282b05d4c91\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockInfoDialog.js\":\"d10b02079df751e7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BlockTypeBlockRenderer.js\":\"f71b196eb288a76c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/BulletHoverCard.js\":\"83036ea7700f6d0d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/CodeMirrorContentRenderer.js\":\"d190fe759ac878dd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"445de22a3225d12d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/ColumnResizeHandles.js\":\"93e51fcd5c8732bd\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"48a2567554a6fa64\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/DefaultBlockRenderer.js\":\"79adc78e1f732af3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/LayoutRenderer.js\":\"fb716b956dbd722d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/MarkdownContentRenderer.js\":\"159a587791d94c45\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/MissingDataRenderer.js\":\"0231ac4dad984907\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/PanelRenderer.js\":\"02e3fb1ab2dc03db\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5021354ba86e61a8\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/TopLevelRenderer.js\":\"fda26ba7a1474973\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/blockGutterMode.js\":\"a6b9e5d8517377cb\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/blockTitleText.js\":\"057317f9252cd8ed\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/fieldCreationKeydown.js\":\"ae55a1be409522cc\",\"/knowledge-medium/pr-preview/pr-1868/src/components/renderer/layoutRootContext.js\":\"313ece2673ab95a2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/typeChip/TypeChip.js\":\"7d60d68a3d727478\",\"/knowledge-medium/pr-preview/pr-1868/src/components/typeChip/chipStyle.js\":\"3605075ac04e2c03\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/anchored-floating.js\":\"085fb8081adc4e52\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/button.js\":\"e08a900979c35c8c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/card.js\":\"45b6b92ca004f75b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/checkbox.js\":\"08998ef6e77e9027\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/collapsible.js\":\"6b0c4eb62988247c\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/command.js\":\"55fbf4e04f12de49\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/context-menu.js\":\"8bc3ec813e98fb95\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/dialog.js\":\"c98cd35e42b9dfb3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/dropdown-menu.js\":\"512ca8965d498084\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/floating-listbox.js\":\"c5941034df3caf16\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/index.js\":\"3dd36444b172704e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/input.js\":\"38e7ea048ef81008\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/kbd.js\":\"f98f40e61a148b3b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/label.js\":\"96fc447bf7c24bf5\",\"/knowledge-medium/pr-preview/pr-1868/src/components/ui/textarea.js\":\"78ca0f85b2edcdbf\",\"/knowledge-medium/pr-preview/pr-1868/src/components/useEditModeYieldKeepalive.js\":\"85e362b3cff82671\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/BootFallback.js\":\"f113494798e6302b\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/FocusedRowLazyMount.js\":\"a1338fe5757e2ff4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/LazyViewportMount.js\":\"ec2d0fc7ee450201\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/LocalDbCorruptionFallback.js\":\"2e46c75c9de0ade3\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/error.js\":\"b84b94dbad76cc9e\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/lazyMountRegistry.js\":\"8a45488375968ea4\",\"/knowledge-medium/pr-preview/pr-1868/src/components/util/suspense.js\":\"73f4b0218333a2a1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/CreateWorkspaceDialog.js\":\"964bf8e532f714ce\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/PendingInvitations.js\":\"ef2099249eace409\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/SyncProgress.js\":\"5ce666298f308cda\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/UnlockProgress.js\":\"40213b3a2076171d\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceKeyGate.js\":\"a97360fe613332c7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSettingsDialog.js\":\"d0236f00d5dfb563\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSwitcher.js\":\"28877a5e267d4032\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/WorkspaceSyncGate.js\":\"95d68c4f44997ba7\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/ConversionFlow.js\":\"d59f23bc29eb42b2\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/ConversionFlowHost.js\":\"4208a1d199b17b81\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/EncryptionSection.js\":\"0519af38bcbb75ab\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/attachmentPrompts.js\":\"500329d61ef9fa94\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e5834c880ef7d989\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/conversionFlowDeps.js\":\"bb7ff5017d899988\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/conversionFlowStore.js\":\"6b328102435429c1\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/flowUi.js\":\"fc031de1285a75eb\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/conversion/useConversionRun.js\":\"1d833ed703bcfff0\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/keyUi.js\":\"5225f15d15e664ef\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/useCloseOnKeyLoss.js\":\"757611fcd69f4383\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/useCloseOnServerE2ee.js\":\"fc648b7e9cac2952\",\"/knowledge-medium/pr-preview/pr-1868/src/components/workspace/workspaceUnlocked.js\":\"2c7c0ea7e376d51c\",\"/knowledge-medium/pr-preview/pr-1868/src/context/backgroundSubtree.js\":\"17635b24b34b5b7d\",\"/knowledge-medium/pr-preview/pr-1868/src/context/block.js\":\"8e081c019758b564\",\"/knowledge-medium/pr-preview/pr-1868/src/context/layoutWsContext.js\":\"c23dce1f8952965d\",\"/knowledge-medium/pr-preview/pr-1868/src/context/propertyDisplay.js\":\"49be500a2ce54ce0\",\"/knowledge-medium/pr-preview/pr-1868/src/context/repo.js\":\"075340271b932261\",\"/knowledge-medium/pr-preview/pr-1868/src/data/aliasClaim.js\":\"7c1618736872d72f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/aliasSeatNamespace.js\":\"92753245d396008e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/blockData.js\":\"430cdd0e00f2ae88\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/blockType.js\":\"2bc4a251ad04b359\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/changeScope.js\":\"e91a2e4941baa593\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/codecs.js\":\"b9b88b1333534d9b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/derivedData.js\":\"17a65358aa9fb811\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/errors.js\":\"cc996937575c96c9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/events.js\":\"6d140e12ce0f217f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/handle.js\":\"e9b635e2550fc702\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/index.js\":\"d2de9c327ce28c5d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/mutator.js\":\"17cc8dbd41552f2d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/processor.js\":\"ba68a96058f104b1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/propertySchema.js\":\"14754d4e60f03a6d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/query.js\":\"ab9cb7f94681a366\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/sameTxProcessor.js\":\"dbe5dc5dec02e2a6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/schema.js\":\"e9b635e2550fc702\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/tx.js\":\"e9b635e2550fc702\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/typedBlockQuery.js\":\"8ec35f40784eb952\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/user.js\":\"a5b6814ddee4827a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/valuePresetCore.js\":\"b6d8fac2bd5ef57e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/api/valuePresets.js\":\"c43fdb3f6c66ddbc\",\"/knowledge-medium/pr-preview/pr-1868/src/data/attachmentCleanerIOVerb.js\":\"325e31397f13ace5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/block.js\":\"cdefdbc60278e5fe\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockCache.js\":\"2d59b6ee4529c7bd\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockId.js\":\"7875afeda27af011\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockLiveness.js\":\"108fb5a0f673c91f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockMerge.js\":\"a78fe84d5f36ccd4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockSchema.js\":\"e5244bac2eb543e6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockTypeLookup.js\":\"6e6b99058df33dd1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/blockTypes.js\":\"3b38c585034791e9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/childrenView.js\":\"99849403b6da1674\",\"/knowledge-medium/pr-preview/pr-1868/src/data/clientContext.js\":\"56ef2ba85964d7e8\",\"/knowledge-medium/pr-preview/pr-1868/src/data/dbFileSiblings.js\":\"8a4de9756bb3ece8\",\"/knowledge-medium/pr-preview/pr-1868/src/data/definitionSeeds.js\":\"abd4493bd0791800\",\"/knowledge-medium/pr-preview/pr-1868/src/data/derivedIds.js\":\"a6b038b0dda3fe0b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/drawnSubtree.js\":\"1e9f7ba22309ddf7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/facetBridge.js\":\"3b2deb77d9532197\",\"/knowledge-medium/pr-preview/pr-1868/src/data/facets.js\":\"8190b07d3f685c46\",\"/knowledge-medium/pr-preview/pr-1868/src/data/globalState.js\":\"53d489e82eb15332\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/aliasClaimRederiveProcessor.js\":\"9c0a65f41d2eddb6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/ancestorBatch.js\":\"bac0ea1d76548245\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/blockTypeTypeifyProcessor.js\":\"4abfaf2800940cef\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/clientSchema.js\":\"cf5574e679a2e021\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/commitPipeline.js\":\"438421f4aead1b38\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/devAssertions.js\":\"92394eb3bceb48b0\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/firstSync.js\":\"33218ed9fbf8fb65\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/freshInitialLoad.js\":\"5816bf2d6d013f94\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/graphBackfillClaim.js\":\"e30fd996329031da\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/handleStore.js\":\"e7a80b161adc2b84\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/idleMarkerJobs.js\":\"158597cbb2288d4a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/initialDownload.js\":\"f7f8ace41b6fc1ed\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/initializeClientDatabase.js\":\"38d7fd8b21fea48e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/jsonCanonical.js\":\"52b7209c55ee7585\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelInvalidation.js\":\"d605c90ba5db439b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelProcessors.js\":\"145051c139fa205d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/kernelQueries.js\":\"daa1bfcda2de5739\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/mergeTypeMembershipProcessor.js\":\"907a4a685d7c9560\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/normalizeReferencesProcessor.js\":\"c3026a4b0ac85fbe\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/poolInstrumentation.js\":\"a84662198485bd5f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/processorRunner.js\":\"0bdb305ac239308b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyCellBackfill.js\":\"ee8f01719332ef6a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyChildMint.js\":\"39314118473203a3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyChildrenProcessor.js\":\"12a6320984d6f168\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9c204e3be9b333f0\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyDefinitionSynthesis.js\":\"7894de5a1d6b7144\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyKeyScan.js\":\"eab8b0c305b08835\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertySchemaResolution.js\":\"711599a92f389d28\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/propertyValueEdits.js\":\"1ef98e7113a856c6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/raiseProtocol.js\":\"ec18a6527b41d6a3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/readBatch.js\":\"6f42af2312ffbe20\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/refProjection.js\":\"9be77e00ea816578\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/referenceTargetLookups.js\":\"9d8de5701986abb4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/referenceTargetProcessor.js\":\"22d6799f88c42ef6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/replayMerge.js\":\"8cab35c949294ab2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/sqlBinds.js\":\"92f4dcf0b689194c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f2381f1c2448384d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/arrivalProcessors.js\":\"26ca5779769805c5\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/invalidate.js\":\"cf67f8acf260b0d6\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/materialize.js\":\"e252fc7fb1cb2266\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/observer.js\":\"05d0e4b9e0be3a4e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/syncObserver/reconcile.js\":\"7d1679c85671864d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/timingMetrics.js\":\"2687e9184f1b4365\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/treeQueries.js\":\"247e96c9f41ddcee\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/txEngine.js\":\"f374af571bddc9cf\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/txSnapshots.js\":\"5e7af1b2d0ec83a1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/typedBlockQuery.js\":\"c7dc57021662ab16\",\"/knowledge-medium/pr-preview/pr-1868/src/data/internals/undoManager.js\":\"9075f6f9d28466c7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/invalidation.js\":\"da8f3a22afa58720\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelDataExtension.js\":\"c5e31aeb329be00d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelPage.js\":\"248456dc7fa6a11b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/kernelValuePresetCores.js\":\"30bf16e7bb1fa25d\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbCorruptionSignal.js\":\"d60753319c346c2a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbStorage.js\":\"50cdcb3deb6b2a9c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localDbVfs.js\":\"047cf91543773404\",\"/knowledge-medium/pr-preview/pr-1868/src/data/localSchema.js\":\"2060a5a74bfdda09\",\"/knowledge-medium/pr-preview/pr-1868/src/data/maintenance.js\":\"acbe7dcb3992e544\",\"/knowledge-medium/pr-preview/pr-1868/src/data/mergeProperties.js\":\"4ae60e80807c5ecf\",\"/knowledge-medium/pr-preview/pr-1868/src/data/metricsConsoleHook.js\":\"e165c38ad743d5f1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/migrationsPage.js\":\"fc96d90b80110d5f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/mutators.js\":\"a854db1267494ac1\",\"/knowledge-medium/pr-preview/pr-1868/src/data/orderKey.js\":\"eea3947e4c6de092\",\"/knowledge-medium/pr-preview/pr-1868/src/data/orderKeyPlacement.js\":\"a5bd72995ed69792\",\"/knowledge-medium/pr-preview/pr-1868/src/data/outlineSurface.js\":\"5dfdf3d0288b5990\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pendingEditorContent.js\":\"bcaca0ed7429ce05\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pendingUploadsSql.js\":\"2eaa13e847381dcb\",\"/knowledge-medium/pr-preview/pr-1868/src/data/pluginStateExtensions.js\":\"87b4e7d3e43b40c3\",\"/knowledge-medium/pr-preview/pr-1868/src/data/powerSyncLogger.js\":\"b04adb076a4e81d9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/projectorRuntime.js\":\"028ac767592a9434\",\"/knowledge-medium/pr-preview/pr-1868/src/data/properties.js\":\"1438a0d984b0406b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertiesPage.js\":\"f240c65032582088\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyChildren.js\":\"82d2c5740a7dfa28\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionFanout.js\":\"b6e3f7ef9f46771a\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionMetadata.js\":\"ede01a42e9c16bb8\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDefinitionRegistry.js\":\"d0f7583d14475d14\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyDisplayMode.js\":\"f07f1f0c486dac39\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertyRowCreation.js\":\"0d88920e4ef80053\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertySchemaCreation.js\":\"36f429c44fa26ae2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/propertySeeds.js\":\"657e5d106048b0c2\",\"/knowledge-medium/pr-preview/pr-1868/src/data/recentsPage.js\":\"602d2e8a4a14b672\",\"/knowledge-medium/pr-preview/pr-1868/src/data/referenceBlock.js\":\"f37511e5a2d9db15\",\"/knowledge-medium/pr-preview/pr-1868/src/data/rejectedUploads.js\":\"9691fcf6659565d9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/releasePowerSyncConnection.js\":\"2812c6d87e2d80ed\",\"/knowledge-medium/pr-preview/pr-1868/src/data/repo.js\":\"5c179824f99b1382\",\"/knowledge-medium/pr-preview/pr-1868/src/data/repoProvider.js\":\"4f11994b35660b3e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/rowProperty.js\":\"0de7a08e47ca7e95\",\"/knowledge-medium/pr-preview/pr-1868/src/data/searchFilter.js\":\"a1a9b3ccef002faa\",\"/knowledge-medium/pr-preview/pr-1868/src/data/seedIdentityLedger.js\":\"7c2e7c64e3b92502\",\"/knowledge-medium/pr-preview/pr-1868/src/data/stateBlocks.js\":\"316d6172b938d98e\",\"/knowledge-medium/pr-preview/pr-1868/src/data/structuralEditPolicy.js\":\"4014fcbdb5645999\",\"/knowledge-medium/pr-preview/pr-1868/src/data/subtreeDelete.js\":\"7a347ce883db8423\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncStreamLock.js\":\"ff278fb3de8153b7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncedTableSqlRecognizer.js\":\"b4aae5285e86aa9f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/syncedTableWriteGuard.js\":\"348b893cc7c012d7\",\"/knowledge-medium/pr-preview/pr-1868/src/data/targets.js\":\"4bd68bc6397f3b11\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeColors.js\":\"ccdad70032f9d5ef\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeDefinitionMetadata.js\":\"061222e53eaaefd8\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeDefinitionRegistry.js\":\"bfb20c6c2742055f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeExtraction.js\":\"95c656d8e925057b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeInitialValues.js\":\"b04e08d986dfce0f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typePropertyGroups.js\":\"22b4c4d786433d58\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeSeeds.js\":\"88812fb2ccf72615\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typeTagger.js\":\"8dabfee56127490b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typedRecords.js\":\"b98d578f759f1a53\",\"/knowledge-medium/pr-preview/pr-1868/src/data/typesPage.js\":\"92d2256c2aea186c\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userPrefs.js\":\"618420a35359b51f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userSchemasService.js\":\"17db5779102aa954\",\"/knowledge-medium/pr-preview/pr-1868/src/data/userTypesService.js\":\"4ede002841c9870f\",\"/knowledge-medium/pr-preview/pr-1868/src/data/valuePresetRegistry.js\":\"1d02f5f216b8aa69\",\"/knowledge-medium/pr-preview/pr-1868/src/data/visibleChildren.js\":\"41022a23d0385576\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceConversion.js\":\"d0376c6f8e756e39\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceFirstSync.js\":\"4f09b01852969216\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceIdNamespace.js\":\"a269e7f9db4e860b\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaceSchema.js\":\"48790db3d5c5a7c9\",\"/knowledge-medium/pr-preview/pr-1868/src/data/workspaces.js\":\"aff0de873a6e5dd4\",\"/knowledge-medium/pr-preview/pr-1868/src/data/writeAheadLog.js\":\"d5035ecea262be20\",\"/knowledge-medium/pr-preview/pr-1868/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/BlockPasteShellDecorator.js\":\"ec9708c535ca9afa\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/atTrigger.js\":\"8462af1ed904f882\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/autocomplete.js\":\"5faffeb11edef136\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/codeMirrorExtensions.js\":\"c6288049e8750731\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/contentFlush.js\":\"13ad113b369b684a\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/defaultInteractions.js\":\"0fb85f30cb2c21bb\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/editSettleSignal.js\":\"c31974de7914d714\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/insertImage.js\":\"4e2be17899b9eaa1\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/referenceCompletionRange.js\":\"59f129e824e1d1e5\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/referenceTargetTypes.js\":\"77d6533babf179e0\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/syntaxContext.js\":\"2d0c3e4f7ff1ac44\",\"/knowledge-medium/pr-preview/pr-1868/src/editor/triggerMatch.js\":\"717b0da3d633d56c\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/AppRuntimeProvider.js\":\"75db7e08620d747e\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/BlockFocusShellDecorator.js\":\"c07879aa9f48968f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/ExtensionRenderBoundary.js\":\"c99f3a133874d9b1\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/PanelContentRecovery.js\":\"8631a8bc1dd6557f\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/apiCatalog.js\":\"ffa787f8e10a3d0e\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/approveExtensionHere.js\":\"122f02be181e29b7\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/armedCutAppMount.js\":\"d8e426fa32050691\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/batchableKeyedStore.js\":\"e63928b9b088c44a\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/blockInteraction.js\":\"e581234f4cc52520\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/blockSelectionAction.js\":\"013a47b9ad50f929\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/compileExtensionModule.js\":\"547243e60072e3ed\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/compiledModuleCache.js\":\"f273c6fb5af39524\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/continuousGestures.js\":\"3f33cf877b2b9bcc\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/core.js\":\"2b483f4896c1300d\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/defaultRenderers.js\":\"6c59bc00843dae6a\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/definitionFanoutAppMount.js\":\"443d666f2a0a2cd8\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dialogAppMount.js\":\"edf85d9373402118\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dynamicExtensionSeeds.js\":\"81b23eb382c17989\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/dynamicExtensions.js\":\"1bde96d6c6a32094\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/exampleExtensions.js\":\"2c0e1a3df1815c87\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionApprovalStatus.js\":\"a34d40c2459024c5\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLoadErrorToast.js\":\"bf3eeb13cff5eef5\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLoadErrors.js\":\"ae9c78b331f0ec7d\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionLookup.js\":\"6664393b3b6ac3d2\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionToggles.js\":\"13392d9e95c14ec6\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/extensionUtilitiesCss.js\":\"a780707cf9f5f3b3\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/kernelPageDeletionGuard.js\":\"167ab8ee3e890250\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/liveRuntime.js\":\"317f5fbd5b141f03\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/openExtensionsSettings.js\":\"dfe1bd374c405991\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/overridesCache.js\":\"d92b2161d0d01e59\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/pluginIds.js\":\"3e51f7ba63a50c9e\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/processorRejectionToast.js\":\"715113a03184ba26\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/runtimeActions.js\":\"9b42749e773ae7c0\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/runtimeContext.js\":\"917928cb35ca4e37\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/staticAppExtensions.js\":\"ac107c956f57f16d\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/staticDataExtensions.js\":\"0742d9dd8f99d5e9\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/toastAppMount.js\":\"aa2d6976b5b74f12\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/useOverrides.js\":\"b75150d1f53ee5bc\",\"/knowledge-medium/pr-preview/pr-1868/src/extensions/useShortcutSurfaceActivations.js\":\"3e05ad422b19eb46\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/discoverToggleTree.js\":\"119031fecf1c4041\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/facet.js\":\"d033487fd3c70ce9\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/resolveAppRuntime.js\":\"8fc5278861b1e11d\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/runtimeEvents.js\":\"dfe8b42474b25f6f\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/togglable.js\":\"6d4affafbe0d8ae1\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/variantFacet.js\":\"e2e4517888c5d06d\",\"/knowledge-medium/pr-preview/pr-1868/src/facets/verbFacet.js\":\"089c8ce3c89a9911\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/block.js\":\"473f49f36e967dd2\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/focusedChild.js\":\"1c4562ee904927d4\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/propertySchemas.js\":\"b9cc23a4b1449c02\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/typeRegistry.js\":\"5ee8d376c3b89cdd\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useAncestorCrumbs.js\":\"a718e3eb8bc562fd\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useAutocompleteListbox.js\":\"fae0406927c9467c\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useDebouncedSearch.js\":\"97f5b6b5e073dc61\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useDebouncedValue.js\":\"b76e78cbc34a5e94\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useIsFocalRender.js\":\"746b21fb6592b8a5\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useIsReadOnly.js\":\"d9ca65e099625f31\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useMaterializeBacklog.js\":\"2e039b92dc59d444\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useMinuteClock.js\":\"dd63b2b107ccd12e\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/usePanelLayoutProjection.js\":\"40054bcb2b7f6c62\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/usePendingInvitations.js\":\"9e6d844237f3d466\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useRendererRegistry.js\":\"9aba51be8804cb86\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useRetainedFieldRows.js\":\"41fbe4e8af4fdc26\",\"/knowledge-medium/pr-preview/pr-1868/src/hooks/useWorkspaces.js\":\"1e5e1e9948d1c72a\",\"/knowledge-medium/pr-preview/pr-1868/src/lib/utils.js\":\"f8be303641dd890d\",\"/knowledge-medium/pr-preview/pr-1868/src/main.js\":\"d2d60761043d84e9\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/MarkdownImage.js\":\"0da473e24261640f\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/blockSeparators.js\":\"03e51315307a37db\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/context.js\":\"46151dc889daa810\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/defaultMarkdownExtension.js\":\"9cb9189380d91114\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/extensions.js\":\"2eae594f4af6fedd\",\"/knowledge-medium/pr-preview/pr-1868/src/markdown/renderMarkdownHtml.js\":\"d27dff5363fc17d0\",\"/knowledge-medium/pr-preview/pr-1868/src/minimal-editor.js\":\"f9bf987d9ffa2b8e\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/armedCut.js\":\"9fe64443d7358988\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/captureMediaVerb.js\":\"6e2ac4ef285750d8\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/clipboard.js\":\"d8fd2665f89762d6\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/decision.js\":\"e5f91ff0c93f1491\",\"/knowledge-medium/pr-preview/pr-1868/src/paste/operations.js\":\"1407c06890af9d88\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/account-header/AccountHeaderItem.js\":\"936a1aa1557e061f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/account-header/index.js\":\"1d20e6edbcf40c08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f814f14356a93c7e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/askAgent.js\":\"2509aedb4b16ba30\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/askedStore.js\":\"c992aff22440bf08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6863a1925fca2b4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/chipState.js\":\"cb346de134b1cd8b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5ccde98d3c2be512\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/index.js\":\"38399eda88778c97\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d04f07012a3dc16e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-dispatch-companion/schema.js\":\"f25c18cfad928b91\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7a3bd586e684ca47\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2b5aafe0d14e51d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/addMedia.js\":\"ed9c8fcdb58e3be7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/backlinks.js\":\"fe1ffa15b5344243\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/block.js\":\"636fbbd7a05cfe57\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/context.js\":\"5db537fa9b50bae2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a71764a53f7bbc7b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/index.js\":\"17007e6181bf93f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/outline.js\":\"81faed940eacb320\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/properties.js\":\"a5bfd457f299f892\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/refs.js\":\"088f605ba91b2caf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ea7379fdfadee756\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/search.js\":\"be00231c27620e12\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/shared.js\":\"de8f25078c01f48a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d7c410e9b272f7d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentViews/text.js\":\"e55ba0a2e0074469\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/agentWrites.js\":\"de1cebadfd913ae6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/authoringCatalog.js\":\"473cf574a5b38b54\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/blockRefTargets.js\":\"2318c8e656429f89\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/bridge.js\":\"dcfb38dcf396c9cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/bridgeLoop.js\":\"3714773cdd0d55f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/changeHistory.js\":\"ee5d9f1049d132f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/commands.js\":\"28bec816ceee4d41\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/commentsCommands.js\":\"cf402ebe96f9db7b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/dataExtension.js\":\"f8297cc94ec8e6b6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/dataModelGuide.js\":\"755eb4eae0f2cfad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/describeRuntime.js\":\"81b281fce5132052\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/extensionLint.js\":\"db3908148cf24160\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/grainAudit.js\":\"fd8c4707b193cdea\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/healthCommand.js\":\"48022e0e92f43b9e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/index.js\":\"615b0ae2e57487d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/presetIdentity.js\":\"36807337d5687b17\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ca799cc3bf153475\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/readMedia.js\":\"2aa88c2e82f244d2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/schema.js\":\"cdc1a0f5a46c3a77\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/serialization.js\":\"a795f3f50420f602\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/targets.js\":\"8ad33e668f8278c1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/tokens.js\":\"0f42c322496dd4f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/watchEvents.js\":\"c8045e1639574747\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/workspaceGuard.js\":\"cb139cb19a3c12fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/agent-runtime/writeCommands.js\":\"7e8d58b4e0e65ed5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/AliasCollisionToast.js\":\"4f424d6a9349d693\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/DuplicateNameBanner.js\":\"b70e3bbf9146835e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/collisionMerge.js\":\"2346bf76d3a346b4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/dataExtension.js\":\"25fddd87ae8dcbcb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/index.js\":\"2056632bd6bf4d40\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/mergeCollisionAction.js\":\"1f374f0f12841431\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/pageStyling.js\":\"8e7e553fd74c33f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/rejectionToast.js\":\"383f809bca27f450\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/alias/syncProcessor.js\":\"1571397de29ce033\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/actions.js\":\"3d17a9b0ea1920d6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/addComment.js\":\"3e61fd97e02e48af\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/anchor.js\":\"6b8a4ff1002d302f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/anchorState.js\":\"658c63b797722d20\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/commentLinks.js\":\"6d822a230904a62c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/confirmThreadDeletion.js\":\"0e9e0f263c657423\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/container.js\":\"0a3068874a408a1c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/dataExtension.js\":\"8dc3c97f9bb3bac6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/deleteComment.js\":\"b7f818eceb182ae6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/highlights.js\":\"e278897b4d9eb457\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/index.js\":\"9decaacf0929e91d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/linkedCommentsPill.js\":\"99da5a8ef5621084\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/margin.js\":\"32d42537687f9dce\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/marginSchema.js\":\"877189ebc84fb5a3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/newComment.js\":\"ed20140f1b8ee042\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/ownThreadPicker.js\":\"cf70da9a8d94cb32\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/placement.js\":\"7ab2a507b61f4cbf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/queries.js\":\"ae354d92412666fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotePosition.js\":\"b7bf2ab9e8243c09\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotedIn.js\":\"8e4c2027a655fcea\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/quotedRange.js\":\"052d8a82a6a26205\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/rangeRefs.js\":\"fb8ddb2405ba3765\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readHighlights.js\":\"2283f6fba8040b6c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readSelection.js\":\"a5f19655dc484b82\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/readSelectionUi.js\":\"3232ecf56a282450\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/reanchor.js\":\"12219451257104b4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/schema.js\":\"8fdd71e1f2317994\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/scope.js\":\"dbdd3d63037065d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/scopeThreads.js\":\"7f0ae6c54aee78ae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/splitRetarget.js\":\"1eb0db14a044e4db\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/suggestionCard.js\":\"6c4065ebfb0a0edf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/suggestions.js\":\"cc723b3c5bf92371\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/summaries.js\":\"4d9624f94a1c4a2c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/summaryBatch.js\":\"7aa93a0e90e83078\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/surface.js\":\"6365958091aa4e6a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/threadNavigation.js\":\"f7adb9c7b98736a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/threads.js\":\"4f6e3f3557e7978e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/ui.js\":\"c86b2f1a0a75309f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/annotations/uiStore.js\":\"418a93b8539f9a3c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-intents/appIntents.js\":\"29434c34c32899d6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-intents/index.js\":\"51fbd97ed442f057\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-update-prompt/index.js\":\"0a419a12b1e65a38\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/app-update-prompt/status.js\":\"bdd89fb41a14c675\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3f9eb4cbe47c20c8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaBlockRenderer.js\":\"8bf6265e3beebe43\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d865689f37993b29\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/MediaUploadReconciler.js\":\"7048fe6cd410ec1a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetDownLane.js\":\"14996122138f5d4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetResolver.js\":\"b99106e668def28d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/assetUpload.js\":\"430fba451f9b0dd1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/attachmentCleanerIO.js\":\"16a7b3896b531d86\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ca43a1613557c142\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/blobStore.js\":\"7d4d48842f6ba399\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/browserMedia.js\":\"d95ffd2b87620530\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/byteStore.js\":\"0ebc12efdd352846\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/cleanerIO.js\":\"4ab2217a92713001\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/cleanupAttachments.js\":\"9b98cb9fa07c66e7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/dataExtension.js\":\"f0bd28886e477917\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/downLane.js\":\"b55fcfb090e5a475\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/index.js\":\"e1194d8cbc4ba56d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/insertImageContribution.js\":\"eb5cf7194b693f13\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/laneArming.js\":\"3e85ea6976c13980\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/laneLock.js\":\"c666205a98399a08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaBlock.js\":\"db9a5a898e05836b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaCapture.js\":\"c072ae9f6c9417ff\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaLanes.js\":\"69cb32dc2581b1d3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaViewers.js\":\"dfd0ff9c1b84fabd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/mediaViewersFacet.js\":\"309a578bf4380425\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/pasteCapture.js\":\"3bbfe950f18ce121\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/resolver.js\":\"128d67a02e8c9690\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/retryUploadsAction.js\":\"900f5e9ad2be098b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/storagePaths.js\":\"da7b7cba6cbdf5d3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadDrain.js\":\"20c97f02937805b5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadLaneStatus.js\":\"3cc85964dd8b5a21\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadReconcile.js\":\"ab6e44d669d37e2a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadRecovery.js\":\"3e903ab2ea41f9cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/uploadStore.js\":\"06de7313266755f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/attachments/useAssetObjectUrl.js\":\"92a6bf5b4e732baa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"472ee6aa1f650dc8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d8809ac480fc273b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/facet.js\":\"f5c875ea373daed3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/index.js\":\"05b013d5a7446aaf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks-view/prop.js\":\"85d26b053cfafe33\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BacklinkFilters.js\":\"c453db85b250d1d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4dd21f5e78ffd086\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/BlockEntry.js\":\"d27dc8d8c27e563c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/LinkedReferences.js\":\"839caabb72343c56\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c8efaae86a328e97\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/dailyNoteDefaults.js\":\"c18e5f46b9f0a638\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/dataExtension.js\":\"6513a622ae46c377\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/edgeExclusions.js\":\"da2c85293f78989d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/filterProperty.js\":\"2d57ffaf21b0ddf2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/index.js\":\"b438f2149e19eddb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cc37c5e34a03682b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/applies.js\":\"714bcd351b9e5ee5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/countQuery.js\":\"3c5ea6c3fcfd04a5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f604012ca3626980\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/index.js\":\"b47adffc1e32b579\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5d986fca33c6c318\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/presentationInvalidation.js\":\"45be9b1e43772204\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/propertyEditorOverride.js\":\"3e36198a73696623\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/propertyFilter.js\":\"cdbd15e45e5a097f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/query.js\":\"0c68c0c083c738c1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/resolveFilter.js\":\"aad38dabd790a016\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/sourceBatch.js\":\"96880c3e44ae0743\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/sources.js\":\"9fc37698806df7a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/useBacklinks.js\":\"657f9255ddd519ee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"223a09d117e7091a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/BirthdayCelebration.js\":\"24df87caf29acb83\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/BirthdayOverlay.js\":\"48263d58679d4be9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/gate.js\":\"8e24da85d1304d5d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/index.js\":\"43de6a1fec22302c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/birthday/wolfTheme.js\":\"1a250f82bd4b5471\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/BlockDragLayer.js\":\"e1502a75d1a8ccca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/dragController.js\":\"c686d90685a76923\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/dropTarget.js\":\"50ae5327ab9e6ab6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/index.js\":\"5341cbc5b05a0230\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-drag/projection.js\":\"2a17bd3d2ca62f22\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-info/BlockMetaCard.js\":\"4e00eda2097e86f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-info/index.js\":\"82b457be953aba5c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/AddTagDialog.js\":\"7cefb9cdf72fd77d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"714acdd587222bcd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/TagNameIssueHint.js\":\"04c997804ef565fa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/addTagAction.js\":\"3877e8ef9da90c5a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/appendTag.js\":\"0e3b98091b18848b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/config.js\":\"97999b49155f028e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/dataExtension.js\":\"597cfee9b2658912\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/index.js\":\"0f23c16eb9fb69a5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/block-tagging/propertyEditorOverride.js\":\"d836c1e84aa96f31\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5e7fd5a0fd3ac3e3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b0eac4d08e212202\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/Breadcrumbs.js\":\"35579f85aac4d276\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2b700414dbbc35a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"319000e225b9edae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/index.js\":\"e75928daf6c2d4e2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"695cefe90bbe2417\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/CharacterCountItem.js\":\"d94452cee87d4916\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b3e819167b390310\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/actions.js\":\"f68a23e1dfbf3135\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/blockType.js\":\"356f3aa2e594d5f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/charCount.js\":\"9933e5eca3c669cf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/dataExtension.js\":\"6d193c6ba17bf812\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/index.js\":\"db628b583b74a6f2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/profiles.js\":\"b20e93dc48b55696\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/properties.js\":\"1292c0f45af091ad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/character-counter/textCounts.js\":\"02bfd129e9178664\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/colemak-keybindings/index.js\":\"3776d296849cd874\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/CommandPalette.js\":\"2f0f457e458f5d1e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/HeaderItem.js\":\"dd1289324c93e11c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/context.js\":\"34f89b47ebc2a56f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/index.js\":\"3390bb85407e5589\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/selection.js\":\"2559659b1282bba5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/toggleStore.js\":\"cb35f9a2bee8c1fa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/command-palette/useCommandPaletteActions.js\":\"e8c972e8723e63f0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/ContributorBadges.js\":\"7f6a86418772a0a0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/author.js\":\"1650f921811668a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/codeMirrorExtensions.js\":\"c88f9b3e51bd7a84\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/dataExtension.js\":\"d2f37dae2faeaa28\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/index.js\":\"97169cd98f3a76eb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/mentionAutocomplete.js\":\"567a080bc3388603\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/processor.js\":\"8e6aacffc0b96bca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/profiles.js\":\"791a4e7640b7bbcf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/queries.js\":\"979bcab8aeec4950\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/contributors/schema.js\":\"7044f7af56790a02\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"607220d59cc9d3c8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/followOrigin.js\":\"22dd854c0f7cec25\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/index.js\":\"7c023c27af3f4c00\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0be5a0e3237c7267\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7b0fe8386699d95e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/CalendarGrid.js\":\"4f6f917bbb2b1676\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DailyNotePicker.js\":\"fa7688321091192c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"964d800ded130d14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateNavDecorator.js\":\"c35bcf8c3440e358\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/DateScrubOverlay.js\":\"22a2c7379dffa2ca\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/HeaderItem.js\":\"43989c64f4bff211\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/ReschedulePicker.js\":\"e727f8c4d2f5a8ec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/SpreadDatesDialog.js\":\"500ffa26d9c20ab8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/actions.js\":\"7e1cc7d36c4c34ed\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/blockDateAdapter.js\":\"8f9a93d30aa09b75\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/calendar.js\":\"da34aa550d90b921\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dailyNotes.js\":\"e11468fbd8c90911\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dataExtension.js\":\"67d52197ae7f170e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubActions.js\":\"9a6f25d143dd824c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubGesture.js\":\"13e6b57a5086639e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a522898ab0f5a81d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e93471a3fb56004f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/deletionGuard.js\":\"cd37f72f09fc59c4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/dueQuery.js\":\"4bfd09e8c1dfb1ce\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/index.js\":\"c06e2c4c73893c23\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/landing.js\":\"fe9b6f9a62e8f1ef\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/localSchema.js\":\"69e34305a724768f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/referenceDateAdapter.js\":\"f6f4b7f9b9ff6d25\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/rescheduleAction.js\":\"1809655513cc261c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/schema.js\":\"d01cb07abdec439b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/spreadBlockDates.js\":\"ef4e0415b75e8589\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/spreadDatesAction.js\":\"c35ebf395473fc7b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/today.js\":\"73f3b3e323bdd780\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a0c6d11c1c04f69d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7be12b106e2bd994\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/audit.js\":\"9e65986b852e1240\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/auditAction.js\":\"ee7af05f43d7c4f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/auditRanges.js\":\"fed58a904933889e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/diagnosticsSource.js\":\"106a4e0694a443e7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/divergenceScan.js\":\"ea3bd4086fd9c4d9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/index.js\":\"193c7af56a762cf1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/propertyChildrenChecks.js\":\"91b57c6b03a86ea6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/referencesMirror.js\":\"fa696ea714a1e5f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/rowJson.js\":\"2e7547fe479158aa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/schedule.js\":\"ab678a0d9563c356\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/data-integrity/store.js\":\"55c15ca76d0155cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/action.js\":\"e350bd50dde41c6f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/index.js\":\"afbf3011815302d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-maintenance/plugin.js\":\"6f19705b6af30ee0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"12762ba30e6d29be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/actions.js\":\"055dc8987e8fee81\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/changeMarker.js\":\"bd0a4fcfcf0a119f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/diagnostics.js\":\"e521225b12643336\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/fileSystemAccess.js\":\"1229919e6b2f5ab2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/filenames.js\":\"46836b0c68618d1b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/index.js\":\"e81afcd5fbb2ffec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/mirror.js\":\"867c32ad3f533bed\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/runLock.js\":\"735ffd2602b43def\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/runtimeHealth.js\":\"cc156c28bf44a834\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/schedule.js\":\"98a2fbebd96d0aee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/db-mirror/store.js\":\"152bb7aa9f8c0cd5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/default-themes/index.js\":\"a8f657cb4f6ef55f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/default-themes/themes.js\":\"5f90e583b932d607\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/diagnostics/facet.js\":\"ba0352683b8f4e43\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/diagnostics/useDiagnostics.js\":\"2311b0b4ee987d46\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/dismissals.js\":\"203587a72aa0c4fd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/index.js\":\"7c718a39e83b58b7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/status.js\":\"bd299a4b0b2bd307\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extension-prompts/store.js\":\"d6c56e49aee59b25\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0906397995b4101e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/ExtensionsSettings.js\":\"149812487d7e0c3f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/actions.js\":\"b300639029d6699b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/config.js\":\"3961ff5c4048ed3b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/dataExtension.js\":\"b11d6c71efbe4029\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/effect.js\":\"cf99529316fb961c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/index.js\":\"7ae0d2ec5d6b9c94\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/propertyEditorOverride.js\":\"99eec572fe6488dd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extensions-settings/useToggleTree.js\":\"2fd6852161240284\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/ExtractTypeDialog.js\":\"099da1b6247d54e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"cb68eadb2be8ec07\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/PropertyShapePicker.js\":\"780449ac01471a38\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/action.js\":\"b5411429dfeb8af5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/extract-type/index.js\":\"7ae77164876c7557\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/FindReplaceDialog.js\":\"566637aa49f3f54c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/HeaderItem.js\":\"94c3162de182a9e3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/dataExtension.js\":\"fe5ffe35320ec4e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/index.js\":\"777661faf9b59f49\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/search.js\":\"8498fc16720c137f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/toggleStore.js\":\"bcd8e7461ee5a239\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/LocationPropertyEditor.js\":\"9f77ae71c86c0921\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/MapView.js\":\"9edcafe94c1f07cd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/blockTypes.js\":\"945635df0c4304c5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/codeMirrorExtensions.js\":\"58e1fc5e99b50796\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/createOrFindPlace.js\":\"d28c1b39fc77a7a8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/currentLocation.js\":\"588f25ee8e24f712\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/dataExtension.js\":\"bfed69820eec755d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/geoContentDecorator.js\":\"b084e649bc53920c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/googlePlacesClient.js\":\"11cc52e44ea31b08\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/index.js\":\"0ca0bfcf545dee4c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/locationsPage.js\":\"54cd311401b0a8fe\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/mapViewport.js\":\"61fb460d7e52ce6d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/pickCurrentLocation.js\":\"b5790f48cca8f3c7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/placeAutocomplete.js\":\"e0c5d4eb32b0b9aa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/placeNameCollision.js\":\"b8b97f3799fd2231\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/properties.js\":\"79c62d16b6eb06c5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/propertyEditorOverrides.js\":\"3984d3e0f381794e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/query.js\":\"1aa00de76d514d9f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/geo/usePlaceSearch.js\":\"9af596ee5414ed6b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b1803c63fc6bdaa3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"89c940e468e968a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"592b0a9503765ab2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/config.js\":\"e7ab62e7817b926f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/dataExtension.js\":\"70fb1667d4f778c6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/facet.js\":\"ad4d58ba21970c4a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/grouping.js\":\"61ee79037704768a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/index.js\":\"5c73adb70f55ef98\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"11f509780f620dc9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/query.js\":\"46756b77a9d0d5f4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/resolveConfig.js\":\"d1249cd032f7aac4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a37ac19ccbc185fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e4f91d71a59e891b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/HtmlDocumentContent.js\":\"f62df08f2c2cc30e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/HtmlFrame.js\":\"a8da4d02f8fb1f86\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/actions.js\":\"47b3e0487cde43fb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/blockType.js\":\"4c1f7a5ac460c592\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/confirmRunScripts.js\":\"a3c2f914077f8718\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/dataExtension.js\":\"b8bfd235d4dc2650\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameAnnotations.js\":\"2db4a7eb1c2e6df2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameDocument.js\":\"be286af2e383a534\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/frameTheme.js\":\"ff6fc1fe057c8082\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/index.js\":\"c99ca2a2ad91d092\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/scriptConsent.js\":\"cc8645cb4ade96b1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/sourceMap.js\":\"4daf2ac9815ac371\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/html-document/useDocumentScripts.js\":\"728066f614f488f9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/index.js\":\"14962880a33ff912\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/record.js\":\"9f51c964e1244702\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/recordStore.js\":\"1df85dbdb1853b94\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/responsiveness.js\":\"a5add42e002d640b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/schedule.js\":\"9277f74cca2def44\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/interaction-metrics/sessionContext.js\":\"9abdb228355c7c56\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5449581db3ecea76\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d328c55458d5abcc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/actions.js\":\"68b56f9378f719b2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/config.js\":\"6a6c672dd22e031e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/dataExtension.js\":\"5a0aaca55ddcf847\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/effect.js\":\"e75a2577e7891b42\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/index.js\":\"3c766b5cb58cf1e6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/keyCapture.js\":\"55b63f7b4ef09985\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/overrideStore.js\":\"4cecc98967bdba7c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"078b26d023b6f28d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/HeaderItem.js\":\"d4582f76dab613a6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/LeftSidebar.js\":\"90e25d2bbdc754a1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/actions.js\":\"b151598ff34540f4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/facet.js\":\"2453f36c4420faa3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/index.js\":\"1d7d57d21672b1ba\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/shortcuts.js\":\"a555b56a54a42fd0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/left-sidebar/toggleStore.js\":\"4a770d41f7cc9a3b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/MergePicker.js\":\"ac669738f38038d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/index.js\":\"e439e874f48ab1f5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/mergeAction.js\":\"b6745e40ac121a94\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/merge-blocks/strategy.js\":\"ebe931c91978211b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/Button.js\":\"e0d51e85fd091038\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"168c8b75bcaafb27\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/defaultItems.js\":\"36cbfe2d014e0c10\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/facet.js\":\"52698a666e4034fa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-bottom-nav/index.js\":\"8eb20e79f939227b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"397d1f28d1163071\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1c3a0f40314d6f88\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4b8402c2ef5aefcb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/facet.js\":\"62aadb1f00f81cce\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/mobile-keyboard-toolbar/index.js\":\"0c6eb8e41f341539\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7d9c866e709bf23b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c0d8dd1c8cc21496\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/contextMenuItem.js\":\"e9c33deba4fec5f6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/index.js\":\"313032c49dd5fd9e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/moveAction.js\":\"5875baad660d40e3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/moveBlocks.js\":\"b63d7e9c569b302a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/move-blocks/selectionAfterMove.js\":\"cee75ee243e68d02\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/TutorialBanner.js\":\"a45bbaa433dce3c7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/action.js\":\"33bce38615f3ba23\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/bannerDismissal.js\":\"7abc335337704a4b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/documents/cheatSheet.js\":\"7d36016ccf678ead\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/index.js\":\"f6c6d66beef15fc4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/keys.js\":\"b8efce8f4d128f30\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/landing.js\":\"6964499b078cff6d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/outline.js\":\"45a0400a9134c226\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/onboarding/seed.js\":\"0e6cb98376afa124\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6dd834664d76c6bf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/analyze.js\":\"f8e2f381972a78ac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/diagnosticsSource.js\":\"0a7822c216ab6e35\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/index.js\":\"75cfffb16bd65837\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/load.js\":\"d6ad36fe25162d00\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/monitorRun.js\":\"5eddac7a3c001ae5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/schedule.js\":\"3adab680a99b3fe7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/series.js\":\"da013a67e33f9222\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/store.js\":\"a8c65251c6084a55\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/trendAction.js\":\"ecbe1b26d9a57f46\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/perf-monitor/verdict.js\":\"8915789a9e106dd5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/clickToEditAction.js\":\"0deefee2c2288618\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/index.js\":\"03c07eb982e762cb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/plain-outliner/interactions.js\":\"66f377f47848db3e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8a1d2649f795e457\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/MigrationGate.js\":\"2175b19b6920fc58\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/MigrationGateDialog.js\":\"00ba8dea1c13eadd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/action.js\":\"5d3440ef97478b96\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/index.js\":\"b437952e262cf4c7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/localRunMessage.js\":\"102b52c9a76986d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/plugin.js\":\"24ca11b6d9d61741\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/progressReport.js\":\"5c18d83b8319569a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/properties-migration/sweepProgress.js\":\"4c1eaead21f80fee\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/FieldRowRenderer.js\":\"37827935428bc5be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/ValueRowRenderer.js\":\"5afdc0a30738a8d0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/actions.js\":\"12961e2879775a74\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/autocomplete.js\":\"e5f8d5b934771b6f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/fieldRow.js\":\"2e4ed7f3141008f2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/index.js\":\"b0a3cc817b4026dc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/referenceWarning.js\":\"5229d521f6326ce8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/valueAutocomplete.js\":\"a9509637b9cac354\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/property-rows/valueSchema.js\":\"a6c237657ff4f7ec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/HeaderItem.js\":\"6587c8d19b74ec89\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/QuickFind.js\":\"d3b35b12499fa384\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/index.js\":\"a47c9d1a736c0bae\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/recents.js\":\"4b092b6da623fb37\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/resultItems.js\":\"1ffbf5517bb572e8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/selection.js\":\"498f174c8af8bb27\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/quick-find/toggleStore.js\":\"94392112708ec84c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/HeaderItem.js\":\"9462f0066b87e4af\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b3822871f231558c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/grouping.js\":\"050de2605d001433\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/index.js\":\"88e20808067265fa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/recents/target.js\":\"d3a1eb438f74de5c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/codeMirrorExtensions.js\":\"9acae1a8cec9a9dc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/contentPrefill.js\":\"efdca717c277fdcc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/dataExtension.js\":\"00233c77b3af90c2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/index.js\":\"b6749b5db0c87de2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"91d18abc3b87744a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/invalidation.js\":\"fcb6ac4c550a4131\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/localSchema.js\":\"c1ee25cd145813b3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/blockrefs/index.js\":\"8639dac4afef2962\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e46bb137cca7c7ec\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/index.js\":\"1407dc07b39a04c3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/referenceNode.js\":\"60f6dae58d12113e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b47812f5a5e61907\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"59fe3f015165f043\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/index.js\":\"2e803be4221d6725\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ddf7ece851666047\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c4ed7599bfceb3c8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/mergeRetargetProcessor.js\":\"552815cdea22331b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/parseFence.js\":\"5d21bfd40d89e1ac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referenceParser.js\":\"1337a715fe1189a1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referenceProjection.js\":\"fd4a685f86350bf0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/referencesProcessor.js\":\"97cdc28ac1cbeb69\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/renameProcessor.js\":\"5d4ee04f483759eb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/references/spanReplacement.js\":\"e5f65ad9201549a7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/htmlToOutline.js\":\"8e324438621f261c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/index.js\":\"0c50220ac949b57f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/normalizeClipboardDom.js\":\"724b5359e39a1c99\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/rich-paste/pasteDecision.js\":\"b9aa6b0f307d0574\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/action.js\":\"a9810d26faf76738\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/blockIds.js\":\"b1a1794760c27a25\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/content.js\":\"05e477f4f843c7fa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/effect.js\":\"000f641f64e65aac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/ids.js\":\"4e03ddef289fe2d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/import.js\":\"144ce77b0caf003b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/index.js\":\"15c0036841c8146f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/plan.js\":\"3b26354cc6bd794a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/plugin.js\":\"c479f0de426ebbdf\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/promotion.js\":\"a2f3b0530a750823\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/properties.js\":\"3131ee3d5c1a1f8b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/references.js\":\"8dbe910ba4dc9136\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/report.js\":\"f0935e214f1cc8be\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/roamMemo.js\":\"a77f72252bd1e4d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/runtime.js\":\"d8a27459829ee808\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/schemaReconciliation.js\":\"5472132b02e6de80\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/srsMarkers.js\":\"9403b33e02687610\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/todo.js\":\"c02060fd168b0a06\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/typeCandidates.js\":\"4e8b519ccc83dcda\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/roam-import/types.js\":\"cfbbd318d8e2af34\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/search-health/index.js\":\"85c98befa9ca927b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/search-health/store.js\":\"ccb5e2c7a29b8ae1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/HeaderItem.js\":\"27ffc7a9447afe33\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"77337f14cfe9e472\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/index.js\":\"d707701552e4d08c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/model.js\":\"3de85f7f3f7cca1a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/toggleStore.js\":\"2bf7b71447222379\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/shortcut-help/useKeyInspector.js\":\"ecd4c8d56096763b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0c609b01425fcfe0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/ShellDecorator.js\":\"3351042347f06d15\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/actions.js\":\"7e483b47bc4cb35e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1325f48b0a5bf51d\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/index.js\":\"a89a3a156c65ae6b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/shell.js\":\"51a86bf4f40dea0b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/surface.js\":\"1181deee9cc9756c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/spatial-navigation/walker.js\":\"eeb58fed4ac5c91c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a740b0e842a66b53\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/dataExtension.js\":\"74bb42b3814fdba4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/index.js\":\"4b99c6084302af47\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/indicator.js\":\"71243ad34895c924\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/moveSrsState.js\":\"ca873f650484647b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2ce1a141046f4225\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/scheduler.js\":\"ec1b2135cc48e1a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/schema.js\":\"bdf0d24fbd544557\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"95d228664bd6b879\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/srsClipboard.js\":\"19f20a4d61e68df4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f6b74668c48a179a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/DailyNoteReviewHint.js\":\"490ae9daed7f7f05\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/DeckPicker.js\":\"511a0a20d5ebd2f1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewControls.js\":\"c52d300211359008\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8a92a0cf17fedc72\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/ReviewSession.js\":\"09338a2596082db4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/actions.js\":\"e7be7cfe9e9e6861\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/archive.js\":\"1908f576048f9e56\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/dataExtension.js\":\"92acfbf55f0e47ea\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/deck.js\":\"3ba5d501cbc0d45f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/dueQuery.js\":\"0e95fb354cc54500\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/gradeDecision.js\":\"aacdbc2dda980c67\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/index.js\":\"f7adc91f4e242754\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/keyHints.js\":\"674e2f751212e7e3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/reviewCardLayout.js\":\"f3436afc99e808ac\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/reviewProgress.js\":\"d29179e89bafc6b8\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/schema.js\":\"4df0c0dae0ec3dde\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/srs-review/useDueCards.js\":\"1d79af5a1aa31a02\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/startup-metrics/index.js\":\"b14050b1fec218ff\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/startup-metrics/record.js\":\"6ca19e498cf25181\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/index.js\":\"c1047668fec2bb8a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/persistenceStatus.js\":\"cca7e708ccbf3e0b\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/storage-persistence/requestAction.js\":\"a3388cf13f982380\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/TypeChipsDecorator.js\":\"2ab473b1135743fd\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/codeMirrorExtensions.js\":\"734903f8fc641bd6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/index.js\":\"666880bc48668d5a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/supertags/typeAutocomplete.js\":\"d4ca6be7ef1ad7a2\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"54b83f37513f7341\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/actions.js\":\"59a4a13b5fc7478a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/anchor.js\":\"9ebb7268ac58d58e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/events.js\":\"e12a5b786299d2b7\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/gestureActions.js\":\"93f98b95b442fac0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/index.js\":\"4c0038865873004f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"705257c782e1dd49\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/collect.js\":\"ecbef0f9c7d6bf2f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/index.js\":\"442c523d917aa15e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/sync-metrics/record.js\":\"f7e03ef3d28628c0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/RejectionDialog.js\":\"ee22309ca7173e7c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f0090281526eef53\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/index.js\":\"c0dfd6246e968067\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/model.js\":\"337de07be52024f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/queueCounts.js\":\"262978aeeae9941c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/rejectedHelpers.js\":\"4d5662a99088ff53\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/rematerializeAction.js\":\"4972e7dea1669c79\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/system-status/useHysteresis.js\":\"7229271ea2e9c135\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/ColumnHeaders.js\":\"9e851abc8b4b0965\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/QueryUi.js\":\"483f1084ba37d040\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/TableLayout.js\":\"79992cf80c1315fc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/actions.js\":\"0f771bd9d1b52f26\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/cellEdits.js\":\"e01b87435599dc7f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/childrenViews.js\":\"89c87e0dd8190a06\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/columns.js\":\"7e013b9af252abcb\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/controller.js\":\"3bd5cf0182093288\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/convert.js\":\"4988e4230c0cdeb5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/dataExtension.js\":\"dd6757736e438e74\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/index.js\":\"295af5556d19f22c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/keys.js\":\"7dc0b7f36ec9ce3f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/model.js\":\"7b2af723c70161d1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/backfill.js\":\"15b74c094d4ed0d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/completion.js\":\"b72c3ca21a3ef216\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/format.js\":\"6edd77bed6e596d4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/parse.js\":\"149a039620b5e013\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/queryValue.js\":\"cb49b0c7a66bd80f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/query/source.js\":\"fed0f249a9a323f3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/registry.js\":\"19765b3a72e8a5a3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/rowGutter.js\":\"97027dc518c8ec0c\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/rowVerbs.js\":\"a8e9e20496f2baab\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/schema.js\":\"cda4252a62d3e981\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/tables/sort.js\":\"aa0599de233f98dc\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/effect.js\":\"d08bdf90484f2246\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/index.js\":\"f5c002d9ca677138\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/theme-toggle/theme.js\":\"6dff9ec3c2422a83\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/actions.js\":\"142defb89837ce2a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/dataExtension.js\":\"caceffa58264fa50\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/index.js\":\"a65020020562a9a9\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/todo/schema.js\":\"699eff781c92931f\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4e854e921d9a8eb1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/actions.js\":\"13d4f58dcca383c5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/defaultItems.js\":\"30b267455646d3e3\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/facet.js\":\"41e74b46c884ecaa\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/holdRecognizer.js\":\"8d044f55b42ceed5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/touch-selection/index.js\":\"bf0d061126812eb1\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/UpdateIndicator.js\":\"821e5c24f1ce8392\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/index.js\":\"2d9ff84661a439b4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/update-indicator/loadTimes.js\":\"eb086073600445b4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoNotesRenderer.js\":\"89ec5ebac48b0502\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoPlayerRenderer.js\":\"8e6a9c00be94ad69\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/VideoTimeStamp.js\":\"ce1d88d41e7564d5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/actions.js\":\"19eafedfa2a15139\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/index.js\":\"e429cc9d69528036\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/markdown.js\":\"b0a5044179b992a4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/notes.js\":\"6ea15c36e96616ad\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/registry.js\":\"2d71a4c376b83165\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/remark-timestamps.js\":\"278dab39eabce2d6\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/video-player/view.js\":\"62057501589a7780\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/LinkHints.js\":\"0c4c8d4533214ca5\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/index.js\":\"86d7ec118416279e\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/model.js\":\"b1ee3505aba805e4\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-link-hints/settings.js\":\"6ed270d9cdb8942a\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/actions.js\":\"c36fc5dfefe6dd21\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/index.js\":\"ef6aa62ed2a11bb0\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/vim-normal-mode/interactions.js\":\"7c4c36e364492180\",\"/knowledge-medium/pr-preview/pr-1868/src/plugins/workspace-header/index.js\":\"ef783dd6686fe7fc\",\"/knowledge-medium/pr-preview/pr-1868/src/registerServiceWorker.js\":\"918655eeaef7bda3\",\"/knowledge-medium/pr-preview/pr-1868/src/requestPersistentStorage.js\":\"bdf93617dc13df48\",\"/knowledge-medium/pr-preview/pr-1868/src/services/authRequestDeadline.js\":\"0c504bad152cf243\",\"/knowledge-medium/pr-preview/pr-1868/src/services/authStorage.js\":\"c4a492414c3cd6c1\",\"/knowledge-medium/pr-preview/pr-1868/src/services/powersync.js\":\"66b11f53886b4c66\",\"/knowledge-medium/pr-preview/pr-1868/src/services/supabase.js\":\"4d46818e47b02fd9\",\"/knowledge-medium/pr-preview/pr-1868/src/services/uploadErrorClassifier.js\":\"e6bfa295aad4dcfc\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/ActiveContexts.js\":\"709a672feb8aa337\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/HotkeyReconciler.js\":\"f053d5f18897363d\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/WipeLocalDataDialog.js\":\"ecbdcb67756e72d9\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/actionDispatch.js\":\"b952518f7eed019f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/actionRefItems.js\":\"4cba1cd147dbb70e\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/applyKeybindingOverrides.js\":\"fa91aef86ee63b3f\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/blockActions.js\":\"86b05e4759e9b493\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/blockMergeGesture.js\":\"ec0febc649006faa\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/canonicalizeChord.js\":\"7a3705484abf6bb8\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/defaultContexts.js\":\"034a83983382ed4a\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/defaultShortcuts.js\":\"9afa54f73c34dea6\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/effectiveActions.js\":\"7a94225c7e676466\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/gestureAction.js\":\"ce904d253264d7ea\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/gestureBinding.js\":\"2803ab10217366a5\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/holdRegistry.js\":\"0c22161f99e82791\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/keybindingConflicts.js\":\"81675f988684e51a\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/keybindingOverrides.js\":\"3a014af10b7ec237\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/pointerAction.js\":\"d6d99f395ffd986a\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/resolve.js\":\"7da7dd0389dda684\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/runAction.js\":\"7bbfae84d7ea3b73\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/sequenceMatcher.js\":\"d764471c8d41b014\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/types.js\":\"deb6714998b66068\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/useActionContext.js\":\"210731ddde494fa8\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/useActionDiscovery.js\":\"31c4f0cf14c41bf1\",\"/knowledge-medium/pr-preview/pr-1868/src/shortcuts/utils.js\":\"9897cf7005335f4a\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/bootStore.js\":\"f16b0b36e6895f89\",\"/knowledge-medium/pr-preview/pr-1868/src/sw/previewDatabases.js\":\"4b383b5db57c2029\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/byteTransform.js\":\"13c503f16994f721\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/attachmentCleaner.js\":\"81f8f2f7d989f3b2\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/attachmentParts.js\":\"4b50ce4cd2fd457f\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/bundleParts.js\":\"8193118c1151967c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/bundleRecord.js\":\"a25278d16f2d4c49\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/manifest.js\":\"d0c9db94d79e0bce\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/takeBundle.js\":\"0215c151a21fc671\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/bundle/verifyBundle.js\":\"0a32db2c407b12d3\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/cleaningStage.js\":\"41e586290a34007c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionKey.js\":\"b1bf52d759cb31e8\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/conversionServer.js\":\"fdc3d2c2e54e5f94\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/flip.js\":\"6fc144d8da98ab7e\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/flipAttempts.js\":\"44ef8d50a712c724\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/pages.js\":\"9284e0ebab9079fd\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/preflight.js\":\"ea602db68f13ba37\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/reseal.js\":\"6ca0e45b5bf9db1b\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/runConversion.js\":\"6aa1b9a66b3cf7b8\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/runLock.js\":\"1e00e7dd0e51fead\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/sealing.js\":\"9db9f0b2f78e86bb\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/sealingStage.js\":\"d9a9cebd8d609a0b\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/stage.js\":\"58915a3d41f70a07\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/conversion/verifyReseal.js\":\"64bd0870aed1c491\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/aad.js\":\"e1ccfdba5d71c08a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/aead.js\":\"ce5b788c907fbf65\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/base32.js\":\"8026b8070db781a1\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/base64url.js\":\"a996bed3af2a26db\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/binaryEnvelope.js\":\"037e3bbcc3ae260d\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/byteAead.js\":\"dc6ddef96bd30c96\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/canary.js\":\"6328800d90d8d34d\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/contentHash.js\":\"f95d6d877bdd3852\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/contentKey.js\":\"3d50fe0c3ed12357\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/derivedIdNamespace.js\":\"4d3be7ce827a7ada\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/envelope.js\":\"16ec7ad20ddebf30\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/hex.js\":\"25de91adceb3b626\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/sha256Hex.js\":\"60e1e0ea9e4f3d6c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/crypto/workspaceKey.js\":\"b7dcc8c5492c4b0a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/conversionState.js\":\"20d4ff5159405c52\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/createEncryptedWorkspace.js\":\"453678a0b2598346\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/pastedKey.js\":\"2d25c2e81304a4c0\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"eabbc8fb21e7254c\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b48d9b942ee6405a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/keyStore.js\":\"83cf0ce48658df0b\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/mintWorkspaceKey.js\":\"eb130d73d02a49c3\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/modePin.js\":\"c1ee8e1af96e2cc4\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/openWorkspaceKeys.js\":\"c651a491727262e6\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/resolveWorkspaceEntry.js\":\"0cfb78b2e1b79688\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/resolver.js\":\"eab7179a85750f04\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/keys/workspaceAccess.js\":\"28020812c672786a\",\"/knowledge-medium/pr-preview/pr-1868/src/sync/transform.js\":\"30315174020c650d\",\"/knowledge-medium/pr-preview/pr-1868/src/themeBootDefaults.js\":\"2a9ee9b08a4c2725\",\"/knowledge-medium/pr-preview/pr-1868/src/types.js\":\"f40e5e1d6f810e00\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/ClientLocalSettings.js\":\"80b874a5cbc95c4c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/abortableSleep.js\":\"5af577ca13eba1e4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/array.js\":\"10e3410b5d600c2d\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/backlinkAutocomplete.js\":\"e7a2b40a0b75fd05\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/blockCrumbs.js\":\"3c8bc3a4aff1c02b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/blockrefAutocomplete.js\":\"00e92dfd4c142362\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/cadencedIdleJob.js\":\"a9802c9d23aba381\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/callbackSet.js\":\"fce78e22a68c14e3\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/clientId.js\":\"0a91c5fdcc904754\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/codemirror.js\":\"86b06d5cd10928a8\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/codemirrorCompletion.js\":\"3992ba0bec8defb1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/copy.js\":\"fdc34b116106a0b8\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dailyPage.js\":\"a94294474e215ff1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dbForensics.js\":\"baa14f116908eb57\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dbForensicsHooks.js\":\"e2c9263f585548a0\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/deleteBlockThroughUi.js\":\"48fd80dcd08acc50\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dialogs.js\":\"e6caf32d748b2be2\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/dom.js\":\"3cb7572a94131741\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/downloadBlob.js\":\"f487195bea53ec08\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/drawnWalk.js\":\"daceefb1e2760a03\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/exportSqliteDb.js\":\"7a71a42f566be749\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fileSystemAccess.js\":\"1147087bd78ffcc0\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/flipSlide.js\":\"3828642b3fc60cd4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fnv1a.js\":\"ad90221751e35b60\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/formatBytes.js\":\"d121f4de66d9b688\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/fuzzyRank.js\":\"1e704d541dc8ad7c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/idbKeyedStore.js\":\"25d2b40b86ad3087\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/idleCallbackPolyfill.js\":\"93dd12d23b463e8a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/keyboardAwareScroll.js\":\"f9c2425c2ca4cef4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/keyboardViewport.js\":\"a7f0c62874dc85e6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/lastWorkspace.js\":\"d70d02af4c7449b7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutColumns.js\":\"165e8b3ea8a37f24\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutSessionDom.js\":\"ae5b33ee84909635\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/layoutSessionId.js\":\"81b5eab5969e11ac\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/linkClickGestures.js\":\"1d9aa45a23f30c98\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/linkTargetAutocomplete.js\":\"8939c3e0670a26aa\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/localDbCorruption.js\":\"d76a6e0c4eb9dd2b\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/localDbRecovery.js\":\"d67df5ceadac332f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/markdownParser.js\":\"f20e7f773f596e9f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/memoize.js\":\"cf2a37439caaed21\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/nameFieldCommit.js\":\"adff24bf4124ecee\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/nameList.js\":\"2bf6185d1f70b0a1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/navigation.js\":\"56a396021ab89023\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/omnilinerNamespace.js\":\"94fad98392b6cc78\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/opfsPageScan.js\":\"6bd2fcafec87a7a4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelClearance.js\":\"379f146fb202a001\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelHistory.js\":\"ac62071f2c50928f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelLanes.js\":\"a3e0406a9eeb8fc4\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelLayoutProjection.js\":\"5f2250459d96150e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelScrollAnchor.js\":\"ea800609cdbdb45e\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/panelUrlFlags.js\":\"200408606fa818ce\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/platform.js\":\"7b7b99baa3291898\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/pluralize.js\":\"99bb8b47e8a5225c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyCreation.js\":\"bcc4fffa87ab9820\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyNavigation.js\":\"83dcc2119080a173\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/propertyValueContext.js\":\"dbff939e0010f9f7\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/react.js\":\"1e017b8f111d0f2d\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/relativeDate.js\":\"00459127bef64a54\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/relativeTime.js\":\"5be9a996022bc888\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/renderScope.js\":\"6ca9399305c16148\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/resolvedThenable.js\":\"3979461055160f54\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/routing.js\":\"3698312c1ca6944d\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/safeMode.js\":\"89bf6897b4c5ba67\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/scheduleIdle.js\":\"0eab67a98b0c1d38\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/screenWakeLock.js\":\"ceea1cc03da21249\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/selection.js\":\"4b7c19ec464fead9\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/softKeyboardGrab.js\":\"d092013d8b6c143a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/startupTimeline.js\":\"adb2958b76fd1bc6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/state.js\":\"703084bd7e5da0ed\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/string.js\":\"856bfe2292fb0a27\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/surfaceZoom.js\":\"fa73369730261202\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/time.js\":\"c1157c9893de1c08\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/toast.js\":\"2e242bffb8bca13a\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/toggleStore.js\":\"d1d18a79fb0fe04f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/untilStopped.js\":\"f31424c67447956f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/userActivity.js\":\"6758eb8a632ac491\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/viewTransition.js\":\"d44d3f617a5078c1\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/viewport.js\":\"c6e11a644534a54c\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/webLock.js\":\"c74032b14253fcbd\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/workspaceRecovery.js\":\"b07f73c8aab60c8f\",\"/knowledge-medium/pr-preview/pr-1868/src/utils/workspaceSnapshotStore.js\":\"29288b30902d7ad3\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-compiler-runtime.js\":\"99f46652c8016599\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-client.js\":\"a0fe63ff9aab8bdf\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-server-edge.js\":\"5c04b449f86c7cf2\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-server.js\":\"101194a3a69f51c7\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-static-edge.js\":\"0dd99d4760549c70\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-static.js\":\"f72fb1bddc711ade\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom-test-utils.js\":\"5c142c46a09e2eaa\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-dom.js\":\"5a412539954413d5\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react-jsx-runtime.js\":\"d411068798743b66\",\"/knowledge-medium/pr-preview/pr-1868/src/vendor/react.js\":\"608aae4acd4d5804\",\"/knowledge-medium/pr-preview/pr-1868/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1868/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1868/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
