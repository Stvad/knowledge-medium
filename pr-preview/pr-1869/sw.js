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
		buildId: "c42702608ec1-64b49412",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1869/\":\"7ab2e5ba968356d5\",\"/knowledge-medium/pr-preview/pr-1869/index.html\":\"7ab2e5ba968356d5\",\"/knowledge-medium/pr-preview/pr-1869/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1869/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1869/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1869/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1869/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1869/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1869/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1869/assets/FacadeVFS-C3Ew4dz-.js\":\"4ab654bcb53530e6\",\"/knowledge-medium/pr-preview/pr-1869/assets/OPFSCoopSyncVFS-81tZNdtE.js\":\"21061df6307a434f\",\"/knowledge-medium/pr-preview/pr-1869/assets/OPFSWriteAheadVFS-MVwdZWWS.js\":\"64679582a1cc100f\",\"/knowledge-medium/pr-preview/pr-1869/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1869/assets/wa-sqlite-Cgt9QqbA.js\":\"133a0a6addfd5705\",\"/knowledge-medium/pr-preview/pr-1869/assets/wa-sqlite-async-B-A8cRRv.js\":\"6926d473cbe97efe\",\"/knowledge-medium/pr-preview/pr-1869/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1869/assets/worker-C8gXiMGd.js\":\"696e5d30e9b27018\",\"/knowledge-medium/pr-preview/pr-1869/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1869/chunks/app-Behb-jUV.js\":\"e8bd5f3066478402\",\"/knowledge-medium/pr-preview/pr-1869/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1869/index.js\":\"cefc5f78df8fee14\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1869/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1869/assets/AccessHandlePoolVFS-D8JAOjCq.js\":\"7af2e8b2b12d6b14\",\"/knowledge-medium/pr-preview/pr-1869/assets/IDBBatchAtomicVFS-B1Pm0OW-.js\":\"117fafb60450e468\",\"/knowledge-medium/pr-preview/pr-1869/assets/MemoryVFS-BScrQqt_.js\":\"df67e4d6aa71e24e\",\"/knowledge-medium/pr-preview/pr-1869/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1869/assets/mc-wa-sqlite-DA7WH70W.js\":\"2fa63f8e4612a30d\",\"/knowledge-medium/pr-preview/pr-1869/assets/mc-wa-sqlite-async-BFPK6nUK.js\":\"5843cd1370bc83f7\",\"/knowledge-medium/pr-preview/pr-1869/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1869/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1869/chunks/AccessHandlePoolVFS-DOFLPHq2.js\":\"f6b570d1422c1a32\",\"/knowledge-medium/pr-preview/pr-1869/chunks/FacadeVFS-CG56k-Xd.js\":\"4e83a1889cc6f093\",\"/knowledge-medium/pr-preview/pr-1869/chunks/IDBBatchAtomicVFS-DtlUtNiI.js\":\"b16c9ecc393b7006\",\"/knowledge-medium/pr-preview/pr-1869/chunks/MemoryVFS-C3eoPr0a.js\":\"a1ea5743c5daa2f2\",\"/knowledge-medium/pr-preview/pr-1869/chunks/OPFSCoopSyncVFS-BGDNXY6J.js\":\"fa9c58befa7a1390\",\"/knowledge-medium/pr-preview/pr-1869/chunks/OPFSWriteAheadVFS-B5mAQn46.js\":\"0cbcf0ca57e17994\",\"/knowledge-medium/pr-preview/pr-1869/chunks/Preview-C4BnxiJW.js\":\"75466ad7fb2930f2\",\"/knowledge-medium/pr-preview/pr-1869/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1869/chunks/card-D0m4nwtZ.js\":\"0dc44bd39a36a9b1\",\"/knowledge-medium/pr-preview/pr-1869/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1869/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1869/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1869/chunks/dist-fELaKZku.js\":\"09d345b4205dc6a1\",\"/knowledge-medium/pr-preview/pr-1869/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1869/chunks/mc-wa-sqlite-EpIcc-4z.js\":\"b04a4a025e90fac8\",\"/knowledge-medium/pr-preview/pr-1869/chunks/mc-wa-sqlite-async-W3NyCyBR.js\":\"e1e1409b4d0baafb\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-Bm61T6ae.js\":\"168e4abbdb1db256\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-BmTLZ1rS.js\":\"6fb05b5fa927cd50\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-CpVUKh8w.js\":\"271619f0397ba531\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-D0SvR3mQ.js\":\"59091f5c629935d4\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-D2r32YZS.js\":\"2be2e8b5e962ca8d\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-DzXJqray.js\":\"2406eff34f700b1c\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-Owfoudjf.js\":\"72bc35e2d48835f2\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-dom-server-legacy.browser.production-CDA9Gehc.js\":\"414587814da38186\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-dom-server.browser.production-CcuEazb8.js\":\"a510e55ba518c2e3\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-dom-server.edge.production-BSCd19Mu.js\":\"bc44e71dd38674b4\",\"/knowledge-medium/pr-preview/pr-1869/chunks/react-g3IJcarw.js\":\"2d9e9c28c26a7412\",\"/knowledge-medium/pr-preview/pr-1869/chunks/server.browser-BOMXSKzB.js\":\"4e90d5755d28cd49\",\"/knowledge-medium/pr-preview/pr-1869/chunks/textarea-CkYmz6hC.js\":\"f5d6316701d5433d\",\"/knowledge-medium/pr-preview/pr-1869/chunks/ui-DkkELKc4.js\":\"d265845191da6b59\",\"/knowledge-medium/pr-preview/pr-1869/chunks/wa-sqlite-DVt83oNC.js\":\"877150b45c0ad3bf\",\"/knowledge-medium/pr-preview/pr-1869/chunks/wa-sqlite-async-DANJVmGo.js\":\"5197dd3644ac388b\",\"/knowledge-medium/pr-preview/pr-1869/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1869/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1869/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1869/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1869/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1869/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1869/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1869/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1869/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1869/src/App.js\":\"62edf6cb8e8c76b5\",\"/knowledge-medium/pr-preview/pr-1869/src/appUpdate.js\":\"4205a9804745c25d\",\"/knowledge-medium/pr-preview/pr-1869/src/appVersion.js\":\"210a98f921293a1a\",\"/knowledge-medium/pr-preview/pr-1869/src/bootstrap/initialLayout.js\":\"083b8d7dcd69dcc7\",\"/knowledge-medium/pr-preview/pr-1869/src/bootstrap/openWorkspaceData.js\":\"b944e3fbf9c6faba\",\"/knowledge-medium/pr-preview/pr-1869/src/bootstrap/resolveWorkspace.js\":\"6c1b4299efb31a7f\",\"/knowledge-medium/pr-preview/pr-1869/src/bootstrap/workspaceBootstrap.js\":\"5d83b3a0dc770ce4\",\"/knowledge-medium/pr-preview/pr-1869/src/components/BlockComponent.js\":\"cb6e014ba6e8c6bb\",\"/knowledge-medium/pr-preview/pr-1869/src/components/BlockCrumbs.js\":\"6f3619a2b1c58b84\",\"/knowledge-medium/pr-preview/pr-1869/src/components/BlockEditor.js\":\"f621371031384ea1\",\"/knowledge-medium/pr-preview/pr-1869/src/components/BlockLoadingPlaceholder.js\":\"2a21327cc485ffab\",\"/knowledge-medium/pr-preview/pr-1869/src/components/BlockProperties.js\":\"5f65c54a7f661605\",\"/knowledge-medium/pr-preview/pr-1869/src/components/BlockSearchPicker.js\":\"6e71274d6aae6d0e\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ConfirmBulkDeleteDialog.js\":\"0e8fa22c7661c09b\",\"/knowledge-medium/pr-preview/pr-1869/src/components/DividerHandle.js\":\"4cb163cde394705d\",\"/knowledge-medium/pr-preview/pr-1869/src/components/DraftEditor.js\":\"1c98164c999ff69a\",\"/knowledge-medium/pr-preview/pr-1869/src/components/GutterPill.js\":\"c5740923b4acb373\",\"/knowledge-medium/pr-preview/pr-1869/src/components/Header.js\":\"223e73c878390142\",\"/knowledge-medium/pr-preview/pr-1869/src/components/LazyBlockComponent.js\":\"5591a51603521dfd\",\"/knowledge-medium/pr-preview/pr-1869/src/components/Login.js\":\"2f3c8f54b38712fa\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ZoomableSurface.js\":\"8cc7cc604d56b721\",\"/knowledge-medium/pr-preview/pr-1869/src/components/editModeKeepalive.js\":\"0a9e25d157f0d3c6\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8e3d48d940893483\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"791cef7258bc8ddb\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/RefPropertyEditor.js\":\"0ed9d95df21db2a4\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/RefTargetTypePicker.js\":\"15ff5341c481c1bf\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/SelectPropertyEditor.js\":\"bf35fab6cf0dc27a\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/TypesPropertyEditor.js\":\"7c68c10d8c29f594\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/defaults.js\":\"c76b086affc3d4cd\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/kernelValuePresets.js\":\"a25f87b4a4a9ee1f\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/selectablePresets.js\":\"bef9dbe696070a82\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyEditors/typesPropertyUi.js\":\"35505f2de7d26513\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/AddPropertyForm.js\":\"d01a8168e1dac0b9\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/PropertyPicker.js\":\"e98a83cb8dd56f39\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/PropertyRow.js\":\"5645f607a7f78956\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/Rows.js\":\"89649639cc2a7c96\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/actions.js\":\"30138837deb2d7a1\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/declarationOnly.js\":\"e5073fe527fd6dc5\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/layout.js\":\"7ec1c65fbc124887\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/model.js\":\"b551ed9eca70caf3\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/shapeUi.js\":\"fc4c5a84379bd326\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/shapes.js\":\"6815cb5fcf7a8b92\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f639fb619f8c56a8\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanel/visibility.js\":\"87000e49e02a4f54\",\"/knowledge-medium/pr-preview/pr-1869/src/components/propertyPanelSections.js\":\"58b73381420278f6\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/BlockEmbed.js\":\"4a55d7f04d03af9d\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/BlockLink.js\":\"a22f58d325019ba3\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/BlockRef.js\":\"3e6cd71fa33bd5f7\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/ReferenceLink.js\":\"a0534560e9f27efb\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/cycleGuard.js\":\"f816b787a7910201\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/cycleGuardContext.js\":\"4ff2ee75390b4e4e\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/linkInteraction.js\":\"75425aa139148320\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/referenceLayout.js\":\"f1b9510b284cfffa\",\"/knowledge-medium/pr-preview/pr-1869/src/components/references/useBlockRefAncestors.js\":\"9ed3ccba5daa24eb\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/BlockGutter.js\":\"8912b104415d88fa\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/BlockInfoDialog.js\":\"6608cf62c44b06ca\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/BlockTypeBlockRenderer.js\":\"c295b11490028569\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/BulletHoverCard.js\":\"78a9f5add0447d39\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/CodeMirrorContentRenderer.js\":\"941e2667bbc419bf\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9d3e26142dd5dd06\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/ColumnResizeHandles.js\":\"973e8842ab30b971\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2a54be176b65a754\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/DefaultBlockRenderer.js\":\"922fc8c1012435a8\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/LayoutRenderer.js\":\"df65a03fe7948616\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/MarkdownContentRenderer.js\":\"84f8392b44791588\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/MissingDataRenderer.js\":\"ded3dd02a8e3660e\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/PanelRenderer.js\":\"ac6ef251dc181574\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/PropertySchemaBlockRenderer.js\":\"08401a40e80b598b\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/TopLevelRenderer.js\":\"d59760fcaeddb316\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/blockGutterMode.js\":\"416cf903de33db31\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/blockTitleText.js\":\"220b251548edc74e\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/fieldCreationKeydown.js\":\"d712359515b34a9a\",\"/knowledge-medium/pr-preview/pr-1869/src/components/renderer/layoutRootContext.js\":\"130e5f14c92d2665\",\"/knowledge-medium/pr-preview/pr-1869/src/components/typeChip/TypeChip.js\":\"9a109a13b7edfab5\",\"/knowledge-medium/pr-preview/pr-1869/src/components/typeChip/chipStyle.js\":\"f8bcb6457ebc43e5\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/anchored-floating.js\":\"3910475028467c30\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/button.js\":\"5e75a926e10f9745\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/card.js\":\"b7da43008c25c166\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/checkbox.js\":\"5399516d052178bd\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/collapsible.js\":\"ccdf663aae606f87\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/command.js\":\"6c8b2815498c61b0\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/context-menu.js\":\"c76c935415dc1298\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/dialog.js\":\"38fb1f8952ec97e7\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/dropdown-menu.js\":\"68db05ac6f286b42\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/floating-listbox.js\":\"fcd33d28407ddbd4\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/index.js\":\"ba670b7e50122834\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/input.js\":\"c348e002b593129a\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/kbd.js\":\"2bd693322a4e23a0\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/label.js\":\"7d8ead3c17c2f12d\",\"/knowledge-medium/pr-preview/pr-1869/src/components/ui/textarea.js\":\"c1d2ccc10498b5cb\",\"/knowledge-medium/pr-preview/pr-1869/src/components/useEditModeYieldKeepalive.js\":\"36aad07f7c63c2a2\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/BootFallback.js\":\"a9418a9617d2b290\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/FocusedRowLazyMount.js\":\"9888e011121613b3\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/LazyViewportMount.js\":\"d6eebc6638048883\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/LocalDbCorruptionFallback.js\":\"6334d36b9f592d00\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/error.js\":\"fdecb248c0bb21de\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/lazyMountRegistry.js\":\"de5ac01d72fa67d6\",\"/knowledge-medium/pr-preview/pr-1869/src/components/util/suspense.js\":\"935b9943091fbf3f\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/CreateWorkspaceDialog.js\":\"f18c208602d5d3cf\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/PendingInvitations.js\":\"f4387590b44b58b2\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/SyncProgress.js\":\"a5068b9cbe202382\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/UnlockProgress.js\":\"597ab9e02b035f0f\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/WorkspaceKeyGate.js\":\"8bc423674fa799ff\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/WorkspaceSettingsDialog.js\":\"a78da4515ca4d26d\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/WorkspaceSwitcher.js\":\"efc378aab142e9c7\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/WorkspaceSyncGate.js\":\"aa53396d8e80c4ae\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/ConversionFlow.js\":\"247e024966d00930\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/ConversionFlowHost.js\":\"567369ed06b56c53\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/EncryptionSection.js\":\"830b6d66073c43cb\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/attachmentPrompts.js\":\"618f3f5d33c2363f\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e9d60d9ac0ae6fbc\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/conversionFlowDeps.js\":\"25e41072e2a3456f\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/conversionFlowStore.js\":\"7c46a7cc73c400ba\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/flowUi.js\":\"de0658180646df62\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/conversion/useConversionRun.js\":\"4aafac804287249b\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/keyUi.js\":\"46688813660fb583\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/useCloseOnKeyLoss.js\":\"e1016a470d973f26\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/useCloseOnServerE2ee.js\":\"998ed8e18666d68d\",\"/knowledge-medium/pr-preview/pr-1869/src/components/workspace/workspaceUnlocked.js\":\"468d63d909b24660\",\"/knowledge-medium/pr-preview/pr-1869/src/context/backgroundSubtree.js\":\"478fc21888a84dfe\",\"/knowledge-medium/pr-preview/pr-1869/src/context/block.js\":\"b95ce0b84cc57d08\",\"/knowledge-medium/pr-preview/pr-1869/src/context/layoutWsContext.js\":\"0d34733df24b9671\",\"/knowledge-medium/pr-preview/pr-1869/src/context/propertyDisplay.js\":\"46bd378122873aa4\",\"/knowledge-medium/pr-preview/pr-1869/src/context/repo.js\":\"db60a404ce47e11b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/aliasClaim.js\":\"5c61dd6792ada99b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/aliasSeatNamespace.js\":\"52bb8f9f5ebd3729\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/blockData.js\":\"ed73c4abb81195fb\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/blockType.js\":\"3a41c14c441f4028\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/changeScope.js\":\"4b8a40628b6e4045\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/codecs.js\":\"b33cccc00380204b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/derivedData.js\":\"edb23fc91ed93476\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/errors.js\":\"05feb50bc1752910\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/events.js\":\"2cbdb747d772850b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/handle.js\":\"8777d24eb2860f3b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/index.js\":\"5d9aa8b8fbfacd35\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/mutator.js\":\"8c0781e2f99f3928\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/processor.js\":\"1716a71bdfb3a80c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/propertySchema.js\":\"990ed2af70a9d5b7\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/query.js\":\"e9fbb9554bacdc65\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/sameTxProcessor.js\":\"5bbec249dac0ca16\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/schema.js\":\"8777d24eb2860f3b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/tx.js\":\"8777d24eb2860f3b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/typedBlockQuery.js\":\"98974385867c5455\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/user.js\":\"2f1be3f480e2d467\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/valuePresetCore.js\":\"7bf3121788eb51e2\",\"/knowledge-medium/pr-preview/pr-1869/src/data/api/valuePresets.js\":\"e1484c27e35827eb\",\"/knowledge-medium/pr-preview/pr-1869/src/data/attachmentCleanerIOVerb.js\":\"2d004d5cf244a37c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/block.js\":\"94f42afb66561f60\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockCache.js\":\"8ac24266f66b9408\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockId.js\":\"95674987aacddec4\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockLiveness.js\":\"523bb626a049c315\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockMerge.js\":\"f6402585c6d30fc9\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockSchema.js\":\"cdb712184797245f\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockTypeLookup.js\":\"b744e329d83c0db3\",\"/knowledge-medium/pr-preview/pr-1869/src/data/blockTypes.js\":\"55f2856155b05743\",\"/knowledge-medium/pr-preview/pr-1869/src/data/childrenView.js\":\"aad807c7a526b5c5\",\"/knowledge-medium/pr-preview/pr-1869/src/data/clientContext.js\":\"f6f1f85d258f6933\",\"/knowledge-medium/pr-preview/pr-1869/src/data/dbFileSiblings.js\":\"f10fc84501cae449\",\"/knowledge-medium/pr-preview/pr-1869/src/data/definitionSeeds.js\":\"4688009633b0fd3e\",\"/knowledge-medium/pr-preview/pr-1869/src/data/derivedIds.js\":\"2c1bbae65453ef67\",\"/knowledge-medium/pr-preview/pr-1869/src/data/drawnSubtree.js\":\"020fb17d622d5965\",\"/knowledge-medium/pr-preview/pr-1869/src/data/facetBridge.js\":\"a737c5b6b8a25613\",\"/knowledge-medium/pr-preview/pr-1869/src/data/facets.js\":\"ee9846e4aa4c0996\",\"/knowledge-medium/pr-preview/pr-1869/src/data/globalState.js\":\"014d9041170e3d13\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/aliasClaimRederiveProcessor.js\":\"2883bfbe5b5434e7\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/ancestorBatch.js\":\"e8f64023b4862988\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/blockTypeTypeifyProcessor.js\":\"f3ea9ddea00983eb\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/clientSchema.js\":\"a8b165647286d050\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/commitPipeline.js\":\"f1c6d7083099cb34\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/devAssertions.js\":\"21bc306bf2922b6e\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/firstSync.js\":\"c68a2a41be8ca6b1\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/freshInitialLoad.js\":\"4699a5ba79a80e6c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/graphBackfillClaim.js\":\"d4859b3cb81cc3cc\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/handleStore.js\":\"f6c51a2e9e913b54\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/idleMarkerJobs.js\":\"344cd04e4fab7014\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/initialDownload.js\":\"7badf84c5157cdba\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/initializeClientDatabase.js\":\"a1a5fd66b00db293\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/jsonCanonical.js\":\"9a55bdbfc5cec3c5\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/kernelInvalidation.js\":\"186d276678a559a6\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/kernelProcessors.js\":\"ddfbbae43d910b94\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/kernelQueries.js\":\"0528b27f8c2cac7f\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/mergeTypeMembershipProcessor.js\":\"0c4dc68d833e0147\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/normalizeReferencesProcessor.js\":\"3048242cb9756945\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/poolInstrumentation.js\":\"c8df12a202e2ac93\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/processorRunner.js\":\"f724f53c6555dd84\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyCellBackfill.js\":\"936956bd0314f951\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyChildMint.js\":\"7754187d4da2e793\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyChildrenProcessor.js\":\"88a9a118c38fb981\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c1a090817a21481a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyDefinitionSynthesis.js\":\"4df1e8a89e33140c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyKeyScan.js\":\"22c7714ca6f5f14a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertySchemaResolution.js\":\"30b767d7629672d0\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/propertyValueEdits.js\":\"0b69c24536fc45e2\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/raiseProtocol.js\":\"6512da4dd2dc4e61\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/readBatch.js\":\"1d78a12b68296327\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/refProjection.js\":\"a3b9a58540d8fbb6\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/referenceTargetLookups.js\":\"454f9afaae139b42\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/referenceTargetProcessor.js\":\"585d8494c6f7d413\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/replayMerge.js\":\"29c57fba26eebf49\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/sqlBinds.js\":\"ca7b87f7970cf2d5\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ef5a7154151c53c6\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/syncObserver/arrivalProcessors.js\":\"6a14ced4926e05b4\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/syncObserver/invalidate.js\":\"0794324183a81746\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/syncObserver/materialize.js\":\"f7ce264ff2c5fac6\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/syncObserver/observer.js\":\"0ec06080e0b97524\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/syncObserver/reconcile.js\":\"73eb1c4e28cb0dba\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/timingMetrics.js\":\"cc32afa6f3ba2929\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/treeQueries.js\":\"88dde9ad12841e38\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/txEngine.js\":\"4bc114ba0abd3303\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/txSnapshots.js\":\"29b52b76af82011a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/typedBlockQuery.js\":\"5f4b4c426bede92a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/internals/undoManager.js\":\"6d89a68b2e5fdaa6\",\"/knowledge-medium/pr-preview/pr-1869/src/data/invalidation.js\":\"fca683b12725a4f7\",\"/knowledge-medium/pr-preview/pr-1869/src/data/kernelDataExtension.js\":\"e52eb74f85fd0100\",\"/knowledge-medium/pr-preview/pr-1869/src/data/kernelPage.js\":\"290e6e059267aa09\",\"/knowledge-medium/pr-preview/pr-1869/src/data/kernelValuePresetCores.js\":\"0b4e7560c0fcf2b3\",\"/knowledge-medium/pr-preview/pr-1869/src/data/localDbCorruptionSignal.js\":\"f8b819fe77ab92ad\",\"/knowledge-medium/pr-preview/pr-1869/src/data/localDbStorage.js\":\"2a4a2fe821db06f1\",\"/knowledge-medium/pr-preview/pr-1869/src/data/localDbVfs.js\":\"252e0630293f1528\",\"/knowledge-medium/pr-preview/pr-1869/src/data/localSchema.js\":\"f4c288d6b069a10d\",\"/knowledge-medium/pr-preview/pr-1869/src/data/maintenance.js\":\"42124cf00f80dce8\",\"/knowledge-medium/pr-preview/pr-1869/src/data/mergeProperties.js\":\"e0720244ccbef30a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/metricsConsoleHook.js\":\"ab5ffd91d63ff059\",\"/knowledge-medium/pr-preview/pr-1869/src/data/migrationsPage.js\":\"9f89fdcc35168347\",\"/knowledge-medium/pr-preview/pr-1869/src/data/mutators.js\":\"250f00ce2fea071b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/orderKey.js\":\"edc18a6dd40ba697\",\"/knowledge-medium/pr-preview/pr-1869/src/data/orderKeyPlacement.js\":\"233440c47c543891\",\"/knowledge-medium/pr-preview/pr-1869/src/data/outlineSurface.js\":\"c53a42a5bb20a876\",\"/knowledge-medium/pr-preview/pr-1869/src/data/pendingEditorContent.js\":\"de511e40829ffd26\",\"/knowledge-medium/pr-preview/pr-1869/src/data/pendingUploadsSql.js\":\"55d2eefdc1456471\",\"/knowledge-medium/pr-preview/pr-1869/src/data/pluginStateExtensions.js\":\"a4ac00a703c58b5e\",\"/knowledge-medium/pr-preview/pr-1869/src/data/powerSyncLogger.js\":\"c622be06ecf422af\",\"/knowledge-medium/pr-preview/pr-1869/src/data/projectorRuntime.js\":\"28a022efe0aca13c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/properties.js\":\"5b18d1b6d28dd9c2\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertiesPage.js\":\"044cb4487fabd27c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertyChildren.js\":\"42fc0c3ab532495a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertyDefinitionFanout.js\":\"6eace90dec51b10e\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertyDefinitionMetadata.js\":\"a9b222fdf32d32ff\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertyDefinitionRegistry.js\":\"48f343b8dcd89f75\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertyDisplayMode.js\":\"e768c5ef5c0fc38b\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertyRowCreation.js\":\"1b65e61910a38359\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertySchemaCreation.js\":\"2eff939dc0873965\",\"/knowledge-medium/pr-preview/pr-1869/src/data/propertySeeds.js\":\"2429caba80100ccd\",\"/knowledge-medium/pr-preview/pr-1869/src/data/recentsPage.js\":\"d152218f700ca9aa\",\"/knowledge-medium/pr-preview/pr-1869/src/data/referenceBlock.js\":\"e4c5f86030095f50\",\"/knowledge-medium/pr-preview/pr-1869/src/data/rejectedUploads.js\":\"0706da06bd7642c6\",\"/knowledge-medium/pr-preview/pr-1869/src/data/releasePowerSyncConnection.js\":\"e66eb56f286094ab\",\"/knowledge-medium/pr-preview/pr-1869/src/data/repo.js\":\"5a41607324fff742\",\"/knowledge-medium/pr-preview/pr-1869/src/data/repoProvider.js\":\"b01c9f1ecf358c6a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/rowProperty.js\":\"a5bef2ead408e2ab\",\"/knowledge-medium/pr-preview/pr-1869/src/data/searchFilter.js\":\"e8105a4d1f468391\",\"/knowledge-medium/pr-preview/pr-1869/src/data/seedIdentityLedger.js\":\"11e8aa4d0b8d489d\",\"/knowledge-medium/pr-preview/pr-1869/src/data/stateBlocks.js\":\"9c0b9c395832e998\",\"/knowledge-medium/pr-preview/pr-1869/src/data/structuralEditPolicy.js\":\"6163dfd88426d8f8\",\"/knowledge-medium/pr-preview/pr-1869/src/data/subtreeDelete.js\":\"bc2b54f41fe4b58c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/syncStreamLock.js\":\"bbb7f632b835253a\",\"/knowledge-medium/pr-preview/pr-1869/src/data/syncedTableSqlRecognizer.js\":\"3f5ca878f201f1ab\",\"/knowledge-medium/pr-preview/pr-1869/src/data/syncedTableWriteGuard.js\":\"d4e552d778dde127\",\"/knowledge-medium/pr-preview/pr-1869/src/data/targets.js\":\"e7ba47d1ce6048e4\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeColors.js\":\"900ca3966aa681c4\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeDefinitionMetadata.js\":\"672949c294a5239f\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeDefinitionRegistry.js\":\"2479e9a584184607\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeExtraction.js\":\"5a914db86f3d7bed\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeInitialValues.js\":\"927276f57a815e98\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typePropertyGroups.js\":\"7b434e1e9ed33f4c\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeSeeds.js\":\"4341920c650009ce\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typeTagger.js\":\"91ea4b8285980e49\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typedRecords.js\":\"b9cce20ee9425c94\",\"/knowledge-medium/pr-preview/pr-1869/src/data/typesPage.js\":\"30ad01b6af357e74\",\"/knowledge-medium/pr-preview/pr-1869/src/data/userPrefs.js\":\"7ac82ffac41fb34e\",\"/knowledge-medium/pr-preview/pr-1869/src/data/userSchemasService.js\":\"febde3117367ef99\",\"/knowledge-medium/pr-preview/pr-1869/src/data/userTypesService.js\":\"9651ea60538f7270\",\"/knowledge-medium/pr-preview/pr-1869/src/data/valuePresetRegistry.js\":\"947653a4c0185923\",\"/knowledge-medium/pr-preview/pr-1869/src/data/visibleChildren.js\":\"db7d1b32930112eb\",\"/knowledge-medium/pr-preview/pr-1869/src/data/workspaceConversion.js\":\"963cdd608fff09a0\",\"/knowledge-medium/pr-preview/pr-1869/src/data/workspaceFirstSync.js\":\"9b8e8fa93a0eecac\",\"/knowledge-medium/pr-preview/pr-1869/src/data/workspaceIdNamespace.js\":\"63cdbe8c50b7595e\",\"/knowledge-medium/pr-preview/pr-1869/src/data/workspaceSchema.js\":\"b6de405429ec84ae\",\"/knowledge-medium/pr-preview/pr-1869/src/data/workspaces.js\":\"ca2e3305e59a2572\",\"/knowledge-medium/pr-preview/pr-1869/src/data/writeAheadLog.js\":\"36173fd00204272f\",\"/knowledge-medium/pr-preview/pr-1869/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/BlockPasteShellDecorator.js\":\"07be3ebe3ed46c7f\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/atTrigger.js\":\"40515a001ff2a1c7\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/autocomplete.js\":\"c0b2064d36e981cc\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/codeMirrorExtensions.js\":\"1c834d69dd25a69c\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/contentFlush.js\":\"ed19d6be024cefeb\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/defaultInteractions.js\":\"de1a7356fc246f5c\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/editSettleSignal.js\":\"bf9c91ac1321e7ca\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/insertImage.js\":\"949b3636fdfdc8d7\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/referenceCompletionRange.js\":\"2939843c1900c427\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/referenceTargetTypes.js\":\"aa9541ca13d783f7\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/syntaxContext.js\":\"03257422e8646a3a\",\"/knowledge-medium/pr-preview/pr-1869/src/editor/triggerMatch.js\":\"c2ee5fda0bbbae4a\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/AppRuntimeProvider.js\":\"845770ddef7c3b1b\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/BlockFocusShellDecorator.js\":\"b0b4e2f4e14e7a5d\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/ExtensionRenderBoundary.js\":\"59a4655e722cb37a\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/PanelContentRecovery.js\":\"af99e70c42d26234\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/apiCatalog.js\":\"c3ae22dea213eeea\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/approveExtensionHere.js\":\"a4b5e55a0d0b021a\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/armedCutAppMount.js\":\"670b9965034ea7ae\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/batchableKeyedStore.js\":\"061e1e722ee25753\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/blockInteraction.js\":\"9c65e3199519f507\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/blockSelectionAction.js\":\"4d3ee1a04bf5e02e\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/compileExtensionModule.js\":\"a896c2617c133c3e\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/compiledModuleCache.js\":\"f151fe34a5f25ed3\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/continuousGestures.js\":\"e60544648bd9f195\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/core.js\":\"b42d6833e4000be5\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/defaultRenderers.js\":\"3c03854b82ede7f6\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/definitionFanoutAppMount.js\":\"c342d14255f870b3\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/dialogAppMount.js\":\"e39a93a0e45c2e8d\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/dynamicExtensionSeeds.js\":\"3dea04abebfd07f8\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/dynamicExtensions.js\":\"ffdd91c5e54a0aa7\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/exampleExtensions.js\":\"ab2fed6a285badb2\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/extensionApprovalStatus.js\":\"8fc1f65c6fb59afc\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/extensionLoadErrorToast.js\":\"1cee13084efd68fd\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/extensionLoadErrors.js\":\"b022078725ffab3c\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/extensionLookup.js\":\"b86a1c9b40cc2cd0\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/extensionToggles.js\":\"796a67c15b84c48d\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/extensionUtilitiesCss.js\":\"8636051e199a3219\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/kernelPageDeletionGuard.js\":\"d3bb8ca11f07497d\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/liveRuntime.js\":\"6aaa3f12061a51ff\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/openExtensionsSettings.js\":\"1fd70c2e7376d369\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/overridesCache.js\":\"ee5d929a954ef16f\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/pluginIds.js\":\"6e667dc8e17e466e\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/processorRejectionToast.js\":\"1f36b55600a93839\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/runtimeActions.js\":\"63c7272c0db7d9e7\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/runtimeContext.js\":\"3841f3555775f8cd\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/staticAppExtensions.js\":\"9df088aee0d33bae\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/staticDataExtensions.js\":\"9d14e6b1a7339c89\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/toastAppMount.js\":\"2f8a92a28368b203\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/useOverrides.js\":\"b4b92c730e9d5324\",\"/knowledge-medium/pr-preview/pr-1869/src/extensions/useShortcutSurfaceActivations.js\":\"d2ad870fbcb8464c\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/discoverToggleTree.js\":\"b8aca8edb5d24f7f\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/facet.js\":\"e9c0c0f27ce00921\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/resolveAppRuntime.js\":\"50d91951ffb27eca\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/runtimeEvents.js\":\"76c33d099ac8fcb4\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/togglable.js\":\"8cb81ae8994029eb\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/variantFacet.js\":\"f846ec83c2b555e8\",\"/knowledge-medium/pr-preview/pr-1869/src/facets/verbFacet.js\":\"e0482b5abd42cffd\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/block.js\":\"af9ed80cfdf0e53e\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/focusedChild.js\":\"e2e7afb1394a572f\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/propertySchemas.js\":\"b4c6ae0526c96c9c\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/typeRegistry.js\":\"f2aad26bfa0752db\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useAncestorCrumbs.js\":\"de73439efd0443ad\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useAutocompleteListbox.js\":\"ba3a20c082181108\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useDebouncedSearch.js\":\"522b357ad036db65\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useDebouncedValue.js\":\"ddccb95cc6626759\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useIsFocalRender.js\":\"3be165a9b51d8bf1\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useIsReadOnly.js\":\"2f036f3e62b523cc\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useMaterializeBacklog.js\":\"9b94fd5e2a6a788a\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useMinuteClock.js\":\"d8eeeb1ba5397c2d\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/usePanelLayoutProjection.js\":\"77ec10672ee0546f\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/usePendingInvitations.js\":\"6e3c83459b9649ae\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useRendererRegistry.js\":\"7cefb6e26e4ae125\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useRetainedFieldRows.js\":\"ac6eb8c668900d6a\",\"/knowledge-medium/pr-preview/pr-1869/src/hooks/useWorkspaces.js\":\"2d23d2986eb71d8b\",\"/knowledge-medium/pr-preview/pr-1869/src/lib/utils.js\":\"7910eb53e01cc797\",\"/knowledge-medium/pr-preview/pr-1869/src/main.js\":\"3b08b7017d26a26d\",\"/knowledge-medium/pr-preview/pr-1869/src/markdown/MarkdownImage.js\":\"e1579cfc3b9381fa\",\"/knowledge-medium/pr-preview/pr-1869/src/markdown/blockSeparators.js\":\"1f65c778100386be\",\"/knowledge-medium/pr-preview/pr-1869/src/markdown/context.js\":\"f0bfc6d4b0919d8e\",\"/knowledge-medium/pr-preview/pr-1869/src/markdown/defaultMarkdownExtension.js\":\"e9d244c81a1e811b\",\"/knowledge-medium/pr-preview/pr-1869/src/markdown/extensions.js\":\"28d0cb65ad2bd56e\",\"/knowledge-medium/pr-preview/pr-1869/src/markdown/renderMarkdownHtml.js\":\"86790eaa88301e09\",\"/knowledge-medium/pr-preview/pr-1869/src/minimal-editor.js\":\"218819b274b6ab9c\",\"/knowledge-medium/pr-preview/pr-1869/src/paste/armedCut.js\":\"2bc49bc5f4276289\",\"/knowledge-medium/pr-preview/pr-1869/src/paste/captureMediaVerb.js\":\"903bd9d8558560d2\",\"/knowledge-medium/pr-preview/pr-1869/src/paste/clipboard.js\":\"ce0bd5fb4d5dbcb2\",\"/knowledge-medium/pr-preview/pr-1869/src/paste/decision.js\":\"2fdff3ad6f08cf3b\",\"/knowledge-medium/pr-preview/pr-1869/src/paste/operations.js\":\"add5834590f672d3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/account-header/AccountHeaderItem.js\":\"e1a463bc2e851fe9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/account-header/index.js\":\"79b2e9783ca58a49\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"92cefc18a91c2f2f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/askAgent.js\":\"25b651d72d134924\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/askedStore.js\":\"5de6f5c545a0c85a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8d21fd9a323a8fcd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/chipState.js\":\"fbf373826c6ea96c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ad873031c515d455\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/index.js\":\"fe92a0ae11b4c88e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ad2470e721700c28\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-dispatch-companion/schema.js\":\"bd1b74bfc88d22ba\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e19c43e603bedadc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/BridgePairingDialog.js\":\"77d15b0041b76dbf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/addMedia.js\":\"932424568f22148c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c0d4aff3b83ccf8d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/block.js\":\"f55201adc6bbb6d4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/context.js\":\"525f65a167e1c837\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fb24333c47c2c242\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/index.js\":\"53fdd4c45edc4850\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/outline.js\":\"4ad25525140e94dd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/properties.js\":\"e3c6c72a769e6096\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/refs.js\":\"c0ad2ad7468e5a78\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2ec05ec8f10f7745\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/search.js\":\"bdcbd766375378b2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/shared.js\":\"33db8a6eb89bf994\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"68715aa2cfb35843\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentViews/text.js\":\"abe1ab7a78de9a27\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/agentWrites.js\":\"a20e953792433f50\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/authoringCatalog.js\":\"bcaec60d5e2d64db\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/blockRefTargets.js\":\"945d60553f8d34c3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/bridge.js\":\"00c67f21a07867b6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/bridgeLoop.js\":\"4df1fafc5d9134b5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/changeHistory.js\":\"9e93739f5fb8bd70\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/commands.js\":\"e08e7378cf7ef33e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/commentsCommands.js\":\"31ad83e20caf254f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/dataExtension.js\":\"36e474890ca25960\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/dataModelGuide.js\":\"239ec71bb49070cb\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/describeRuntime.js\":\"314ace2d83d12142\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/extensionLint.js\":\"bedb1b163a359027\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/grainAudit.js\":\"a7a75f93f6f3e167\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/healthCommand.js\":\"f14a765a9ae9fc9d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/index.js\":\"c9252f1421eabf13\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/presetIdentity.js\":\"bc4e5831ef14cf97\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f63e7d57677ef56a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/readMedia.js\":\"8cd0317a54b378f6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/schema.js\":\"c2f6124d10ac6166\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/serialization.js\":\"5d2d79c30da62114\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/targets.js\":\"665bc956414206a9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/tokens.js\":\"8968e43bfa7495c3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/watchEvents.js\":\"0f0b06f9ad1b1fbf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/workspaceGuard.js\":\"ad55d47e811b6755\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/agent-runtime/writeCommands.js\":\"57402086ea3dfda0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/AliasCollisionToast.js\":\"a70a0de49e61b108\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/DuplicateNameBanner.js\":\"9196325967b4bb15\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/collisionMerge.js\":\"c8da4174642bcf2d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/dataExtension.js\":\"51f1ab7ec2829704\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/index.js\":\"5d6b6e42e7752a9b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/mergeCollisionAction.js\":\"19251bca29470292\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/pageStyling.js\":\"36f622330661d9a1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/rejectionToast.js\":\"6fa783a4105048cd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/alias/syncProcessor.js\":\"0e0fe72dfa89e0c0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/actions.js\":\"3f935f87fbf72148\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/addComment.js\":\"6b5ae673de8ea3a1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/anchor.js\":\"ca2025bb5697273a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/anchorState.js\":\"c854c2e32117b079\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/commentLinks.js\":\"1ec28b8123f08933\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/confirmThreadDeletion.js\":\"90b47f65bdf93914\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/container.js\":\"fe415fbf92d627ac\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/dataExtension.js\":\"d0307f9d58fa114b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/deleteComment.js\":\"e1a2432c80f2b51f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/highlights.js\":\"372d979eb4858878\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/index.js\":\"9c5d43314f9c8721\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/linkedCommentsPill.js\":\"2a4b2830b44cf96c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/margin.js\":\"9bcef50d85cf0796\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/marginSchema.js\":\"b7c853436876772a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/newComment.js\":\"a7d8150e73a9640f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/ownThreadPicker.js\":\"9e3a7177c53ad393\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/placement.js\":\"a3f4da58301a5962\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/queries.js\":\"a7576110f60d9821\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/quotePosition.js\":\"dd405d611a4b0a36\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/quotedIn.js\":\"1c5da5185634a077\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/quotedRange.js\":\"82a0ca6967e98c44\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/rangeRefs.js\":\"dac946205ea2b294\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/readHighlights.js\":\"2a767d6acbc3369b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/readSelection.js\":\"6eee4d41485830b4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/readSelectionUi.js\":\"a3cf4be6fc3ddbe9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/reanchor.js\":\"b1f86314ca55c9e7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/schema.js\":\"00bae36fda00fafc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/scope.js\":\"b7c7b961dd52d06c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/scopeThreads.js\":\"02119a1a992d431d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/splitRetarget.js\":\"205455081b90c549\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/suggestionCard.js\":\"33c535b13e1501a0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/suggestions.js\":\"f195cfd3e2fd9074\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/summaries.js\":\"3538384157ff38d3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/summaryBatch.js\":\"e2d60396dac08382\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/surface.js\":\"f3d57bb94e1c9899\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/threadNavigation.js\":\"9002eba379577e3f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/threads.js\":\"4ccdeaa0563de6a4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/ui.js\":\"1f4b1f1c2b461218\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/annotations/uiStore.js\":\"d38a2e26f40362c5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/app-intents/appIntents.js\":\"94996fbde7d8cc50\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/app-intents/index.js\":\"56b80b82020bb56a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/app-update-prompt/index.js\":\"374674aa56531e4c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/app-update-prompt/status.js\":\"94083eae2141a1e0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ffe49bc46d0adb98\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/MediaBlockRenderer.js\":\"35cc18d00726ce0d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0f26c36f1cafe88e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/MediaUploadReconciler.js\":\"e71a25dd03482d69\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/assetDownLane.js\":\"08487db1e467bf13\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/assetResolver.js\":\"c4bee7707b923824\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/assetUpload.js\":\"b153623019ac95b6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/attachmentCleanerIO.js\":\"1b850b4dfcba2af4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/audit/supabaseAuditIO.js\":\"41f00c7c3f665052\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/blobStore.js\":\"1d9141597ea8dd1b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/browserMedia.js\":\"d7a117eb21b014cb\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/byteStore.js\":\"4467902bf7ac7078\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/cleanerIO.js\":\"74f978cc27760576\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/cleanupAttachments.js\":\"61ba3470a1ce3d2c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/dataExtension.js\":\"7a7fce8e9e1d1ff1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/downLane.js\":\"6e9f75f649487912\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/index.js\":\"0b65843e751e1f95\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/insertImageContribution.js\":\"62ce1e1996aef24b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/laneArming.js\":\"a9a3e855ec3d1fe8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/laneLock.js\":\"504e4ae09e31a203\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/mediaBlock.js\":\"292947511484666d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/mediaCapture.js\":\"5e36b528d608603b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/mediaLanes.js\":\"7a8f9237ac866510\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/mediaViewers.js\":\"166245d40e8f31ea\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/mediaViewersFacet.js\":\"129a52be2f5a42e5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/pasteCapture.js\":\"b80c11a22defa8d9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/resolver.js\":\"5c643bd04d9b0cce\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/retryUploadsAction.js\":\"a277244c59a1ff03\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/storagePaths.js\":\"afedd2288e763c9a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/uploadDrain.js\":\"58301e506760f662\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/uploadLaneStatus.js\":\"9b796faa54915d95\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/uploadReconcile.js\":\"a2da9dd2b9215bb9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/uploadRecovery.js\":\"e1d44a5bec13a8a4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/uploadStore.js\":\"4844cca0d2c7ea94\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/attachments/useAssetObjectUrl.js\":\"ba2c0ace0b8b6c0b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3efd3f4490179b53\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b38565c9cc096036\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks-view/facet.js\":\"eca4ccb1346769e8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks-view/index.js\":\"87035cef55e9d597\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks-view/prop.js\":\"a654f431837426dc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/BacklinkFilters.js\":\"eed02b562913e64b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"76d394655e75d4fd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/BlockEntry.js\":\"8fd1c0b44ddf61bf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/LinkedReferences.js\":\"1a46e8faaa11ef02\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"30cfa56aba3c055e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/dailyNoteDefaults.js\":\"6fd3bdcb4844dfd1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/dataExtension.js\":\"9f49e7887356e970\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/edgeExclusions.js\":\"3dc2b0b0088431dd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/filterProperty.js\":\"ab09cb5bfa51e31d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/index.js\":\"69865a6f091b0df2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4f2fec3cfbb1bd1a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/inline-counts/applies.js\":\"74df25642b891280\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/inline-counts/countQuery.js\":\"0536566393261c3e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1c71e51e52876f03\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/inline-counts/index.js\":\"842f9209ad06a0be\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"78410aed37256c32\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/presentationInvalidation.js\":\"5051a8b593fa8db6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/propertyEditorOverride.js\":\"f7b758fb7f747a95\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/propertyFilter.js\":\"6d96f4e81fda5440\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/query.js\":\"9b3c5116c8249556\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/resolveFilter.js\":\"f6c3e14d8c1c9d85\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/sourceBatch.js\":\"eb709a64264d120d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/sources.js\":\"5dfe217b29436719\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/useBacklinks.js\":\"dfb79525401c919f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2b5f15d4cc6ab584\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/birthday/BirthdayCelebration.js\":\"c29a1c82febf52f4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/birthday/BirthdayOverlay.js\":\"e5e69a951aa482c9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/birthday/gate.js\":\"62792befe0843965\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/birthday/index.js\":\"c438410f982ca1fc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/birthday/wolfTheme.js\":\"00121eabd7a44939\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-drag/BlockDragLayer.js\":\"6bd36baad893113b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-drag/dragController.js\":\"f8e5927564b1b899\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-drag/dropTarget.js\":\"78a524c2305f547e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-drag/index.js\":\"6e0bfb7cdd216da4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-drag/projection.js\":\"e2e0e5c0159165dd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-info/BlockMetaCard.js\":\"23294fbfa9d6e73d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-info/index.js\":\"84b00a91352a79e6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/AddTagDialog.js\":\"92ffb02e6dedd511\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ab90483d55789710\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/TagNameIssueHint.js\":\"62cab5053bd302c9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/addTagAction.js\":\"1df3986b853d27b5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/appendTag.js\":\"3e0d4c288eca6982\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/config.js\":\"d5701ae51645a000\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/dataExtension.js\":\"01258e5a63539b47\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/index.js\":\"f91f62336f4ffcb4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/block-tagging/propertyEditorOverride.js\":\"5425825b1d4b539f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/BreadcrumbList.js\":\"12463bfb667bdd7e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c718a2f513838f47\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a5bbe10f07873108\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5f7d9b7884969d4d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8691bada2cc40c7d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/index.js\":\"db9145f4a2864648\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c9cb4b080b4707c5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/CharacterCountItem.js\":\"bb0f57498b280986\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6255b2038927775b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/actions.js\":\"ef64343872b123c9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/blockType.js\":\"0842e8d34eac9285\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/charCount.js\":\"adcc798bd1765880\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/dataExtension.js\":\"c72434a843fc9857\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/index.js\":\"ffdfb3309390e174\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/profiles.js\":\"28324e1d3ebd00b1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/properties.js\":\"ab3b54d3b0712cde\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/character-counter/textCounts.js\":\"1a98505414af0677\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/colemak-keybindings/index.js\":\"4a4101b241d30463\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/CommandPalette.js\":\"cfe292016049c8d8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/HeaderItem.js\":\"0c6feb9cdab0ee9d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/context.js\":\"d10524ff417fdc83\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/index.js\":\"1b07bce36635fb54\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/selection.js\":\"46d0597195f88320\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/toggleStore.js\":\"3f3b36a65e77a158\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/command-palette/useCommandPaletteActions.js\":\"420e440f781bb5cf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/ContributorBadges.js\":\"da75b826af6a7139\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/author.js\":\"1c69a24479f05eff\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/codeMirrorExtensions.js\":\"9695d1854e7dd09c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/dataExtension.js\":\"21278a6a424ba77a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/index.js\":\"bc72f9cd9c4b9d2b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/mentionAutocomplete.js\":\"fafb844b6e9d3f5c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/processor.js\":\"eb4f0b769acec30d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/profiles.js\":\"9e9907d4d00ceb14\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/queries.js\":\"8786bb5604d182b8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/contributors/schema.js\":\"cbbb3f3a966d0bb9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2ed32265418b2afb\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f67249f569622ef2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/cursor-follows-scroll/index.js\":\"fe157c9e678b2387\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"17814ea04ef37af8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7b935cc39dd223f0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/CalendarGrid.js\":\"a4533fd963458725\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/DailyNotePicker.js\":\"69585df549bad649\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d8d927962485f787\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/DateNavDecorator.js\":\"d19f00814d0db850\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/DateScrubOverlay.js\":\"f3c1a8fa9ed6156e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/HeaderItem.js\":\"566ac004e38751fe\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/ReschedulePicker.js\":\"228b4a0eb7f2a339\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c1100506ee7221ce\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/actions.js\":\"547a29095bd1111c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/blockDateAdapter.js\":\"ecc2d31a9551c045\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/calendar.js\":\"9294de85481657f0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dailyNotes.js\":\"e32a990672e98a82\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dataExtension.js\":\"b497bc7938852cee\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dateScrubActions.js\":\"2dee9b7db5019fba\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dateScrubGesture.js\":\"ed32197db110ba22\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dateScrubGestureActions.js\":\"734a9e24dae7b23d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ec6419ad13d0a2cd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/deletionGuard.js\":\"52c21d10084c7357\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/dueQuery.js\":\"2b54fbd382222452\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/index.js\":\"bcec1bfd2829a5d3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/landing.js\":\"fe9c76f1349a1c67\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/localSchema.js\":\"89c1ac83e00e460a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/referenceDateAdapter.js\":\"439d956feb19dace\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/rescheduleAction.js\":\"1d57e188259304c1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/schema.js\":\"b027c42349dfd52d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/spreadBlockDates.js\":\"82aab01a6b7c4457\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/spreadDatesAction.js\":\"c69cbc029e569a47\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/today.js\":\"60eb15b011363eaf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"62c65a1f1acb5b9b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"53da79b7029719b3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/audit.js\":\"3dd86c1d2b54190e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/auditAction.js\":\"c11e421dbf26cc74\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/auditRanges.js\":\"10a5589ba7d5cb20\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/diagnosticsSource.js\":\"715eb4347049c0fd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/divergenceScan.js\":\"5ae570889ee22369\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/index.js\":\"0b33b56db25f42ef\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/propertyChildrenChecks.js\":\"29ade31d70449a51\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/referencesMirror.js\":\"ad106dd042badb41\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/rowJson.js\":\"9f96fe859f68b788\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/schedule.js\":\"3f693c12c6b2099b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/data-integrity/store.js\":\"96db8fc06565cbc4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-maintenance/action.js\":\"841827f064c20374\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-maintenance/index.js\":\"7bb94fd36ae2a385\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-maintenance/plugin.js\":\"796171950ffe9210\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dc4a2d4e10dc7b06\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/actions.js\":\"4a3ee32f5128b4a1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/changeMarker.js\":\"adc8ff280e511dfe\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/diagnostics.js\":\"721f02066f17df35\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/fileSystemAccess.js\":\"f7c02acf394174ed\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/filenames.js\":\"a8f57c25a64978c8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/index.js\":\"86d07481bfb1c52c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/mirror.js\":\"2a9f2fff035cf619\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/runLock.js\":\"e760a0f2eee1fc68\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/runtimeHealth.js\":\"6703472b9adcb9ee\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/schedule.js\":\"41d4ff14eec4ccff\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/db-mirror/store.js\":\"b30b2039ee25fb63\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/default-themes/index.js\":\"e3f3812e06197e44\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/default-themes/themes.js\":\"a4c67a4997641806\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/diagnostics/facet.js\":\"f79d2bb24f6f69bd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/diagnostics/useDiagnostics.js\":\"1b3d4c6ae606341c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extension-prompts/dismissals.js\":\"6168503f5a00abab\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extension-prompts/index.js\":\"dbcf71beef356bcc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extension-prompts/status.js\":\"52ae17506e3036f0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extension-prompts/store.js\":\"2fd3d935980729ad\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e35fb5ce0d861bff\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/ExtensionsSettings.js\":\"644d04cf9bd24333\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/actions.js\":\"53170a0b4f4e67aa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/config.js\":\"72c9cd906d69ca12\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/dataExtension.js\":\"6b03859abe1d5b43\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/effect.js\":\"ca69df5f07e3bd23\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/index.js\":\"158c94c8135d79a5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/propertyEditorOverride.js\":\"830e78cb7f0d4b45\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extensions-settings/useToggleTree.js\":\"d069d616bc447675\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extract-type/ExtractTypeDialog.js\":\"3fdfdfb072ac24cb\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"98b66b1a8ddf83b2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extract-type/PropertyShapePicker.js\":\"95a2d17b6315b8ad\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extract-type/action.js\":\"63eec261af8b95bc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/extract-type/index.js\":\"bf1b0e4bf5102917\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/FindReplaceDialog.js\":\"2e58de6625150119\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/HeaderItem.js\":\"ea0dc18c3f57789b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/dataExtension.js\":\"50f99557f951a9cd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/index.js\":\"5c69fce21ff0b27f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/search.js\":\"b3a03cdd31c327dd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/toggleStore.js\":\"076e0d11b24b0ca0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/LocationPropertyEditor.js\":\"8c2d837314abd2b2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/MapView.js\":\"dff4776d86aa937b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/blockTypes.js\":\"3d6efc60f55d512b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/codeMirrorExtensions.js\":\"3a1d114557d03ded\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/createOrFindPlace.js\":\"f4e283ae3efadce7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/currentLocation.js\":\"e9975c0b8556621a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/dataExtension.js\":\"39c76d254d5b16ed\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/geoContentDecorator.js\":\"169fc6a5936e8c82\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/googlePlacesClient.js\":\"3423e2530acbe693\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/index.js\":\"7275d8441fed0863\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/locationsPage.js\":\"e714f5f4f35d98aa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/mapViewport.js\":\"acafe8649e3e91ee\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/pickCurrentLocation.js\":\"fc0df4a56416a7c1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/placeAutocomplete.js\":\"98eba7d5fa0cf6f5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/placeNameCollision.js\":\"9dcf95c2554d5c2b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/properties.js\":\"348d82c3682b35d7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/propertyEditorOverrides.js\":\"dffd9d671736373a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/query.js\":\"e78a4849cb489bb8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/geo/usePlaceSearch.js\":\"c40461dbf34d386a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"01cb4f292aa53802\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"55922a8f17497a75\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"72837b9ab484edfa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/config.js\":\"a49dfdf2e82a3f29\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/dataExtension.js\":\"ecac26b3ff40d058\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/facet.js\":\"1c93f6dd925add44\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/grouping.js\":\"df47fbdbedd0ef19\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/index.js\":\"5ec9c27a4d1e0bc0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1db0ac874c55afed\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/query.js\":\"64db01436e761398\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/resolveConfig.js\":\"596792e605e68755\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"35216fff54fd1e5f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"0e44f230cd6c78a6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/HtmlDocumentContent.js\":\"d66696c82cc9092b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/HtmlFrame.js\":\"b0a18ae00df7a013\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/actions.js\":\"ed2233e83dcfd777\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/blockType.js\":\"b59ba883b0a482b4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/confirmRunScripts.js\":\"f49815f234254857\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/dataExtension.js\":\"946d48ba007d5c82\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/frameAnnotations.js\":\"1045715d459298cf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/frameDocument.js\":\"a3e9d78acde75ca4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/frameTheme.js\":\"cc96778ba6e43b9e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/index.js\":\"dd5e805b53804c69\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/scriptConsent.js\":\"41ce59076a763887\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/sourceMap.js\":\"799facc3e6770a1a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/html-document/useDocumentScripts.js\":\"dbe68292561fda70\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/interaction-metrics/index.js\":\"c36e1286d98fdb48\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/interaction-metrics/record.js\":\"77c4975c04f11cc5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/interaction-metrics/recordStore.js\":\"3e522c5509b334de\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/interaction-metrics/responsiveness.js\":\"6c3a54c0946894a9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/interaction-metrics/schedule.js\":\"811555c5509073aa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/interaction-metrics/sessionContext.js\":\"14d578b248b8fca2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7e697bb0aebf4d67\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ee1b425a28b437fd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/actions.js\":\"79ff87c944bf1c80\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/config.js\":\"b44684fe90c2393a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/dataExtension.js\":\"4186ede0d35abc9a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/effect.js\":\"61ff7f3ed062dafe\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/index.js\":\"025caba2a1c313b7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/keyCapture.js\":\"1776dbaa6e152064\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/overrideStore.js\":\"d9f5eae0d6b997e2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b179e14f9c2ab5a7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/HeaderItem.js\":\"1affb09433d13aa3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/LeftSidebar.js\":\"7d24267906991512\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/actions.js\":\"209f5422d421be0f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/facet.js\":\"d63f945c60b7fff4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/index.js\":\"5a0fc5bb340e19b8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/shortcuts.js\":\"a5f4490195379532\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/left-sidebar/toggleStore.js\":\"a22bcc5b0581a9d3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/merge-blocks/MergePicker.js\":\"02cbe2dfce3215f9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/merge-blocks/index.js\":\"a72450a1a5bd191f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/merge-blocks/mergeAction.js\":\"015d319d55b7dac0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/merge-blocks/strategy.js\":\"fbdf331323865233\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-bottom-nav/Button.js\":\"9a24e7cd64b977ee\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9fb9f2554c56de57\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d25cd097e5f17e11\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-bottom-nav/facet.js\":\"2f6a9d34408dcc7e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-bottom-nav/index.js\":\"bb57004281e07eee\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"196ec5b5257e3215\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-keyboard-toolbar/actions.js\":\"39aa413ebdfdcefe\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"52602ced244ff3f6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-keyboard-toolbar/facet.js\":\"340fa9d8b3b4a960\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/mobile-keyboard-toolbar/index.js\":\"96c7d1078c3f5d49\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/MoveDestinationPicker.js\":\"cd03807b9b5f77fa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d49ab0f05aed43d2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/contextMenuItem.js\":\"2e4fa53374585a74\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/index.js\":\"ef1de189b649ae75\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/moveAction.js\":\"ca6f23837a8cad6d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/moveBlocks.js\":\"968b9b89913e5275\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/move-blocks/selectionAfterMove.js\":\"7d18128c05a367b5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/TutorialBanner.js\":\"966dbcf6e515c35d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/action.js\":\"fb3b4e143acdfc77\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/bannerDismissal.js\":\"b574b5c43a966547\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/documents/cheatSheet.js\":\"c19bae5c6307f054\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/index.js\":\"35889ff4e9c25a1b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/keys.js\":\"64a747ebafa8967f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/landing.js\":\"e53ef160baad07ea\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/outline.js\":\"09d44f6ded1d34a1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/onboarding/seed.js\":\"2af369317f7451e6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/PerfTrendDialog.js\":\"53467107d90359a2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/analyze.js\":\"02e5cacd1733a7aa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/diagnosticsSource.js\":\"4f8134f21bcf15e5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/index.js\":\"8161b5ca762f5fc7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/load.js\":\"c133786f8351e088\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/monitorRun.js\":\"37c53474d7669771\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/schedule.js\":\"ec3f8c292302fb8b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/series.js\":\"2b74f7947aa620ad\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/store.js\":\"8c05231a29c16cdc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/trendAction.js\":\"df576e91a762e6d8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/perf-monitor/verdict.js\":\"2e3c8f2b7acac291\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/plain-outliner/clickToEditAction.js\":\"c908416634b1fa95\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/plain-outliner/index.js\":\"1266033074e51950\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/plain-outliner/interactions.js\":\"ea7ee46d42caa14d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5f930f8b4654aec9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/MigrationGate.js\":\"19c00385b8f44eed\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/MigrationGateDialog.js\":\"a7dd0ff4396bd151\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/action.js\":\"b7457df5e7b98c05\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/index.js\":\"f66b97a8df196968\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/localRunMessage.js\":\"9e41ab42d54bc041\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/plugin.js\":\"529686f245855641\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/progressReport.js\":\"845cfc7456c25fb4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/properties-migration/sweepProgress.js\":\"2e7d24257b67cae7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/FieldRowRenderer.js\":\"dfe9176dd152d93a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/ValueRowRenderer.js\":\"be1b02bdf605d5af\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/actions.js\":\"18b8aaad52815b5f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/autocomplete.js\":\"b197d2e17c8aba6c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/fieldRow.js\":\"cdffd71416af2790\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/index.js\":\"d3dec9a4a7567121\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/referenceWarning.js\":\"858d368bdbb488d2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/valueAutocomplete.js\":\"cf546763d4594597\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/property-rows/valueSchema.js\":\"71153e379d284425\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/HeaderItem.js\":\"f2e3654a0a61d88c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/QuickFind.js\":\"a71615c9845b82c1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/index.js\":\"9e5cd0349df68a26\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/recents.js\":\"cb7336f055960a8d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/resultItems.js\":\"3e14ca552f774216\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/selection.js\":\"7a6df17b19b01b33\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/quick-find/toggleStore.js\":\"2a4b9971b506609b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/recents/HeaderItem.js\":\"a00b6241bc67a4ef\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/recents/RecentsPageBlockRenderer.js\":\"672125e30bad47af\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/recents/grouping.js\":\"c657350b72f0c032\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/recents/index.js\":\"794c23be17579a51\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/recents/target.js\":\"c09e9e96aef62ec0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/codeMirrorExtensions.js\":\"2bc991780127e62b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/contentPrefill.js\":\"7db35a5d389bc5c7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/dataExtension.js\":\"97658e428410110a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/index.js\":\"d5763b848d8937ec\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"88afdb17ed37d683\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/invalidation.js\":\"6f73f042dfc00428\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/localSchema.js\":\"6242fb9b72904b62\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/blockrefs/index.js\":\"4eb54cd8fedd7501\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b9dd4d272a781ea0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/index.js\":\"e34ecd82d89e5300\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/referenceNode.js\":\"5d7acce15d76e2b0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b0c708d15c760d63\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8f69375a8799ddda\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/wikilinks/index.js\":\"13efdadf9cd4ec31\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"30f86774a134e68f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7cac25df5da279b3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/mergeRetargetProcessor.js\":\"b94c1814be3593f2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/parseFence.js\":\"d6e0591382144c4e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/referenceParser.js\":\"5fb70dfb30a8cfec\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/referenceProjection.js\":\"8b51e04c2f0c584e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/referencesProcessor.js\":\"ecb1d8adb3ef6ca4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/renameProcessor.js\":\"f5f0c7c41cb6cd87\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/references/spanReplacement.js\":\"5b559debee34d81c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/rich-paste/htmlToOutline.js\":\"cd4978c2d3537be2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/rich-paste/index.js\":\"f3d8f356369baae9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5da21aa2165685b2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/rich-paste/pasteDecision.js\":\"5d4f8de64758c0cc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/action.js\":\"d804cc30d5980baf\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/blockIds.js\":\"122681e3ded5d32b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/content.js\":\"71430f2d0053df7d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/effect.js\":\"969489c6f171998f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/ids.js\":\"b822c73d010a8dfd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/import.js\":\"842eeb13786d29da\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/index.js\":\"a1f8da6eaca8217c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/plan.js\":\"8eb6a2c9e62e9b30\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/plugin.js\":\"7e2995c4b261b357\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/promotion.js\":\"a6c0782ca32381d9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/properties.js\":\"c135982588e3440d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/references.js\":\"002fb1a8b56f03fa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/report.js\":\"b236b74e6b9017cd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/roamMemo.js\":\"e4ef8d9bd2e5bc1c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/runtime.js\":\"ad2ae29287751cea\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/schemaReconciliation.js\":\"83d13186f3d50499\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/srsMarkers.js\":\"1498cd96c92cd81b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/todo.js\":\"5f77283518109137\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/typeCandidates.js\":\"9c2c8dbd7a663d75\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/roam-import/types.js\":\"93ed7f94a6491dd9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/search-health/index.js\":\"38bec367fca2da43\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/search-health/store.js\":\"24a3a3c6b4d600f7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/shortcut-help/HeaderItem.js\":\"37f672bfca7f9b6e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1a2f59cb454ea3c1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/shortcut-help/index.js\":\"c7eaa9f031fd9d8f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/shortcut-help/model.js\":\"6eaa22c33c9cd16d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/shortcut-help/toggleStore.js\":\"abb047396c7e8880\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/shortcut-help/useKeyInspector.js\":\"82738757d0a5d79a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"77e8618ef2c77146\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/ShellDecorator.js\":\"f01cd10a54069c6f\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/actions.js\":\"95d4fe043064d5be\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e4d5e965876bcde1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/index.js\":\"62c12e1a6a3d3fd6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/shell.js\":\"61486cd295c879aa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/surface.js\":\"eb46513553546ce4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/spatial-navigation/walker.js\":\"5c0586aa2cda2d37\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c7aba052db6a7961\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/dataExtension.js\":\"9b716401a604cfca\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/index.js\":\"2ad89dd96adadbaa\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/indicator.js\":\"97792ede9edceffe\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/moveSrsState.js\":\"087d316e0ae8e6a9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1abf06c470085a64\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/scheduler.js\":\"3fca0f28619bc6f2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/schema.js\":\"fdba8fc22a439f42\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"37afc3dee0921d74\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/srsClipboard.js\":\"cfed31ffa34a2914\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"67c8043ff7b63994\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5ec0d65d29ea66eb\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/DeckPicker.js\":\"d36b6729102c7a79\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/ReviewControls.js\":\"9788ea663e681c71\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7308041a0a068bb2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/ReviewSession.js\":\"69b99eeb29dfb583\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/actions.js\":\"69372a83b8101859\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/archive.js\":\"7bc31c31048704a0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/dataExtension.js\":\"22df2dc95f486dd4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/deck.js\":\"89c6593a8fa1c464\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/dueQuery.js\":\"9f720e3eaea7eb95\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/gradeDecision.js\":\"f9dfd04244007d55\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/index.js\":\"2534817114aaebff\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/keyHints.js\":\"1a59feb898bdd5e4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/reviewCardLayout.js\":\"362de993d5ba89b6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/reviewProgress.js\":\"791a575080c28086\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/schema.js\":\"4bbbeb6bbca660a1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/srs-review/useDueCards.js\":\"4f66be79e786ecfb\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/startup-metrics/index.js\":\"3737d472cb5629cd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/startup-metrics/record.js\":\"407a48eba7ce1d62\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/storage-persistence/index.js\":\"bf7f66cfd9e8bc52\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/storage-persistence/persistenceStatus.js\":\"ecfd8c881a7fd419\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/storage-persistence/requestAction.js\":\"d06114faf89251e1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/supertags/TypeChipsDecorator.js\":\"1016c2a167dbd387\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/supertags/codeMirrorExtensions.js\":\"b236cb7e0d5a2cb0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/supertags/index.js\":\"c44335d0c6bd458c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/supertags/typeAutocomplete.js\":\"73e5bb1fd89faeed\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c2f8416a2aef0213\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/actions.js\":\"ed1c5621d87c65f1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/anchor.js\":\"b369ac1af57c22e9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/events.js\":\"3519c40a631b9ac8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/gestureActions.js\":\"fb7bad67eeafc228\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/index.js\":\"2e6edaaedaef66a1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f61ab66b7e220b6b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/sync-metrics/collect.js\":\"55cf73ee4bf5aafc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/sync-metrics/index.js\":\"89b333f1d88439ad\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/sync-metrics/record.js\":\"242a8c0b04dacec2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/RejectionDialog.js\":\"59feefa43bcc8402\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c3bb9af9edc8cb01\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/index.js\":\"13876e1cd79ea02a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/model.js\":\"ead4fc6b75c4dbc9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/queueCounts.js\":\"505b1fe03d3332b2\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/rejectedHelpers.js\":\"c92489ae2bd70079\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/rematerializeAction.js\":\"8709aaf1d8d94bd1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/system-status/useHysteresis.js\":\"5064d670988b6e22\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/ColumnHeaders.js\":\"089a91111233b456\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/QueryUi.js\":\"4673bfb4ce2ff9c1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/TableLayout.js\":\"a46391d4d696f3e5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/actions.js\":\"b0a0ca06a1503423\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/cellEdits.js\":\"45fec96df0406de5\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/childrenViews.js\":\"6ab657da55ccab6a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/columns.js\":\"e03dfe1e3a97f7c7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/controller.js\":\"3b7581f6f4c5cb7d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/convert.js\":\"3a7e635a26ab8c7c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/dataExtension.js\":\"5071295b4e6b5476\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/index.js\":\"26424e7b0d38efe0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/keys.js\":\"20335dff3f9e659b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/model.js\":\"219ef7aebfbcf18e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/navigation.js\":\"400aa2c409dbbd6a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/query/backfill.js\":\"d1a77ecb018ce40b\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/query/completion.js\":\"44ac23db75cea163\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/query/format.js\":\"9b328a2c696e6441\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/query/parse.js\":\"7dc9df1222f4bb74\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/query/queryValue.js\":\"c1a83d9815f1a86d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/query/source.js\":\"4d14e895625a150a\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/registry.js\":\"b0197c27956bc867\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/rowGutter.js\":\"b2b080005a1dd23e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/rowVerbs.js\":\"b20f1e4da94bd3b7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/schema.js\":\"73bf29bf847f98ce\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/tables/sort.js\":\"d87ed7efae2b92bd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/theme-toggle/effect.js\":\"6f6df6c9c76c12f3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/theme-toggle/index.js\":\"53a55768a263cf9e\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/theme-toggle/theme.js\":\"0866f983347f893c\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/todo/actions.js\":\"f8a8f38e8d0e8a26\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/todo/dataExtension.js\":\"5d80f9e7f524e9a8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/todo/index.js\":\"4b5c4ca9459b0cae\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/todo/schema.js\":\"21fbee78d7d810dd\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f75f723b1a4f7276\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/touch-selection/actions.js\":\"efc460531c83a5e0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/touch-selection/defaultItems.js\":\"c3d35e7205645ef3\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/touch-selection/facet.js\":\"7e5a4e18816f83fe\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/touch-selection/holdRecognizer.js\":\"7a181e9cff4d51a7\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/touch-selection/index.js\":\"ffe6ef8487e2cfff\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/update-indicator/UpdateIndicator.js\":\"5291208fa5d8ac84\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/update-indicator/index.js\":\"8884f4cb0be9ce66\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/update-indicator/loadTimes.js\":\"5087e08dc0dfcca4\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/VideoNotesRenderer.js\":\"95482990067b5d90\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/VideoPlayerRenderer.js\":\"77e22cf73a4edcf8\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/VideoTimeStamp.js\":\"64ebfb97f606cfb9\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/actions.js\":\"9775923ca671b4d1\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/index.js\":\"dee138d2492f1b34\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/markdown.js\":\"9b7dbf7ad189426d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/notes.js\":\"26f4dbcf9c6641fc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/registry.js\":\"0ed2ddf6a3319673\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/remark-timestamps.js\":\"1173704b2de95e1d\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/video-player/view.js\":\"054930f5ada2cde6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-link-hints/LinkHints.js\":\"ad1b1d69a019ad70\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-link-hints/index.js\":\"9db2523faa2aef99\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-link-hints/model.js\":\"5dd7b42c5a872ed0\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-link-hints/settings.js\":\"0284903922a113fc\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-normal-mode/actions.js\":\"34320dbdb7eb36ce\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-normal-mode/index.js\":\"1a139c759a21dc87\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/vim-normal-mode/interactions.js\":\"f441c1e4f159b8c6\",\"/knowledge-medium/pr-preview/pr-1869/src/plugins/workspace-header/index.js\":\"63a08d99be5844da\",\"/knowledge-medium/pr-preview/pr-1869/src/registerServiceWorker.js\":\"ef197d518381e809\",\"/knowledge-medium/pr-preview/pr-1869/src/requestPersistentStorage.js\":\"9904aedc33e12582\",\"/knowledge-medium/pr-preview/pr-1869/src/services/authRequestDeadline.js\":\"c24bb7602a0cb26e\",\"/knowledge-medium/pr-preview/pr-1869/src/services/authStorage.js\":\"4fe5d0924d5b2c7e\",\"/knowledge-medium/pr-preview/pr-1869/src/services/powersync.js\":\"88bb6fdf42d32e71\",\"/knowledge-medium/pr-preview/pr-1869/src/services/supabase.js\":\"ed53a1237bd02fe5\",\"/knowledge-medium/pr-preview/pr-1869/src/services/uploadErrorClassifier.js\":\"27fa1afcb6393898\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/ActiveContexts.js\":\"3975968a7ca98255\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/HotkeyReconciler.js\":\"96e3079da67ccb36\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/WipeLocalDataDialog.js\":\"0b303d14c079114e\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/actionDispatch.js\":\"ee0d371b396f07e3\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/actionRefItems.js\":\"05d5c0b7c97eb362\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/applyKeybindingOverrides.js\":\"1bbc075082bfac5c\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/blockActions.js\":\"05e6d27521997d03\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/blockMergeGesture.js\":\"b65bcb93a895249a\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/canonicalizeChord.js\":\"ba698623d3f32208\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/defaultContexts.js\":\"dfb229c2351a060a\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/defaultShortcuts.js\":\"4e65695d5809a0aa\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/effectiveActions.js\":\"65aab7da7609728b\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/gestureAction.js\":\"8798bebc1634aa57\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/gestureBinding.js\":\"d2921a2ac8faf173\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/holdRegistry.js\":\"fb17a607411d27b2\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/keybindingConflicts.js\":\"337df7bfd6322d9d\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/keybindingOverrides.js\":\"f991031c94a72843\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/pointerAction.js\":\"3a347aae37af0ffc\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/resolve.js\":\"96058fe649bf8173\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/runAction.js\":\"6fadb52205875c26\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/sequenceMatcher.js\":\"a9fc70a5c5f7cea8\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/types.js\":\"37ccb12d7476354c\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/useActionContext.js\":\"ed0eab98a994e855\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/useActionDiscovery.js\":\"097fd0f6670f493f\",\"/knowledge-medium/pr-preview/pr-1869/src/shortcuts/utils.js\":\"8cbf3c7d52d89a3c\",\"/knowledge-medium/pr-preview/pr-1869/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1869/src/sw/bootStore.js\":\"81b1d6586504d6e3\",\"/knowledge-medium/pr-preview/pr-1869/src/sw/previewDatabases.js\":\"4cf6e171c606de21\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/byteTransform.js\":\"db46ff7cb5d7f978\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/attachmentCleaner.js\":\"a7ab43c937650576\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/bundle/attachmentParts.js\":\"c32194a869d4d246\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/bundle/bundleParts.js\":\"b4cdf341e1f478c4\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/bundle/bundleRecord.js\":\"25d9927b8471d7a2\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/bundle/manifest.js\":\"9f4818f36d399b3d\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/bundle/takeBundle.js\":\"2e6a32e0f541e0d4\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/bundle/verifyBundle.js\":\"fc039751aed57cd4\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/cleaningStage.js\":\"b31a3a5e890c1003\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/conversionKey.js\":\"3847fb4fe5c43d40\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/conversionServer.js\":\"a63d59bbdf6265a9\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/flip.js\":\"876a24f99882b38c\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/flipAttempts.js\":\"b62110bea934864c\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/pages.js\":\"bc9fc9ad8bd33523\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/preflight.js\":\"a36b999b5272765d\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/reseal.js\":\"d3203d42ff06b80a\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/runConversion.js\":\"04114c3d2a8e4ef6\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/runLock.js\":\"800e9f688d6e2d85\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/sealing.js\":\"36acb039ee6c2194\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/sealingStage.js\":\"52eddc04efd889b1\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/stage.js\":\"cca6cc4973712892\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/conversion/verifyReseal.js\":\"aea67e967f29b4b1\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/aad.js\":\"b3d19dab32d1196b\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/aead.js\":\"483705291c04df7a\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/base32.js\":\"bcab852f7ecfe7c6\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/base64url.js\":\"0a52d0e0ddf110b5\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/binaryEnvelope.js\":\"2cdc690e874df34f\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/byteAead.js\":\"7ba74c0c02cfb16c\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/canary.js\":\"aba83f999760b644\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/contentHash.js\":\"e84d34d89bc28ffd\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/contentKey.js\":\"d4840c0491c7dcb2\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/derivedIdNamespace.js\":\"dd8a43564a931e99\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/envelope.js\":\"b42f51fa13af569a\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/hex.js\":\"de05a9f53fdb23e4\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/sha256Hex.js\":\"d63be2a4962ef1be\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/crypto/workspaceKey.js\":\"924da30179c4d385\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/conversionState.js\":\"aff8f90d461cd4cc\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/flows/createEncryptedWorkspace.js\":\"df2dddd0b60dbb1e\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/flows/pastedKey.js\":\"852442ac62564d72\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6786a8dda845f2ff\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9c22ebcb35fd9e84\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/keyStore.js\":\"a18f4043d7cd3ed9\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/mintWorkspaceKey.js\":\"c2a65c06a94430c5\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/modePin.js\":\"434fa09d15c16a16\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/openWorkspaceKeys.js\":\"7ded0c329e94bfa5\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/resolveWorkspaceEntry.js\":\"8b20230afdb09842\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/resolver.js\":\"95654b4265406520\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/keys/workspaceAccess.js\":\"a74c6fdb7c14e451\",\"/knowledge-medium/pr-preview/pr-1869/src/sync/transform.js\":\"eae1b124ec97de59\",\"/knowledge-medium/pr-preview/pr-1869/src/themeBootDefaults.js\":\"139ff31ee3eda644\",\"/knowledge-medium/pr-preview/pr-1869/src/types.js\":\"b63f6d2d4554b4b8\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/ClientLocalSettings.js\":\"4238a82f62c548b0\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/abortableSleep.js\":\"09f61d7873060044\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/array.js\":\"933716d05f4d1f6a\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/backlinkAutocomplete.js\":\"aa9b0269417a3df9\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/blockCrumbs.js\":\"1931bdda51f45e44\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/blockrefAutocomplete.js\":\"0f2b8ff63ac8198e\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/cadencedIdleJob.js\":\"4b91a58049858369\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/callbackSet.js\":\"3e7a05e56abbcb67\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/clientId.js\":\"02cf124c6a975e90\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/codemirror.js\":\"63e3258002e9b60a\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/codemirrorCompletion.js\":\"a01b7c2a547db5e7\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/copy.js\":\"5a84d37a59e66f1e\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/dailyPage.js\":\"0aaae1e3cbc45d97\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/dbForensics.js\":\"fda0389df0d5e7f3\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/dbForensicsHooks.js\":\"5dfa767648eea24f\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/deleteBlockThroughUi.js\":\"eaa9b185c0eef347\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/dialogs.js\":\"125196d8fb699e0a\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/dom.js\":\"b7c8ea1af88f8b5d\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/downloadBlob.js\":\"b32c218a137c6c41\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/exportSqliteDb.js\":\"a3a3131d26b2e174\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/fileSystemAccess.js\":\"a05a8ee7b8d3dec8\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/flipSlide.js\":\"e4ec04871bfb0c44\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/fnv1a.js\":\"17bb92dc79ca04ee\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/formatBytes.js\":\"ddb2088dd38d12e7\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/fuzzyRank.js\":\"dff73eec1d4fdca4\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/idbKeyedStore.js\":\"808ed58afe7d8035\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/idleCallbackPolyfill.js\":\"aa2c588444e695bd\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/keyboardAwareScroll.js\":\"82e559c0e9e3ef19\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/keyboardViewport.js\":\"4175f7e945c1c143\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/lastWorkspace.js\":\"622809ae7ee01113\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/layoutColumns.js\":\"0a27a05db7c7521a\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/layoutSessionDom.js\":\"abf7d275635594f6\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/layoutSessionId.js\":\"17a5c34ef7304f04\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/linkClickGestures.js\":\"2baadc3859d794d5\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/linkTargetAutocomplete.js\":\"9918a1db28e2c361\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/localDbCorruption.js\":\"af0ad861d6b0f3d8\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/localDbRecovery.js\":\"291a18bd7b295b0f\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/markdownParser.js\":\"db61acba26e4ca21\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/memoize.js\":\"9b65adbcf10b7e29\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/nameFieldCommit.js\":\"41912824970f586d\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/nameList.js\":\"a8bdcbdefe2637df\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/navigation.js\":\"74d31bc2f4fd8b75\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/omnilinerNamespace.js\":\"dd550a5b62d9ae9f\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/opfsPageScan.js\":\"fe04a1a451a84299\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/panelClearance.js\":\"755d23006c56d6f7\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/panelHistory.js\":\"8d3df9041b1b3af0\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/panelLanes.js\":\"ed00a59a65abc70d\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/panelLayoutProjection.js\":\"ba2cc77778d041ce\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/panelScrollAnchor.js\":\"bb751e0018dea023\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/panelUrlFlags.js\":\"a3433bd5fce74ce6\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/platform.js\":\"5b99beee180908b0\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/pluralize.js\":\"c5295cdfb0a5f6e4\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/propertyCreation.js\":\"aa892a47e294af51\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/propertyNavigation.js\":\"e9158d561f9e2125\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/propertyValueContext.js\":\"34f25b1f9f1e0657\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/react.js\":\"e67682db423a4b4e\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/relativeDate.js\":\"6ee5d4b03b11103d\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/relativeTime.js\":\"ebd321b1a05401d8\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/renderScope.js\":\"41f5cff8585d7517\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/resolvedThenable.js\":\"a7e553fc3c418157\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/routing.js\":\"28ddcabceaa90249\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/safeMode.js\":\"f4eee9e94d7ac290\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/scheduleIdle.js\":\"9545a57427e216d7\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/screenWakeLock.js\":\"186dcc6f37d5d915\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/selection.js\":\"9d05def2e6dfa855\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/softKeyboardGrab.js\":\"97a8847b983a0672\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/startupTimeline.js\":\"32e7719c7e927789\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/state.js\":\"f89eb66dc4dc9fdd\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/string.js\":\"a96b1374877a3276\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/surfaceZoom.js\":\"51564e91ffe9efb1\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/time.js\":\"358a990d1f023151\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/toast.js\":\"4a07e31565970fe0\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/toggleStore.js\":\"2491f9c91eb53d87\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/untilStopped.js\":\"e164756802d54e56\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/userActivity.js\":\"111810bae803bd87\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/viewTransition.js\":\"4c4512e4b1509411\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/viewport.js\":\"fc0c042bb85833b8\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/webLock.js\":\"59f9b563fd234a5c\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/workspaceRecovery.js\":\"a86d846108e54e51\",\"/knowledge-medium/pr-preview/pr-1869/src/utils/workspaceSnapshotStore.js\":\"1cb80edb3645d281\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-compiler-runtime.js\":\"b8650dbf9107c3ad\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom-client.js\":\"6f3d87ae520f3317\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom-server-edge.js\":\"1d365b18b15c974c\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom-server.js\":\"c5a61be5e31293e2\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom-static-edge.js\":\"08d5f1f57f8247a5\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom-static.js\":\"2a688beae8904269\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom-test-utils.js\":\"f57b7b3bce06c968\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-dom.js\":\"0b59e7b46cf4aa1b\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react-jsx-runtime.js\":\"3a94c671da047ebf\",\"/knowledge-medium/pr-preview/pr-1869/src/vendor/react.js\":\"bd7f47bcd7780e17\",\"/knowledge-medium/pr-preview/pr-1869/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1869/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1869/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
