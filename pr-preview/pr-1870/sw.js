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
		buildId: "0673f7e67e02-5c653e6f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1870/\":\"46270e1c4d11f8ab\",\"/knowledge-medium/pr-preview/pr-1870/index.html\":\"46270e1c4d11f8ab\",\"/knowledge-medium/pr-preview/pr-1870/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1870/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1870/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1870/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1870/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1870/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1870/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1870/assets/FacadeVFS-C-4NjHYV.js\":\"d77296181ae27adb\",\"/knowledge-medium/pr-preview/pr-1870/assets/OPFSCoopSyncVFS-DKSerxng.js\":\"fef4ff3ddb324c6d\",\"/knowledge-medium/pr-preview/pr-1870/assets/OPFSWriteAheadVFS-BqSe1J0V.js\":\"ed7bc0f4717f495e\",\"/knowledge-medium/pr-preview/pr-1870/assets/wa-sqlite-BJe1YMaT.js\":\"49f54897c0319ce3\",\"/knowledge-medium/pr-preview/pr-1870/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1870/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1870/assets/wa-sqlite-async-Dy0Rb8gv.js\":\"35bc0a6509a1afb8\",\"/knowledge-medium/pr-preview/pr-1870/assets/worker-Br78_bXy.js\":\"ef02838d7894ea99\",\"/knowledge-medium/pr-preview/pr-1870/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1870/chunks/app-ie06-VDz.js\":\"2d28adb3e5fff103\",\"/knowledge-medium/pr-preview/pr-1870/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1870/index.js\":\"d7edad29195b72b9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1870/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1870/assets/AccessHandlePoolVFS-B3Io8C_C.js\":\"3bc2b189332eee66\",\"/knowledge-medium/pr-preview/pr-1870/assets/IDBBatchAtomicVFS-CKdW9HqO.js\":\"3eeb7b5450b346fd\",\"/knowledge-medium/pr-preview/pr-1870/assets/MemoryVFS-AuwsEp9R.js\":\"b4163f5e6aac092c\",\"/knowledge-medium/pr-preview/pr-1870/assets/mc-wa-sqlite-BcEgOnxs.js\":\"dc732b5f230ba16f\",\"/knowledge-medium/pr-preview/pr-1870/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1870/assets/mc-wa-sqlite-async-C15J7XjW.js\":\"3624a97f5fe817a1\",\"/knowledge-medium/pr-preview/pr-1870/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1870/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1870/chunks/AccessHandlePoolVFS-Cg8BOGug.js\":\"a717f4f30a868052\",\"/knowledge-medium/pr-preview/pr-1870/chunks/FacadeVFS-DHAHQUt9.js\":\"ab01251a13c68957\",\"/knowledge-medium/pr-preview/pr-1870/chunks/IDBBatchAtomicVFS-CIvL4Xx0.js\":\"4b16a682802af1d6\",\"/knowledge-medium/pr-preview/pr-1870/chunks/MemoryVFS-C0CrrD3Y.js\":\"e4ced7a0354fcbbf\",\"/knowledge-medium/pr-preview/pr-1870/chunks/OPFSCoopSyncVFS-VAaMeYPd.js\":\"556593296cb17fd2\",\"/knowledge-medium/pr-preview/pr-1870/chunks/OPFSWriteAheadVFS-Gq-zK1Oi.js\":\"e86633f93bc8e2b8\",\"/knowledge-medium/pr-preview/pr-1870/chunks/Preview-BUNJUIoW.js\":\"7c8dfa91c67bbef7\",\"/knowledge-medium/pr-preview/pr-1870/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1870/chunks/card-wc4M6pM7.js\":\"a445da9e6f5ea5a1\",\"/knowledge-medium/pr-preview/pr-1870/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1870/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1870/chunks/dist-Bfqb6jBW.js\":\"3f3114b07a569c53\",\"/knowledge-medium/pr-preview/pr-1870/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1870/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1870/chunks/mc-wa-sqlite-B7F3Mc5n.js\":\"b38b7e1abd8de2a2\",\"/knowledge-medium/pr-preview/pr-1870/chunks/mc-wa-sqlite-async-Cflu3uaJ.js\":\"d479a6dc49acd0b5\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-7B_gSIMH.js\":\"b66ce65efe88bd38\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-BfNwQrvP.js\":\"24f8ee1d0b6016b6\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-Bz_MeJS_.js\":\"f2415e602332ae75\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-CvjB04Bh.js\":\"cde6af63f5573374\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-CxWLxCRP.js\":\"a52da7eeb80af7a1\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-D1pxhTVD.js\":\"3e8632e332273f9a\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-DO64cIKE.js\":\"cc3b368a552de553\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-dom-server-legacy.browser.production-B6c1fxd3.js\":\"bfc36aa2e55ebdd9\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-dom-server.browser.production-BTOSgHC1.js\":\"3ed4fd469a6ad654\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-dom-server.edge.production-CswI2It7.js\":\"0d4f51d078e985e7\",\"/knowledge-medium/pr-preview/pr-1870/chunks/react-gOeT5WY6.js\":\"4662cb29c4087e2c\",\"/knowledge-medium/pr-preview/pr-1870/chunks/server.browser-DqKdy-_E.js\":\"e6b0daafde16f69f\",\"/knowledge-medium/pr-preview/pr-1870/chunks/textarea-GB6ldXnk.js\":\"4b09dd9b3c25c778\",\"/knowledge-medium/pr-preview/pr-1870/chunks/ui-DNFh_CiN.js\":\"cea4da9a76f532e2\",\"/knowledge-medium/pr-preview/pr-1870/chunks/wa-sqlite-BnadX7iZ.js\":\"4ae9b50649c7e7d1\",\"/knowledge-medium/pr-preview/pr-1870/chunks/wa-sqlite-async-UNHAPWoA.js\":\"3b8e4700a19d7285\",\"/knowledge-medium/pr-preview/pr-1870/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1870/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1870/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1870/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1870/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1870/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1870/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1870/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1870/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1870/src/App.js\":\"8b10d524c4e18ab5\",\"/knowledge-medium/pr-preview/pr-1870/src/appUpdate.js\":\"76e02093284315da\",\"/knowledge-medium/pr-preview/pr-1870/src/appVersion.js\":\"6adb0388985bc8a2\",\"/knowledge-medium/pr-preview/pr-1870/src/bootstrap/initialLayout.js\":\"a1e7c645c3964cc5\",\"/knowledge-medium/pr-preview/pr-1870/src/bootstrap/openWorkspaceData.js\":\"01a6f688576ef62d\",\"/knowledge-medium/pr-preview/pr-1870/src/bootstrap/resolveWorkspace.js\":\"ed5234788bf2aefa\",\"/knowledge-medium/pr-preview/pr-1870/src/bootstrap/workspaceBootstrap.js\":\"b9305b1c1e9ee0fd\",\"/knowledge-medium/pr-preview/pr-1870/src/components/BlockComponent.js\":\"7bd2bc612abe3cb2\",\"/knowledge-medium/pr-preview/pr-1870/src/components/BlockCrumbs.js\":\"bcb884924ef888a8\",\"/knowledge-medium/pr-preview/pr-1870/src/components/BlockEditor.js\":\"389c2580b7fb5621\",\"/knowledge-medium/pr-preview/pr-1870/src/components/BlockLoadingPlaceholder.js\":\"977643267ff4de5e\",\"/knowledge-medium/pr-preview/pr-1870/src/components/BlockProperties.js\":\"893a7562d76ecaad\",\"/knowledge-medium/pr-preview/pr-1870/src/components/BlockSearchPicker.js\":\"f3a4479044caad3e\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ConfirmBulkDeleteDialog.js\":\"bd353585f35fb9a3\",\"/knowledge-medium/pr-preview/pr-1870/src/components/DividerHandle.js\":\"58f4bdb21e20aa2b\",\"/knowledge-medium/pr-preview/pr-1870/src/components/DraftEditor.js\":\"7c25829eaa0f0731\",\"/knowledge-medium/pr-preview/pr-1870/src/components/GutterPill.js\":\"44efcbb26b1c18b0\",\"/knowledge-medium/pr-preview/pr-1870/src/components/Header.js\":\"47825404df0a2b91\",\"/knowledge-medium/pr-preview/pr-1870/src/components/LazyBlockComponent.js\":\"8c1858f03142745c\",\"/knowledge-medium/pr-preview/pr-1870/src/components/Login.js\":\"0795f5abfbfb3b50\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ZoomableSurface.js\":\"b4ca3fd43d82ecce\",\"/knowledge-medium/pr-preview/pr-1870/src/components/editModeKeepalive.js\":\"e3360df859c92fec\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c4296ce64488f894\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f995250a42c15a9c\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/RefPropertyEditor.js\":\"1786ea7a3537ff42\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/RefTargetTypePicker.js\":\"ecb49f5be097623d\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/SelectPropertyEditor.js\":\"5acfd20c3f100811\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/TypesPropertyEditor.js\":\"4e0aeecbbdabd600\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/defaults.js\":\"0e50ea5df1c302f3\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/kernelValuePresets.js\":\"2ff474773917da0e\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/selectablePresets.js\":\"a439129f733621cc\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyEditors/typesPropertyUi.js\":\"a709294bc802976f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/AddPropertyForm.js\":\"bc5e8d078dd3a371\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/PropertyPicker.js\":\"3bfd35218d0d8ca9\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/PropertyRow.js\":\"a7dd2d287ecd03cf\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/Rows.js\":\"7b8aa40688922e2a\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/actions.js\":\"2ac1f9f70f8e82d8\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/declarationOnly.js\":\"aa527589a5fdd3f5\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/layout.js\":\"343f161aeb79c94f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/model.js\":\"f001495ef3d8de3e\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/shapeUi.js\":\"33837ee1b3c37328\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/shapes.js\":\"b1256c49aca19b23\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/usePropertyEditingActivation.js\":\"cd5cddb403f29030\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanel/visibility.js\":\"f3f57d1201d3797a\",\"/knowledge-medium/pr-preview/pr-1870/src/components/propertyPanelSections.js\":\"2ee863c97a8e867f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/BlockEmbed.js\":\"a24ca8cddafe0af3\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/BlockLink.js\":\"6525ad7c39d338f8\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/BlockRef.js\":\"e2412bbacfa1df6f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/ReferenceLink.js\":\"a9e304e3185ef814\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/cycleGuard.js\":\"e9566179c328c5d1\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/cycleGuardContext.js\":\"25ba3e9af4717034\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/linkInteraction.js\":\"673312ad3ad480f5\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/referenceLayout.js\":\"516c5c34d31207c0\",\"/knowledge-medium/pr-preview/pr-1870/src/components/references/useBlockRefAncestors.js\":\"631f7ed3c4e83de1\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/BlockGutter.js\":\"899cdb229f57c744\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/BlockInfoDialog.js\":\"4ecbcd87fc5762d9\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/BlockTypeBlockRenderer.js\":\"1e64938a9ae65267\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/BulletHoverCard.js\":\"deccb41f6e797955\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/CodeMirrorContentRenderer.js\":\"1b65b8b8b9fc9122\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"084c791c9915d825\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/ColumnResizeHandles.js\":\"a72618f66ad74338\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"933a1fb0f11391f5\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/DefaultBlockRenderer.js\":\"9f59a7c3317c6cff\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/LayoutRenderer.js\":\"b56bca276e662e41\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/MarkdownContentRenderer.js\":\"b1f9b1963fe11f9c\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/MissingDataRenderer.js\":\"ca087112c6a8a694\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/PanelRenderer.js\":\"5ccea7a8730c0ee1\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b12a8d5e5a094357\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/TopLevelRenderer.js\":\"46ffd152abab03a0\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/blockGutterMode.js\":\"d4684498266bf22b\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/blockTitleText.js\":\"fa8599a4cda040e8\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/fieldCreationKeydown.js\":\"9d67676fbe931a27\",\"/knowledge-medium/pr-preview/pr-1870/src/components/renderer/layoutRootContext.js\":\"01e008718f0accf7\",\"/knowledge-medium/pr-preview/pr-1870/src/components/typeChip/TypeChip.js\":\"cadfc03e24b483bd\",\"/knowledge-medium/pr-preview/pr-1870/src/components/typeChip/chipStyle.js\":\"b9aea5799bcf77d7\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/anchored-floating.js\":\"3b520f0d453305da\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/button.js\":\"f54f4de02f96f935\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/card.js\":\"e23e629d875fbe89\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/checkbox.js\":\"83037a75a0a5fae0\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/collapsible.js\":\"04de43c9b524ece0\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/command.js\":\"154f5e68412fcee4\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/context-menu.js\":\"2180e4b7bec00d9f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/dialog.js\":\"81ad8ff9277197f7\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/dropdown-menu.js\":\"c417bd0406248caf\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/floating-listbox.js\":\"bf939a4a37863404\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/index.js\":\"5d99baf8b1547717\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/input.js\":\"217f08a8308cbcaa\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/kbd.js\":\"360714c33006efc1\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/label.js\":\"07d0c66294b613e1\",\"/knowledge-medium/pr-preview/pr-1870/src/components/ui/textarea.js\":\"c3420fc9631c64cb\",\"/knowledge-medium/pr-preview/pr-1870/src/components/useEditModeYieldKeepalive.js\":\"d4071315474aaf9c\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/BootFallback.js\":\"ba03261ee1cf9c32\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/FocusedRowLazyMount.js\":\"076e7c3e5a4d192f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/LazyViewportMount.js\":\"0ba54832309ff88b\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/LocalDbCorruptionFallback.js\":\"0e42f72a8cd42222\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/error.js\":\"563b3987f4357734\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/lazyMountRegistry.js\":\"95756bf67d4dd1c3\",\"/knowledge-medium/pr-preview/pr-1870/src/components/util/suspense.js\":\"ef7149b7a3a50181\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/CreateWorkspaceDialog.js\":\"e933ea558d239877\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/PendingInvitations.js\":\"259a6b365dca6b88\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/SyncProgress.js\":\"37db819d944f255f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/UnlockProgress.js\":\"e9180a5d833a05fa\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/WorkspaceKeyGate.js\":\"19a5b078442fca83\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/WorkspaceSettingsDialog.js\":\"4906d61b4f31f698\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/WorkspaceSwitcher.js\":\"d189283373890b37\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/WorkspaceSyncGate.js\":\"372499a0f96314e8\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/ConversionFlow.js\":\"db7e3e86744fcbdf\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/ConversionFlowHost.js\":\"b6be37cf437cf693\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/EncryptionSection.js\":\"c44cc94f5c11779e\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/attachmentPrompts.js\":\"1bb972b0d98d6288\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/bundleFolderPrompts.js\":\"528ceee833faa2ad\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/conversionFlowDeps.js\":\"c0d21b5e200d1023\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/conversionFlowStore.js\":\"bac1a97b173222a0\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/flowUi.js\":\"6c74bcdd8318f053\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/conversion/useConversionRun.js\":\"f9cf4bbf1dd51d8c\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/keyUi.js\":\"283eabf309391a4f\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/useCloseOnKeyLoss.js\":\"ab11f38bdf89bba9\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/useCloseOnServerE2ee.js\":\"473f697671af32ed\",\"/knowledge-medium/pr-preview/pr-1870/src/components/workspace/workspaceUnlocked.js\":\"b5ea46ea5863517d\",\"/knowledge-medium/pr-preview/pr-1870/src/context/backgroundSubtree.js\":\"45a46b0ce572a565\",\"/knowledge-medium/pr-preview/pr-1870/src/context/block.js\":\"d51b4c59c44f1f9e\",\"/knowledge-medium/pr-preview/pr-1870/src/context/layoutWsContext.js\":\"9cada28e6dead508\",\"/knowledge-medium/pr-preview/pr-1870/src/context/propertyDisplay.js\":\"13f22edb80b2d72e\",\"/knowledge-medium/pr-preview/pr-1870/src/context/repo.js\":\"669a52d105625185\",\"/knowledge-medium/pr-preview/pr-1870/src/data/aliasClaim.js\":\"cefa64fa6dd903a9\",\"/knowledge-medium/pr-preview/pr-1870/src/data/aliasSeatNamespace.js\":\"b926744b41200409\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/blockData.js\":\"fcdeb6d18df318b5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/blockType.js\":\"75dbd01b48e85d61\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/changeScope.js\":\"0edb7005726362c0\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/codecs.js\":\"7ee23b0e13f78700\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/derivedData.js\":\"9fac376695a0a7e8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/errors.js\":\"504b9c525e9f106c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/events.js\":\"2aa7f8434989a45a\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/handle.js\":\"0a50c36237c6e6f5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/index.js\":\"57a941907e907672\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/mutator.js\":\"ab32f3dc8eb123fd\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/processor.js\":\"a74591f364eb3632\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/propertySchema.js\":\"13d86375b0cdabe4\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/query.js\":\"60eee440e018d0e1\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/sameTxProcessor.js\":\"590fc487ed5ed5b5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/schema.js\":\"0a50c36237c6e6f5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/tx.js\":\"0a50c36237c6e6f5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/typedBlockQuery.js\":\"a81b196322c0bc6f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/user.js\":\"1bf3d37929f7cc92\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/valuePresetCore.js\":\"75d4220280de48e8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/api/valuePresets.js\":\"dea00e3541125fd9\",\"/knowledge-medium/pr-preview/pr-1870/src/data/attachmentCleanerIOVerb.js\":\"355ab28b81994d18\",\"/knowledge-medium/pr-preview/pr-1870/src/data/block.js\":\"2867950e4f3e52f3\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockCache.js\":\"b7827527e347c69a\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockId.js\":\"c61ac15d1c7034f4\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockLiveness.js\":\"152db0ac1b762c5e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockMerge.js\":\"6239d5698d81dd43\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockSchema.js\":\"f51bf72dd2676652\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockTypeLookup.js\":\"ab5b6cd6ba3fd428\",\"/knowledge-medium/pr-preview/pr-1870/src/data/blockTypes.js\":\"d640d6f958b6edad\",\"/knowledge-medium/pr-preview/pr-1870/src/data/childrenView.js\":\"058e2e460abe3fff\",\"/knowledge-medium/pr-preview/pr-1870/src/data/clientContext.js\":\"5dc1f3686ab54832\",\"/knowledge-medium/pr-preview/pr-1870/src/data/dbFileSiblings.js\":\"123a13f1b743f906\",\"/knowledge-medium/pr-preview/pr-1870/src/data/definitionSeeds.js\":\"27735d4f5fa49aeb\",\"/knowledge-medium/pr-preview/pr-1870/src/data/derivedIds.js\":\"8979998921dbc979\",\"/knowledge-medium/pr-preview/pr-1870/src/data/drawnSubtree.js\":\"29118347f54f515e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/facetBridge.js\":\"dcc609b5cc9d4da8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/facets.js\":\"571984bdd8d0a916\",\"/knowledge-medium/pr-preview/pr-1870/src/data/globalState.js\":\"fe29cc0dbcffe3e8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/aliasClaimRederiveProcessor.js\":\"38353adea209373e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/ancestorBatch.js\":\"427c4ac71214057a\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/blockTypeTypeifyProcessor.js\":\"a5b9fe42d558408c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/clientSchema.js\":\"0ae7e3eeaee78f88\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/commitPipeline.js\":\"472a8f490fbb973f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/devAssertions.js\":\"eb93ef06eac21075\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/firstSync.js\":\"50433d7d32b68529\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/freshInitialLoad.js\":\"b77fa8fd9cc54d66\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/graphBackfillClaim.js\":\"aef99e120e83072c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/handleStore.js\":\"e13f0546b8261ca6\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/idleMarkerJobs.js\":\"37d8633087001833\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/initialDownload.js\":\"63c7e7e87c7fbb59\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/initializeClientDatabase.js\":\"f2067d455f631e84\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/jsonCanonical.js\":\"fe959aa8c9439ba2\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/kernelInvalidation.js\":\"31abce495379f031\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/kernelProcessors.js\":\"3fa36d7ba81ed568\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/kernelQueries.js\":\"f6ef50cccf43947f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/mergeTypeMembershipProcessor.js\":\"db87b96043a8a618\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/normalizeReferencesProcessor.js\":\"efb096530ac78869\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/poolInstrumentation.js\":\"e3bf8ba138efe997\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/processorRunner.js\":\"3cc63c8d92636fc0\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyCellBackfill.js\":\"dfaad79affc03336\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyChildMint.js\":\"4e91216b10145cc0\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyChildrenProcessor.js\":\"77e030e6726ee237\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8f74427cbe2d6b63\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyDefinitionSynthesis.js\":\"30d1c6f1f16cabfa\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyKeyScan.js\":\"7bf61164100890d2\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertySchemaResolution.js\":\"7773c405f9255d23\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/propertyValueEdits.js\":\"50ad214ccbdac86a\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/raiseProtocol.js\":\"d9cbc86acb8d2b66\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/readBatch.js\":\"e41b4f51aaad4329\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/refProjection.js\":\"2cf8e2d4a7769ec7\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/referenceTargetLookups.js\":\"f0b7c879bd9137f4\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/referenceTargetProcessor.js\":\"bf1856de58a752fd\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/replayMerge.js\":\"b0e245f2187575a5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/sqlBinds.js\":\"96bd08139e12e656\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"61965eeb6dae3c34\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/syncObserver/arrivalProcessors.js\":\"7c2bec61033782c3\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/syncObserver/invalidate.js\":\"ca7685c0428729a9\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/syncObserver/materialize.js\":\"1712c55d6a63dae0\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/syncObserver/observer.js\":\"e6be7215e4252e89\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/syncObserver/reconcile.js\":\"db22b19550b88d72\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/timingMetrics.js\":\"5a29ff47a17482af\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/treeQueries.js\":\"ff50fd1010e6bf31\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/txEngine.js\":\"4a7ecb4db6352b5a\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/txSnapshots.js\":\"e0cc6b90d1bba846\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/typedBlockQuery.js\":\"82cc084b91fbe24a\",\"/knowledge-medium/pr-preview/pr-1870/src/data/internals/undoManager.js\":\"35010c0ebab62f8b\",\"/knowledge-medium/pr-preview/pr-1870/src/data/invalidation.js\":\"17d30531c7ce3005\",\"/knowledge-medium/pr-preview/pr-1870/src/data/kernelDataExtension.js\":\"58396e6108c8ac4f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/kernelPage.js\":\"3129cb092c917e25\",\"/knowledge-medium/pr-preview/pr-1870/src/data/kernelValuePresetCores.js\":\"bd53945c87b8fe29\",\"/knowledge-medium/pr-preview/pr-1870/src/data/localDbCorruptionSignal.js\":\"cbcedb19cd03fe2e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/localDbStorage.js\":\"4cbaea28fe3b654c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/localDbVfs.js\":\"b11250b783fbe775\",\"/knowledge-medium/pr-preview/pr-1870/src/data/localSchema.js\":\"79b1d4199a609b08\",\"/knowledge-medium/pr-preview/pr-1870/src/data/maintenance.js\":\"6eaa6bd5ee0cd7da\",\"/knowledge-medium/pr-preview/pr-1870/src/data/mergeProperties.js\":\"86a7a0aa2145481c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/metricsConsoleHook.js\":\"9b1fbfdb811559d5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/migrationsPage.js\":\"ff28ac0210e2d41b\",\"/knowledge-medium/pr-preview/pr-1870/src/data/mutators.js\":\"7844dec4d4688f52\",\"/knowledge-medium/pr-preview/pr-1870/src/data/orderKey.js\":\"3b5a8a94f78551d0\",\"/knowledge-medium/pr-preview/pr-1870/src/data/orderKeyPlacement.js\":\"a7ddba4057e6bb96\",\"/knowledge-medium/pr-preview/pr-1870/src/data/outlineSurface.js\":\"46af0dadf6fa1f2e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/pendingEditorContent.js\":\"a1bc9d8b03bd692d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/pendingUploadsSql.js\":\"55224d917681464d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/pluginStateExtensions.js\":\"8454233d8d2ac20d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/powerSyncLogger.js\":\"9d834e17d3db7bb9\",\"/knowledge-medium/pr-preview/pr-1870/src/data/projectorRuntime.js\":\"b27cf12476f6a79b\",\"/knowledge-medium/pr-preview/pr-1870/src/data/properties.js\":\"fcd8903af764543d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertiesPage.js\":\"ffc2b542eef72062\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertyChildren.js\":\"2219af1aa41a7a9e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertyDefinitionFanout.js\":\"263e5d8df149ffe6\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertyDefinitionMetadata.js\":\"e31d12d94dcc918f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertyDefinitionRegistry.js\":\"e353851983c97b91\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertyDisplayMode.js\":\"b556666f88bf52bd\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertyRowCreation.js\":\"bb5dd9f33bf3d941\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertySchemaCreation.js\":\"8cb9bad10cf9e245\",\"/knowledge-medium/pr-preview/pr-1870/src/data/propertySeeds.js\":\"71ffa98c20bad82f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/recentsPage.js\":\"c417f4e4786de6f5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/referenceBlock.js\":\"56490f7718b8c01f\",\"/knowledge-medium/pr-preview/pr-1870/src/data/rejectedUploads.js\":\"6450f512004454e8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/releasePowerSyncConnection.js\":\"deba19228b44c923\",\"/knowledge-medium/pr-preview/pr-1870/src/data/repo.js\":\"a7141af26396f501\",\"/knowledge-medium/pr-preview/pr-1870/src/data/repoProvider.js\":\"4fc9bbbd6107f8fb\",\"/knowledge-medium/pr-preview/pr-1870/src/data/rowProperty.js\":\"35c3e1db7bf7f342\",\"/knowledge-medium/pr-preview/pr-1870/src/data/searchFilter.js\":\"307ea4fc64b38080\",\"/knowledge-medium/pr-preview/pr-1870/src/data/seedIdentityLedger.js\":\"f78d093637d1ed75\",\"/knowledge-medium/pr-preview/pr-1870/src/data/stateBlocks.js\":\"ec9553a8aa70247d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/structuralEditPolicy.js\":\"ad004d18b92d5a71\",\"/knowledge-medium/pr-preview/pr-1870/src/data/subtreeDelete.js\":\"86a2535279398757\",\"/knowledge-medium/pr-preview/pr-1870/src/data/syncStreamLock.js\":\"c3c50f7a0debce5e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/syncedTableSqlRecognizer.js\":\"f1f854ce437e8444\",\"/knowledge-medium/pr-preview/pr-1870/src/data/syncedTableWriteGuard.js\":\"8fac39804ee17620\",\"/knowledge-medium/pr-preview/pr-1870/src/data/targets.js\":\"bd8ab62d243de8f8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeColors.js\":\"69496edff27173a8\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeDefinitionMetadata.js\":\"e7e4b0fd2f126a7c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeDefinitionRegistry.js\":\"4097c6ead333774b\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeExtraction.js\":\"20fb5ff589d12462\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeInitialValues.js\":\"9d1f1a85667b8bad\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typePropertyGroups.js\":\"dedd76ab124cd4ba\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeSeeds.js\":\"46f404a6c5d3993e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typeTagger.js\":\"df74009c69e145f4\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typedRecords.js\":\"19c413a4361d019e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/typesPage.js\":\"78389ed0108ba560\",\"/knowledge-medium/pr-preview/pr-1870/src/data/userPrefs.js\":\"bd4b5e0452b5b40d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/userSchemasService.js\":\"c9f503eef78fc78c\",\"/knowledge-medium/pr-preview/pr-1870/src/data/userTypesService.js\":\"4b6db9c85c758c1e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/valuePresetRegistry.js\":\"c3b2ef1012374f3d\",\"/knowledge-medium/pr-preview/pr-1870/src/data/visibleChildren.js\":\"b07aa5a64fd0014e\",\"/knowledge-medium/pr-preview/pr-1870/src/data/workspaceConversion.js\":\"b423c2d2078f1916\",\"/knowledge-medium/pr-preview/pr-1870/src/data/workspaceFirstSync.js\":\"713083b021d61793\",\"/knowledge-medium/pr-preview/pr-1870/src/data/workspaceIdNamespace.js\":\"35242206e4094d38\",\"/knowledge-medium/pr-preview/pr-1870/src/data/workspaceSchema.js\":\"3a73f8a3e0b0d018\",\"/knowledge-medium/pr-preview/pr-1870/src/data/workspaces.js\":\"df4cbd9cbee8a2bb\",\"/knowledge-medium/pr-preview/pr-1870/src/data/writeAheadLog.js\":\"a412a2de4a6b47a5\",\"/knowledge-medium/pr-preview/pr-1870/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/BlockPasteShellDecorator.js\":\"838d0a599a2d4289\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/atTrigger.js\":\"6f50bf091a96dd5f\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/autocomplete.js\":\"462911cb4a530def\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/codeMirrorExtensions.js\":\"a49b264fdec7bf31\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/contentFlush.js\":\"fc636ee36cbe11ed\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/defaultInteractions.js\":\"2671e39ff4bd4c65\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/editSettleSignal.js\":\"4251874e576f7c4f\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/insertImage.js\":\"7c4d89fc6b681851\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/referenceCompletionRange.js\":\"2aee45eaa41f0181\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/referenceTargetTypes.js\":\"4d2e932e4fad9cf8\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/syntaxContext.js\":\"09fc18a5d34b3101\",\"/knowledge-medium/pr-preview/pr-1870/src/editor/triggerMatch.js\":\"897390ad1b7fc780\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/AppRuntimeProvider.js\":\"4bfbc91bbebd5dd8\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/BlockFocusShellDecorator.js\":\"6a0bc256897f050c\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/ExtensionRenderBoundary.js\":\"955b64247d928afa\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/PanelContentRecovery.js\":\"8015a52275384f9c\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/apiCatalog.js\":\"ee45fe072f4b37d0\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/approveExtensionHere.js\":\"addaf4d37b54b9c2\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/armedCutAppMount.js\":\"bc4e278acf503b53\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/batchableKeyedStore.js\":\"f49e736c391a56f3\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/blockInteraction.js\":\"c711cdddda59d6dc\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/blockSelectionAction.js\":\"f515b9ce66968e73\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/compileExtensionModule.js\":\"ddbba1d6505ae06a\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/compiledModuleCache.js\":\"aec24c59eddcd5ae\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/continuousGestures.js\":\"6ae33aead1b1667a\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/core.js\":\"5dd9d698635588bb\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/defaultRenderers.js\":\"4c88583e1fc08cd5\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/definitionFanoutAppMount.js\":\"a9506e1fe5d12e09\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/dialogAppMount.js\":\"954277e3de85be0b\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/dynamicExtensionSeeds.js\":\"8bccf70b2036b8e0\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/dynamicExtensions.js\":\"0786c873f7721a37\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/exampleExtensions.js\":\"5b6f03e1f94078cd\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/extensionApprovalStatus.js\":\"cc8f5b1641e15017\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/extensionLoadErrorToast.js\":\"19ca2c9d97b12abe\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/extensionLoadErrors.js\":\"65e01d7059b1e1be\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/extensionLookup.js\":\"51a8c65d318271ed\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/extensionToggles.js\":\"3f51118db1f1ea05\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/extensionUtilitiesCss.js\":\"c5e970a3716cee9d\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/kernelPageDeletionGuard.js\":\"1bcc69fa827d4cfa\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/liveRuntime.js\":\"fd3bbc343dd13bab\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/openExtensionsSettings.js\":\"5e8a13c21c7bb00d\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/overridesCache.js\":\"86828ae3e1553ada\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/pluginIds.js\":\"12871e34e80ff33b\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/processorRejectionToast.js\":\"07c3401dc04ea411\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/runtimeActions.js\":\"465c619fdafadcf8\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/runtimeContext.js\":\"b46605925c2008d4\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/staticAppExtensions.js\":\"6a661cac6a92b27a\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/staticDataExtensions.js\":\"c9c6ce96303551a1\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/toastAppMount.js\":\"d0d751b9c24f8a58\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/useOverrides.js\":\"6a443c0359b3a978\",\"/knowledge-medium/pr-preview/pr-1870/src/extensions/useShortcutSurfaceActivations.js\":\"ba1075983c356c81\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/discoverToggleTree.js\":\"eb2b8865e00eef13\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/facet.js\":\"bf79cb459dd7f15d\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/resolveAppRuntime.js\":\"ac469061180bf7a2\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/runtimeEvents.js\":\"4642245f5a0ddc18\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/togglable.js\":\"f7f46e490023ed12\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/variantFacet.js\":\"76392983ec851128\",\"/knowledge-medium/pr-preview/pr-1870/src/facets/verbFacet.js\":\"177415add8411aef\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/block.js\":\"0c5440596a089189\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/focusedChild.js\":\"27f963dbffaa9faf\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/propertySchemas.js\":\"6bd6a77fcc778ab0\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/typeRegistry.js\":\"b88df1e74c86f4b3\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useAncestorCrumbs.js\":\"63e487fcd8637261\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useAutocompleteListbox.js\":\"0b69046c253fe39a\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useDebouncedSearch.js\":\"0d851633a3f7cfca\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useDebouncedValue.js\":\"1b29d4aad65e157c\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useIsFocalRender.js\":\"51df3b480dd12364\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useIsReadOnly.js\":\"3586ba3e9308a2f6\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useMaterializeBacklog.js\":\"0aee1f85bace41b6\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useMinuteClock.js\":\"f6d8f952eb29b60b\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/usePanelLayoutProjection.js\":\"21f425c8f0412e50\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/usePendingInvitations.js\":\"0f183515bf2cff8e\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useRendererRegistry.js\":\"e18eda4856ffaf42\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useRetainedFieldRows.js\":\"ab7e5de3e693001d\",\"/knowledge-medium/pr-preview/pr-1870/src/hooks/useWorkspaces.js\":\"72739df72611e1f2\",\"/knowledge-medium/pr-preview/pr-1870/src/lib/utils.js\":\"d695044233dcda17\",\"/knowledge-medium/pr-preview/pr-1870/src/main.js\":\"4de86920bff6f30e\",\"/knowledge-medium/pr-preview/pr-1870/src/markdown/MarkdownImage.js\":\"7b0e28126b995eb6\",\"/knowledge-medium/pr-preview/pr-1870/src/markdown/blockSeparators.js\":\"4022ff9fcfa4712f\",\"/knowledge-medium/pr-preview/pr-1870/src/markdown/context.js\":\"577c921a944289ac\",\"/knowledge-medium/pr-preview/pr-1870/src/markdown/defaultMarkdownExtension.js\":\"9e70996cfabad563\",\"/knowledge-medium/pr-preview/pr-1870/src/markdown/extensions.js\":\"73b376e135e94c5e\",\"/knowledge-medium/pr-preview/pr-1870/src/markdown/renderMarkdownHtml.js\":\"16eed7adc431c73b\",\"/knowledge-medium/pr-preview/pr-1870/src/minimal-editor.js\":\"0aaca2ee3a1a4425\",\"/knowledge-medium/pr-preview/pr-1870/src/paste/armedCut.js\":\"687d1f7f02e0c60a\",\"/knowledge-medium/pr-preview/pr-1870/src/paste/captureMediaVerb.js\":\"c961838d777d02a6\",\"/knowledge-medium/pr-preview/pr-1870/src/paste/clipboard.js\":\"51c3f1cd1f5487bf\",\"/knowledge-medium/pr-preview/pr-1870/src/paste/decision.js\":\"7179d516d13caab3\",\"/knowledge-medium/pr-preview/pr-1870/src/paste/operations.js\":\"b6eceab265cf9da2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/account-header/AccountHeaderItem.js\":\"2821c8c38230f046\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/account-header/index.js\":\"77966ad717c14c55\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f87593aed79c2ea5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/askAgent.js\":\"12f7f2ea62b086bc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/askedStore.js\":\"212c79bbc3f195ac\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b8a74422a855c38f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/chipState.js\":\"88a161d29bd6dac3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c86b720836e74136\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/index.js\":\"d3438cdbad462ee1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"81d01723edaa6e37\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-dispatch-companion/schema.js\":\"d834ef3952bcb952\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6753e9fd2bb45837\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e969ba42b2bc2b0f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/addMedia.js\":\"4bba37d39493beca\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a081f59d010cc8d6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/block.js\":\"08877508dec3e703\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/context.js\":\"b53ad2d8b0c63eac\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/displayIds.js\":\"40c2356bf2e2946b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/index.js\":\"a7d55c858926576e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/outline.js\":\"c7eae7899bd0a2cf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/properties.js\":\"be0685e9be4e0f97\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/refs.js\":\"250c490a03df0b23\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2b73d7135a4d1171\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/search.js\":\"73f1653a32b99e60\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/shared.js\":\"e61450f70cf2edce\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6075eb0bcf518d35\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentViews/text.js\":\"e568af6adbdb3489\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/agentWrites.js\":\"6eac98e58d2bb6e5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/authoringCatalog.js\":\"e4abfff1d2c09b0c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/blockRefTargets.js\":\"168efcf5fdddde71\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/bridge.js\":\"93921af9db53b2f3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/bridgeLoop.js\":\"bf0a18ec996250be\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/changeHistory.js\":\"3907785fc97aafe2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/commands.js\":\"16e7e57e36ea81ae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/commentsCommands.js\":\"74290770f911c2de\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/dataExtension.js\":\"a401de6ec039a49d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/dataModelGuide.js\":\"baf9c4c9baf50487\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/describeRuntime.js\":\"17c875eae6e627e1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/extensionLint.js\":\"a42dbc710a223e5c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/grainAudit.js\":\"e3fde79a52ab3ac7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/healthCommand.js\":\"89f7a6f80d220216\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/index.js\":\"22affd5c46a17dff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/presetIdentity.js\":\"20054885955a1834\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"fb035f3750441b2c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/readMedia.js\":\"4ac591c53cfbdeea\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/schema.js\":\"f78a6b2eda30c1a8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/serialization.js\":\"642c4c9141edea3d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/targets.js\":\"046288c2e8a09030\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/tokens.js\":\"135119aa5fd24ef1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/watchEvents.js\":\"4864faabe55a92f1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/workspaceGuard.js\":\"d2f19925bdd98266\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/agent-runtime/writeCommands.js\":\"49e72b26f07ee661\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/AliasCollisionToast.js\":\"370092968703e7d0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/DuplicateNameBanner.js\":\"c4b2d19da2d63721\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/collisionMerge.js\":\"4eae41fa7f59ddf0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/dataExtension.js\":\"86f3944bcc7364c1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/index.js\":\"df20d9111c53506e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/mergeCollisionAction.js\":\"89feb2e8430e3114\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/pageStyling.js\":\"7b999be32bb0130b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/rejectionToast.js\":\"1310cc53c94237a5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/alias/syncProcessor.js\":\"c19953babaaa1ab7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/actions.js\":\"5761e27b95802e39\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/addComment.js\":\"153cd06ad450e716\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/anchor.js\":\"e5a65dbbf53bd500\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/anchorState.js\":\"2686e21e3eba2460\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/commentLinks.js\":\"156e142c7c39dd52\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/confirmThreadDeletion.js\":\"135d2cc650cd2bb6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/container.js\":\"3bc9829ceb575d94\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/dataExtension.js\":\"70e5830b6fad6f7f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/deleteComment.js\":\"1b3bd6dbac5eaedc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/highlights.js\":\"e838e918ed4ae0e0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/index.js\":\"3ca37adf3a1e9a2a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/linkedCommentsPill.js\":\"82aacbcc0ee8d604\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/margin.js\":\"629ce4987b593cd7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/marginSchema.js\":\"b9160b7e5bc78e12\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/newComment.js\":\"76c67d1c1ccda40e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/ownThreadPicker.js\":\"1dc9e15beadfae14\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/placement.js\":\"73dea70d3b64b3c6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/queries.js\":\"614c51afa1b40fe4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/quotePosition.js\":\"f303f61dae232852\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/quotedIn.js\":\"384e6bc020bc7a90\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/quotedRange.js\":\"bbc05d3c5e9bdec3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/rangeRefs.js\":\"2a5402eaa682bcda\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/readHighlights.js\":\"3cf2a520e4460526\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/readSelection.js\":\"652f0c33cf2d2ce2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/readSelectionUi.js\":\"e00b187e59561e30\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/reanchor.js\":\"eb6244b243d9d01a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/schema.js\":\"1d560bd6fe75d62a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/scope.js\":\"fc3b0ee130ff9379\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/scopeThreads.js\":\"fbccece4f86cdc01\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/splitRetarget.js\":\"eb4bb456493b3670\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/suggestionCard.js\":\"eebb0f7f3ac962d9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/suggestions.js\":\"47dfd96405267109\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/summaries.js\":\"231dc2ada9066fee\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/summaryBatch.js\":\"1854815dbf1138e0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/surface.js\":\"194c3389b3e838b7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/threadNavigation.js\":\"1063cd7eba8130ea\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/threads.js\":\"f4174538a874a98e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/ui.js\":\"43df04316ebff59a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/annotations/uiStore.js\":\"240d53acf70ea94e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/app-intents/appIntents.js\":\"4364801f1020b3fb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/app-intents/index.js\":\"4f929ca5e7287618\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/app-update-prompt/index.js\":\"ce630f73142c9526\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/app-update-prompt/status.js\":\"7805ed4c885f7290\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"459083dbc6589dbf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/MediaBlockRenderer.js\":\"9937f8b7db1db572\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/MediaDownLaneReplicator.js\":\"788acd34cda1f456\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/MediaUploadReconciler.js\":\"9981250f130a92c8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/assetDownLane.js\":\"22e6fc4d015f53b1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/assetResolver.js\":\"47be5a35644fc196\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/assetUpload.js\":\"eb346b3af4724a3d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/attachmentCleanerIO.js\":\"9144d5d9f9a4b721\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/audit/supabaseAuditIO.js\":\"fa619d7c572c4b3a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/blobStore.js\":\"cf73fc4589bf4f7f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/browserMedia.js\":\"012b73ccb31ebcd9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/byteStore.js\":\"941c0b3de4ada88c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/cleanerIO.js\":\"8341d5f54dd77b17\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/cleanupAttachments.js\":\"21e46287d5575f28\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/dataExtension.js\":\"0b70719535a5406e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/downLane.js\":\"899b294f8a1b0852\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/index.js\":\"b5232921fedb8a80\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/insertImageContribution.js\":\"b33c2890cf707eff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/laneArming.js\":\"6a3106282df1e2aa\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/laneLock.js\":\"ba6d20fc03ecfe6c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/mediaBlock.js\":\"0ebaed49f157796f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/mediaCapture.js\":\"456268eb4337bae3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/mediaLanes.js\":\"cdf72acf6318b168\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/mediaViewers.js\":\"c42a0894c823044d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/mediaViewersFacet.js\":\"39c22ac38b1ea206\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/pasteCapture.js\":\"daec8fc3ec5d7d71\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/resolver.js\":\"d51ed7a3582ac31f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/retryUploadsAction.js\":\"1b77ea97a7320e0f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/storagePaths.js\":\"708fb798a2ed00b1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/uploadDrain.js\":\"d43fa18fde49cbd9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/uploadLaneStatus.js\":\"21fee582c3b19a99\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/uploadReconcile.js\":\"ec42d7e04295c6e4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/uploadRecovery.js\":\"ff39f8a6cf573b44\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/uploadStore.js\":\"8fc3d410b877c79a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/attachments/useAssetObjectUrl.js\":\"7f50e6a62c83d558\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"982f141c384ed858\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ebe2929c3359e403\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks-view/facet.js\":\"b347e61cab55c9b9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks-view/index.js\":\"c9fa7640cf66c3c4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks-view/prop.js\":\"55a65f9c861ab4f0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/BacklinkFilters.js\":\"837f018d89fae963\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1eea90cbe2599831\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/BlockEntry.js\":\"006ca142005dd38e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/LinkedReferences.js\":\"12a794a87fc26981\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5e7046949ba8ebe3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/dailyNoteDefaults.js\":\"3e21604cbb7a9612\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/dataExtension.js\":\"f323ddac38373920\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/edgeExclusions.js\":\"f50be67a67bdd0e3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/filterProperty.js\":\"8dd7adebbaeab70d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/index.js\":\"a18d46ebcc6d37df\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a348b9d2296b7fee\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/inline-counts/applies.js\":\"b1de5c833b7591c4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/inline-counts/countQuery.js\":\"5bf9a0c9e338a454\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/inline-counts/expansionStore.js\":\"03035621d4206dd4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/inline-counts/index.js\":\"ca5506dd5213db0b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d81a54d57a99ae27\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/presentationInvalidation.js\":\"c682b8c8738cb9e3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/propertyEditorOverride.js\":\"badb35171b76150f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/propertyFilter.js\":\"85a2ea5029b91b49\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/query.js\":\"06dddaf54a79f212\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/resolveFilter.js\":\"163568f6a525489d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/sourceBatch.js\":\"eb4de0f700489cce\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/sources.js\":\"07ee0038f42d4727\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/useBacklinks.js\":\"c71149e0dfafb72c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"023ff20edca8b8db\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/birthday/BirthdayCelebration.js\":\"0d25fe3fbd0346f4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/birthday/BirthdayOverlay.js\":\"7346e191c2015a55\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/birthday/gate.js\":\"7d9d81739dd0dd4c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/birthday/index.js\":\"8c61ab6b69e88de4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/birthday/wolfTheme.js\":\"ca7fb649858faff0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-drag/BlockDragLayer.js\":\"34f857c075cab886\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-drag/dragController.js\":\"4196961641036c47\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-drag/dropTarget.js\":\"3b73835474421b46\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-drag/index.js\":\"cf8b80978f68cd10\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-drag/projection.js\":\"202e267c0bccfcef\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-info/BlockMetaCard.js\":\"c15221fe7fd42e34\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-info/index.js\":\"062da15abb5b708f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/AddTagDialog.js\":\"7a3d4b1c59ee046f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"000ff3fccd04b916\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/TagNameIssueHint.js\":\"d9797c1df3b33bdb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/addTagAction.js\":\"c28d8c598914f057\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/appendTag.js\":\"81c51057043674ab\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/config.js\":\"5e2335fff22ed485\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/dataExtension.js\":\"4a0dccd5fccaf1cb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/index.js\":\"d4b35672ca103027\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/block-tagging/propertyEditorOverride.js\":\"b7d8bb99bb6522c8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/BreadcrumbList.js\":\"eb77f41ae5e9056e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"33365be9f2effc41\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f3ef201d5938a2d9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"16afaba6467d2e8d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"388e62fe4787db69\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/index.js\":\"501d41641b3595e2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9db7da920e3e4394\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/CharacterCountItem.js\":\"d576dd11e7ac813b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/ProfilePropertyEditor.js\":\"25f44093f418cb48\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/actions.js\":\"f10dba1ce683a0e3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/blockType.js\":\"2fdc51d842c6fd78\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/charCount.js\":\"d30e1db489a7d643\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/dataExtension.js\":\"ec4b19bb7e91f620\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/index.js\":\"e0c5e30ac3905a2a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/profiles.js\":\"45f7f8128a4e0f74\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/properties.js\":\"c340c09bad90f935\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/character-counter/textCounts.js\":\"46d7f270cf575a8c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/colemak-keybindings/index.js\":\"d59eef9f365d57e6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/CommandPalette.js\":\"a83b8e228303705c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/HeaderItem.js\":\"aa0441a1c525cadb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/context.js\":\"32c0c2e8770b28b5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/index.js\":\"f5ab6803afea2c40\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/selection.js\":\"ff6e674f7f73f700\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/toggleStore.js\":\"0f03a688defcf184\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/command-palette/useCommandPaletteActions.js\":\"b81a50a43920eca5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/ContributorBadges.js\":\"846294f660f25bfb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/author.js\":\"f71d2a18352b58c6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/codeMirrorExtensions.js\":\"6c450c43ef7eb653\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/dataExtension.js\":\"a8725a9b76cfbacb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/index.js\":\"f1f6c8e5c84a4ce7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/mentionAutocomplete.js\":\"12085df53c0be440\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/processor.js\":\"f46c75cebd0ed0ba\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/profiles.js\":\"dba283ff3587100d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/queries.js\":\"b54521340e50041c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/contributors/schema.js\":\"1d509a792db81428\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3b6bf85fa9fcd21c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0c3844f35a7806d2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/cursor-follows-scroll/index.js\":\"82260965577f0922\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"151b586faba255b1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"39203a004ed4e424\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/CalendarGrid.js\":\"819ee4347a9e5b5c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/DailyNotePicker.js\":\"b3fc9d732d352abf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ab3e65e1d1411de6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/DateNavDecorator.js\":\"6ac9768435bb249f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/DateScrubOverlay.js\":\"b39a74527b171abe\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/HeaderItem.js\":\"b921e15e2a4f1f4c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/ReschedulePicker.js\":\"e0bf76ff20ec3a47\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6b0138332ddc4722\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/actions.js\":\"e7b17d5924bd748d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/blockDateAdapter.js\":\"1e7cf627f37ec6f6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/calendar.js\":\"25bebd52b39e6187\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dailyNotes.js\":\"89db6dccd13615a0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dataExtension.js\":\"65989a06e4169845\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dateScrubActions.js\":\"16f4c6656935adbc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dateScrubGesture.js\":\"327f605d75d546cf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d7a2861327cddad8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a39220a94710a888\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/deletionGuard.js\":\"c0d9200038790526\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/dueQuery.js\":\"91f12d28986b2160\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/index.js\":\"adaa848630168923\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/landing.js\":\"c567297f94039455\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/localSchema.js\":\"012fe6dbc8dae219\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/referenceDateAdapter.js\":\"e46c720544cb9bda\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/rescheduleAction.js\":\"dd60553c9db26371\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/schema.js\":\"8ed23cf246dc479e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/spreadBlockDates.js\":\"de12cd9e0b21b507\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/spreadDatesAction.js\":\"a3091eaaf71a9edc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/today.js\":\"936acfdeb4799821\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4cb4fd128c242ff0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5f52e1f7103824ab\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/audit.js\":\"080bf5d147805a4a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/auditAction.js\":\"62cd546f3cafcba7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/auditRanges.js\":\"5f1745897a5bd8ea\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/diagnosticsSource.js\":\"cf418e1182d0aa91\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/divergenceScan.js\":\"4f3e8a6c038cce3c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/index.js\":\"1710f96622fe70bf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6b1ed0ed31d6874b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/referencesMirror.js\":\"cf1a813587eba345\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/rowJson.js\":\"b35166f7e23dd039\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/schedule.js\":\"7f7f584fb8e32c94\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/data-integrity/store.js\":\"360ea6ac8927c97e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-maintenance/action.js\":\"a74d913512d3ea22\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-maintenance/index.js\":\"a56957ac2a6ce628\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-maintenance/plugin.js\":\"61955e0a0163897a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3d95a316b653dbf1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/actions.js\":\"ca0573173e9f61c9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/changeMarker.js\":\"250dbe03e6e3534c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/diagnostics.js\":\"227edf6b274875c6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/fileSystemAccess.js\":\"01fe9a7ecac6a488\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/filenames.js\":\"2eca4466bc3ce9e2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/index.js\":\"4a2ca7f9d694c655\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/mirror.js\":\"5d25bff674313b47\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/runLock.js\":\"c02cf856368c09e9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/runtimeHealth.js\":\"adb549c81ac1a76e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/schedule.js\":\"e906882d5d476feb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/db-mirror/store.js\":\"70fa3f46d117ea71\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/default-themes/index.js\":\"c010dc74fa7636a7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/default-themes/themes.js\":\"e1405b93a8da471e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/diagnostics/facet.js\":\"8ecfdd35d1b56d3b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/diagnostics/useDiagnostics.js\":\"0d8263d5a62da8a5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extension-prompts/dismissals.js\":\"4de0a21e3c8b61bd\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extension-prompts/index.js\":\"25187b6a5f966842\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extension-prompts/status.js\":\"120d80d360bd4301\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extension-prompts/store.js\":\"683bc36924b3acf6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4e71b04503f0b035\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f70719ee9a062d9b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/actions.js\":\"62a4cdbe6434ecb4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/config.js\":\"47c8830daf546f3e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/dataExtension.js\":\"1c739aede12f45d8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/effect.js\":\"858743ed869f3ea1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/index.js\":\"b46c89ebb10491a5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8bbd05f17a754d09\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extensions-settings/useToggleTree.js\":\"7b0cd38a5c9272a5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extract-type/ExtractTypeDialog.js\":\"77bae903b811a50c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"adada1f46a60a028\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extract-type/PropertyShapePicker.js\":\"c88f98be792676be\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extract-type/action.js\":\"c8d84a7ca85c8997\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/extract-type/index.js\":\"ab89781e2f0a37db\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/FindReplaceDialog.js\":\"bf042ff8bee1dea7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/HeaderItem.js\":\"f906189480ddae06\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/dataExtension.js\":\"00f410eb641af171\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/index.js\":\"a6fb03e5df53e567\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/search.js\":\"7e32149c009a4752\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/toggleStore.js\":\"f29c80dac9ce19a2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/LocationPropertyEditor.js\":\"3e8fd8dbfc51e196\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/MapView.js\":\"3c3ca3587463dd11\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/blockTypes.js\":\"1d07f2447c8d89a2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/codeMirrorExtensions.js\":\"fe0364671c63ca6f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/createOrFindPlace.js\":\"43382f2df66bfde3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/currentLocation.js\":\"6894ae452fe8e60d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/dataExtension.js\":\"abcd647dc1718210\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/geoContentDecorator.js\":\"2a17d355701b4a3f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/googlePlacesClient.js\":\"89c6b50c73f697ae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/index.js\":\"d3abcdca35b6b463\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/locationsPage.js\":\"ff3902b15bc9759d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/mapViewport.js\":\"1aafcf563c9bf33a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/pickCurrentLocation.js\":\"f32cd46563bf8adc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/placeAutocomplete.js\":\"14d322690b74cfdb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/placeNameCollision.js\":\"f98297fb79e110e6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/properties.js\":\"63ecb0265f2de15c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/propertyEditorOverrides.js\":\"350e4ccb3603f445\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/query.js\":\"5f9ad0277c6beb74\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/geo/usePlaceSearch.js\":\"5d7f6e5d4dce42ed\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"541bc09529392caf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3407a5204f39e45d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9db78b6d1f4d557c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/config.js\":\"0ede929ebad32cdf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/dataExtension.js\":\"5f7a4c88c845b986\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/facet.js\":\"6438d3acd92f3179\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/grouping.js\":\"dec28ec41b3b0581\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/index.js\":\"b1e4acbd1588c9f0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"92a18edf395581d5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/query.js\":\"83eb13d5e0735583\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/resolveConfig.js\":\"90f4affd1ed9a7f4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ebd9290a7e4e37a0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1308d7170787cafb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/HtmlDocumentContent.js\":\"cc7d817cce6f18dc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/HtmlFrame.js\":\"f04dafa32568f1ff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/actions.js\":\"43c07fe1849b0825\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/blockType.js\":\"944c475ce35f7d83\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/confirmRunScripts.js\":\"d5dbfa5b1033792a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/dataExtension.js\":\"b4b4a77528eced27\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/frameAnnotations.js\":\"2db58220f8d3177a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/frameDocument.js\":\"35f5b0867f9c8a75\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/frameTheme.js\":\"581b4269b72c4462\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/index.js\":\"ceb3bf92df35b0b4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/scriptConsent.js\":\"67cf267f17bc5189\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/sourceMap.js\":\"a9d4b8ed3a71c792\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/html-document/useDocumentScripts.js\":\"d66e37a1ccae0fa1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/interaction-metrics/index.js\":\"6606e8c1e8c13ac5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/interaction-metrics/record.js\":\"794cf3843549b649\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/interaction-metrics/recordStore.js\":\"2805410a39414662\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/interaction-metrics/responsiveness.js\":\"98a52e7ababb92c7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/interaction-metrics/schedule.js\":\"cd9c30094dc1e948\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/interaction-metrics/sessionContext.js\":\"b52a2f12749e1dec\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"502cbbff75338eae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"30dd858f2fae27c6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/actions.js\":\"82335ab3a798f93d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/config.js\":\"78a6604efbd0cf63\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/dataExtension.js\":\"0edf7ff7b67c3f67\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/effect.js\":\"c626ae5e66d18339\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/index.js\":\"eecc175f8782957d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/keyCapture.js\":\"7cfc535be7e480b7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/overrideStore.js\":\"b66da66600e61480\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f30240509f0cd602\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/HeaderItem.js\":\"e60923b689885ac4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/LeftSidebar.js\":\"29f08bfaf4bac11a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/actions.js\":\"ac4393b8e658ef79\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/facet.js\":\"f0576a228d7a4708\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/index.js\":\"49cf6fe90efe8bfb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/shortcuts.js\":\"3b19c27418acef45\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/left-sidebar/toggleStore.js\":\"cd51205f52516e79\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/merge-blocks/MergePicker.js\":\"55e549a36ebb0b25\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/merge-blocks/index.js\":\"87da6deed84ea959\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/merge-blocks/mergeAction.js\":\"afe8ba4a6a2f9047\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/merge-blocks/strategy.js\":\"4b8286c60dea24dc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-bottom-nav/Button.js\":\"4ff5db0cc4a944b0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"db3c02b1ad738136\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8f01da312d278dd3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-bottom-nav/facet.js\":\"96417e318659d52f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-bottom-nav/index.js\":\"75209847fa273622\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d291d40991ad92b3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a18ae06375502b30\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ff8880edde5c3f64\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ae2fcbf11378584d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/mobile-keyboard-toolbar/index.js\":\"ac6af941fed31b24\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a0c6d43b8b078c38\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3738ba132f2b8f05\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/contextMenuItem.js\":\"7f6b75b82036520d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/index.js\":\"cd2fddd24c7d2023\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/moveAction.js\":\"4ee25ccb0d340732\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/moveBlocks.js\":\"832e467811f61504\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/move-blocks/selectionAfterMove.js\":\"47760ee76101d9f6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/TutorialBanner.js\":\"9af6e789044fc4b6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/action.js\":\"20b8fac82de0140f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/bannerDismissal.js\":\"8f328c25a0756271\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/documents/cheatSheet.js\":\"f2e1cb0a7cc841a4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/index.js\":\"acfbdbebc59a323d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/keys.js\":\"03a15d108cdc9625\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/landing.js\":\"e39ff6aa752aa5ff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/outline.js\":\"54428bb04c9df994\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/onboarding/seed.js\":\"8e7b3f2ed0186dff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a962429d8a43ba7c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/analyze.js\":\"46feb3cf29b26cae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/diagnosticsSource.js\":\"e84661d140087bf7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/index.js\":\"9ac25ce47183eeeb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/load.js\":\"75e1d48085ee088b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/monitorRun.js\":\"f196a667b1b8764b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/schedule.js\":\"698039c6c7f7d6b6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/series.js\":\"54f16a65dcef80ba\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/store.js\":\"ed55318169b05afc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/trendAction.js\":\"15d5bca814ae9942\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/perf-monitor/verdict.js\":\"92750cc506ebc2b4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/plain-outliner/clickToEditAction.js\":\"ebba5bd04c7e06ca\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/plain-outliner/index.js\":\"5a37d0fe7ea67a12\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/plain-outliner/interactions.js\":\"78d59a7e25039c96\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"28e9a735e0abe848\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/MigrationGate.js\":\"6456e11631ea85d1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/MigrationGateDialog.js\":\"4abbf532baa20d19\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/action.js\":\"a134cf68dab50e68\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/index.js\":\"e6005dae839eef1a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/localRunMessage.js\":\"5e1e443bfc459445\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/plugin.js\":\"bcbd3a8d3a8d2bb2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/progressReport.js\":\"b6433f01457bc043\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/properties-migration/sweepProgress.js\":\"d861cf126717f091\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/FieldRowRenderer.js\":\"1d7ed210bfe6d989\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/ValueRowRenderer.js\":\"75176d6f82745fa3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/actions.js\":\"c1cdb7102c244335\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/autocomplete.js\":\"6b9492cf72ff0aff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/fieldRow.js\":\"95ec155cfad55f25\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/index.js\":\"ebe346993d6f30d4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/referenceWarning.js\":\"d9db19c2b58a35ed\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/valueAutocomplete.js\":\"81540d6c5b330456\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/property-rows/valueSchema.js\":\"3ab51763a1d7aad4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/HeaderItem.js\":\"56b392309c72dd55\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/QuickFind.js\":\"7a36c66a18beac60\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/index.js\":\"ae3d059452386361\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/recents.js\":\"b7e1e366b27a1b1f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/resultItems.js\":\"250c02c628dffbb2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/selection.js\":\"fc1ce5ed1399ee07\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/quick-find/toggleStore.js\":\"0d3eb35ba0c5e845\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/recents/HeaderItem.js\":\"736a27b0513ed184\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d62007c76fa9f3d2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/recents/grouping.js\":\"2f955f9188b387c6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/recents/index.js\":\"8a2cc876092df42a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/recents/target.js\":\"1dd52ea918aa1bf4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/codeMirrorExtensions.js\":\"cafd2f7e2121bd6c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/contentPrefill.js\":\"dbb3b2b768b139ff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/dataExtension.js\":\"57c972d995a14845\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/index.js\":\"72e94626541d3ce6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"25e4982bfeb11795\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/invalidation.js\":\"5e418af6e01365ae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/localSchema.js\":\"6144dad85fd79de1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/blockrefs/index.js\":\"84cbc1fa18e8a26c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"84631610518e54d8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/index.js\":\"ef60cf9dab711689\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/referenceNode.js\":\"941a6c14712d1049\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6943ac7d224d95a4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"79bd250973aa8ae7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/wikilinks/index.js\":\"7ea5e8f25da15684\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"84e17b4d95ea06cf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"599e21b0daa9f66b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/mergeRetargetProcessor.js\":\"6952aa4103139e67\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/parseFence.js\":\"67d499e7cf2926b0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/referenceParser.js\":\"d42897d48ebcd934\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/referenceProjection.js\":\"e6edd9276d8ed294\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/referencesProcessor.js\":\"92d6dd11615e5998\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/renameProcessor.js\":\"d5aba7e9203ad6f4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/references/spanReplacement.js\":\"05d934e4a442ccd6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/rich-paste/htmlToOutline.js\":\"bf510eba766ec0a7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/rich-paste/index.js\":\"2f4713f875cce3ec\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fabd46f5a88fd201\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/rich-paste/pasteDecision.js\":\"cf0741b1cc7484f4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/action.js\":\"ec49adfa1fcda401\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/blockIds.js\":\"2eea49cd4074e790\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/content.js\":\"da5c8a78d3ec88cd\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/effect.js\":\"2fadf85ee98a7504\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/ids.js\":\"9be4a5bd35c6993b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/import.js\":\"abf08a48690f840d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/index.js\":\"c144ce4f72a72198\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/plan.js\":\"62566e9abecfad3b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/plugin.js\":\"4f7dafbfaaa2ce2a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/promotion.js\":\"3aa5c54a93d4ffd7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/properties.js\":\"47a4622b62be2403\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/references.js\":\"5ed57a2d90392b25\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/report.js\":\"94999cdaf0208d57\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/roamMemo.js\":\"c7475126c1892400\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/runtime.js\":\"eae1c859a07fda4a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/schemaReconciliation.js\":\"41d05ccf98097638\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/srsMarkers.js\":\"6c2d1ffe51226122\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/todo.js\":\"3e92e15a82c66cf1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/typeCandidates.js\":\"ffc59c5a2d67e77c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/roam-import/types.js\":\"739044e033579e0b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/search-health/index.js\":\"0c65dd2420a68a37\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/search-health/store.js\":\"19a4f3d4cdf5c697\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/shortcut-help/HeaderItem.js\":\"b00f358c9ccb3b67\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a688f6c526a82d61\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/shortcut-help/index.js\":\"64e5398837b9282e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/shortcut-help/model.js\":\"d90e0433542278d0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/shortcut-help/toggleStore.js\":\"08e347e2de0e0b84\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/shortcut-help/useKeyInspector.js\":\"f0e85bbdd31756d4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"853086ac6639363a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/ShellDecorator.js\":\"20d9ff353bf4b66d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/actions.js\":\"c7b87afe64ac0271\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f31d2f930ad39539\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/index.js\":\"b7e2715c718680ad\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/shell.js\":\"41e8dab89aa8784a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/surface.js\":\"82b6403a2e458b0f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/spatial-navigation/walker.js\":\"a11e32b8a8254831\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3eef84e049c58c32\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/dataExtension.js\":\"84e6d60e3c1f67e0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/index.js\":\"4f7b8513b28e6f25\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/indicator.js\":\"93a24013fcff7f3d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/moveSrsState.js\":\"0f340b964ed30a2b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7cd379532083a97a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/scheduler.js\":\"73705bc34239ddd5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/schema.js\":\"016b8221bcae95d3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"182b7c426b119105\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/srsClipboard.js\":\"2cab37e4d38dcebc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"597d478925f88ca8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1a84bd8f1c21d819\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/DeckPicker.js\":\"8f2ca5b55def8efe\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/ReviewControls.js\":\"68238a24348a6d63\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/ReviewDeckRenderer.js\":\"66a357190d032cec\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/ReviewSession.js\":\"9b1dd2b951cac5c8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/actions.js\":\"4f90459233ce3c27\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/archive.js\":\"be098cdf496c8d7c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/dataExtension.js\":\"c9efdf8c2fb820e5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/deck.js\":\"cd76fc3b86cbcba6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/dueQuery.js\":\"ed16048425587bac\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/gradeDecision.js\":\"75aaf37758d57997\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/index.js\":\"14bd4364290ae223\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/keyHints.js\":\"5a25b9945fa7db7b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/reviewCardLayout.js\":\"2f0b9258c298cd2f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/reviewProgress.js\":\"bf5920441d85fda2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/schema.js\":\"9e1ea5e39c4393b0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/srs-review/useDueCards.js\":\"d8f6c68b27867b1d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/startup-metrics/index.js\":\"57c6bf28b2b8771e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/startup-metrics/record.js\":\"6408afac10f80741\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/storage-persistence/index.js\":\"1cc192e582b1dcac\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/storage-persistence/persistenceStatus.js\":\"ff8a946660e81b5d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/storage-persistence/requestAction.js\":\"ea46c5ec605f224c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/supertags/TypeChipsDecorator.js\":\"f2ac82c395e0b716\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/supertags/codeMirrorExtensions.js\":\"ab501d7c0d32bd91\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/supertags/index.js\":\"657d81ca9aec4b9d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/supertags/typeAutocomplete.js\":\"de230f857c8bbc23\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0892b3b255bc300f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/actions.js\":\"e2347affe8a60e5b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/anchor.js\":\"7eb4cedc40efdb6e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/events.js\":\"a87184b9dd5a7578\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/gestureActions.js\":\"88ca0eb64a4b1941\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/index.js\":\"94a66f223081f14c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f6f57ae4005d5f63\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/sync-metrics/collect.js\":\"52235e126d3d60c4\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/sync-metrics/index.js\":\"b5b5fc9e2dbc29c7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/sync-metrics/record.js\":\"f06adbc65f777752\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/RejectionDialog.js\":\"1d7c0b58fa053512\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c559634edd1e8d33\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/index.js\":\"65268aa8c54ae932\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/model.js\":\"88de92fe9f226975\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/queueCounts.js\":\"e94b02df910647d1\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/rejectedHelpers.js\":\"46daed0230eab433\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/rematerializeAction.js\":\"b1d531b25dd92f2e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/system-status/useHysteresis.js\":\"b4d69b7b837d2e4d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/ColumnHeaders.js\":\"4534843a683b83c5\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/QueryUi.js\":\"1a4fe60b1e063dcc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/TableLayout.js\":\"ad1792f90e0bea8b\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/actions.js\":\"e5c63d8d5efb933f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/cellEdits.js\":\"f06643ac914648ea\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/childrenViews.js\":\"55aca7aa9ce615bc\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/columns.js\":\"675a76902842356f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/controller.js\":\"bcd32ec4cdebf108\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/convert.js\":\"00951ecb6427dfc6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/dataExtension.js\":\"2ee66f3012f43fff\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/index.js\":\"3105941df0def15d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/keys.js\":\"388d90e76f84c979\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/model.js\":\"b2e15bb6c5c80828\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/navigation.js\":\"1beb1281717522bd\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/query/backfill.js\":\"1eef5bd15990935a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/query/completion.js\":\"e722606cfd213bea\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/query/format.js\":\"7256caf6a85eafb7\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/query/parse.js\":\"d3754521b7048fb9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/query/queryValue.js\":\"070f8839f04ce399\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/query/source.js\":\"27d3e44c10678093\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/registry.js\":\"ce4d76e3dc79542a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/rowGutter.js\":\"feac9723aab57fd9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/rowVerbs.js\":\"94f459de47132eb6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/schema.js\":\"86930a15dc4187ef\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/tables/sort.js\":\"c7f286d449b5a6f6\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/theme-toggle/effect.js\":\"2120f47df6be94fd\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/theme-toggle/index.js\":\"58783806fd138ff0\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/theme-toggle/theme.js\":\"da047c1794e516ae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/todo/actions.js\":\"cf9efd62bd7c9f65\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/todo/dataExtension.js\":\"39c438b8bbbf162d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/todo/index.js\":\"cc0012c8a4c6ad04\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/todo/schema.js\":\"1da8c20f49cfee92\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d8e9b2d839a514c9\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/touch-selection/actions.js\":\"59d55a9341a16111\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/touch-selection/defaultItems.js\":\"3e83b69110907260\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/touch-selection/facet.js\":\"74afbca43cb6834f\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/touch-selection/holdRecognizer.js\":\"a9441ba29223f96d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/touch-selection/index.js\":\"f8f46ede00bc473e\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/update-indicator/UpdateIndicator.js\":\"2a223a6bf1bbcda8\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/update-indicator/index.js\":\"91fb1c2304f9288a\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/update-indicator/loadTimes.js\":\"d19e77c304728d8d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/VideoNotesRenderer.js\":\"665bad97e932a071\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/VideoPlayerRenderer.js\":\"f55d24cedbf73021\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/VideoTimeStamp.js\":\"e30ea793c5425669\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/actions.js\":\"bdd1eb0ad2301163\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/index.js\":\"81f17b414b7b8c05\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/markdown.js\":\"2851df62cc773783\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/notes.js\":\"409d2d92561ea8ae\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/registry.js\":\"db68b5e445c2a66d\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/remark-timestamps.js\":\"b7e9ca73178d4bbb\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/video-player/view.js\":\"2120348bd0469ba3\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-link-hints/LinkHints.js\":\"3354d52a51a78762\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-link-hints/index.js\":\"0d8bb559417645ce\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-link-hints/model.js\":\"a3bd1b50a99d7045\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-link-hints/settings.js\":\"0926300ef83487fa\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-normal-mode/actions.js\":\"3b968c0335ba8fcf\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-normal-mode/index.js\":\"552240fe57a5afb2\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/vim-normal-mode/interactions.js\":\"e8a6fa702bcc983c\",\"/knowledge-medium/pr-preview/pr-1870/src/plugins/workspace-header/index.js\":\"1bcc253a5904a001\",\"/knowledge-medium/pr-preview/pr-1870/src/registerServiceWorker.js\":\"5b987e33f119f210\",\"/knowledge-medium/pr-preview/pr-1870/src/requestPersistentStorage.js\":\"5ea168abbd15f0c3\",\"/knowledge-medium/pr-preview/pr-1870/src/services/authRequestDeadline.js\":\"40a62af3a8e68c8b\",\"/knowledge-medium/pr-preview/pr-1870/src/services/authStorage.js\":\"eb1c48e02da00680\",\"/knowledge-medium/pr-preview/pr-1870/src/services/powersync.js\":\"e3d4a2a607f72af4\",\"/knowledge-medium/pr-preview/pr-1870/src/services/supabase.js\":\"7dc206bb696f561b\",\"/knowledge-medium/pr-preview/pr-1870/src/services/uploadErrorClassifier.js\":\"3b0527450ccf90d8\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/ActiveContexts.js\":\"e331989fd6189d0f\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/HotkeyReconciler.js\":\"de0f11722fff2974\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/WipeLocalDataDialog.js\":\"77aeb24adc85c09f\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/actionDispatch.js\":\"47195f56039e967c\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/actionRefItems.js\":\"045fe2471598862c\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/applyKeybindingOverrides.js\":\"daa97d7c000f4ef6\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/blockActions.js\":\"9210671f757876cc\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/blockMergeGesture.js\":\"23e5af33987a3d79\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/canonicalizeChord.js\":\"c93757fde30002e6\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/defaultContexts.js\":\"0bb5e03a052ab881\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/defaultShortcuts.js\":\"0ec60e1622b7be69\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/effectiveActions.js\":\"efb0462291dee710\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/gestureAction.js\":\"f08aab9e5126122b\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/gestureBinding.js\":\"4cd807812289ada5\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/holdRegistry.js\":\"67cce75148d5dae4\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/keybindingConflicts.js\":\"5c0821c07cd1fe68\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/keybindingOverrides.js\":\"19e7967f8f787b44\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/pointerAction.js\":\"1b3189d7162d3598\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/resolve.js\":\"cf9fd9460cd40a16\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/runAction.js\":\"9fc21d6b4f47536d\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/sequenceMatcher.js\":\"c3a5a24f6b303abe\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/types.js\":\"e90aeb782634b242\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/useActionContext.js\":\"de0c1f3e773dd644\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/useActionDiscovery.js\":\"c1579c28ca4b2007\",\"/knowledge-medium/pr-preview/pr-1870/src/shortcuts/utils.js\":\"0e9ee7372d7a5ca9\",\"/knowledge-medium/pr-preview/pr-1870/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1870/src/sw/bootStore.js\":\"04ff96c0ba7c5437\",\"/knowledge-medium/pr-preview/pr-1870/src/sw/previewDatabases.js\":\"75dc89da3ed8b4db\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/byteTransform.js\":\"1acfb93408564d60\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/attachmentCleaner.js\":\"9f879e469d4e0916\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/bundle/attachmentParts.js\":\"0ccc0d69ccc471e9\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/bundle/bundleParts.js\":\"f3176bcd2f326a7f\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/bundle/bundleRecord.js\":\"901bdd15e612375e\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/bundle/manifest.js\":\"1182d7ddbef1a623\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/bundle/takeBundle.js\":\"0fda0ed448d3bd2e\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/bundle/verifyBundle.js\":\"8fb69afcac35f408\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/cleaningStage.js\":\"a47e12f330999e80\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/conversionKey.js\":\"74eada2c264cccef\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/conversionServer.js\":\"c35098dc65806a14\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/flip.js\":\"c220c41a9e4f434a\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/flipAttempts.js\":\"c92d06590c8e6581\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/pages.js\":\"e9e6362a4962c4a4\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/preflight.js\":\"4a1eef781f78c13f\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/reseal.js\":\"63e9fba48d1f20be\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/runConversion.js\":\"aa6b6e84cdfa3c54\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/runLock.js\":\"905c51fb30f2e9bc\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/sealing.js\":\"541434bc8d387dc8\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/sealingStage.js\":\"59bfe1496c7de738\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/stage.js\":\"76403548d6d1748e\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/conversion/verifyReseal.js\":\"437155d52f4c87a2\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/aad.js\":\"c11e8bf02a444fd2\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/aead.js\":\"242d50bcfdd65827\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/base32.js\":\"a620c47a7201ea16\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/base64url.js\":\"0f68d1bd18f41bd3\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/binaryEnvelope.js\":\"a3696f1bc41d608a\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/byteAead.js\":\"4565d0f684330c4e\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/canary.js\":\"e472934d51323bfc\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/contentHash.js\":\"3775b14fa2eff1d1\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/contentKey.js\":\"3a774aa5108c1d2e\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/derivedIdNamespace.js\":\"bb097b5d81417cf6\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/envelope.js\":\"56aeb488739efc2c\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/hex.js\":\"03c968b1c6e39848\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/sha256Hex.js\":\"d0c5c3b24de2e981\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/crypto/workspaceKey.js\":\"d17f285ccf86f09a\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/conversionState.js\":\"4da50c01d5038078\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b03d70c9a8ae9214\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/flows/pastedKey.js\":\"9a0ac515af23160f\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5435f2c7d8541726\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e7192dae717c9d26\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/keyStore.js\":\"01e4020c40bbf864\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/mintWorkspaceKey.js\":\"2c983db4f008a084\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/modePin.js\":\"7dd7c4581bd42eed\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/openWorkspaceKeys.js\":\"95dc7282ba0edafa\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/resolveWorkspaceEntry.js\":\"2896be3f392686de\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/resolver.js\":\"64a6353f6b46be86\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/keys/workspaceAccess.js\":\"8d63a2a96abe3906\",\"/knowledge-medium/pr-preview/pr-1870/src/sync/transform.js\":\"aca732d2ede19cfd\",\"/knowledge-medium/pr-preview/pr-1870/src/themeBootDefaults.js\":\"a31bda888bdc81b3\",\"/knowledge-medium/pr-preview/pr-1870/src/types.js\":\"d7acbc4bc96812e4\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/ClientLocalSettings.js\":\"96661bbadc8357c6\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/abortableSleep.js\":\"e2e2fc01f6f7541b\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/array.js\":\"81de9584664dce3f\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/backlinkAutocomplete.js\":\"b1c72565517a5ea0\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/blockCrumbs.js\":\"7118edaa48b5ac4c\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/blockrefAutocomplete.js\":\"b5c5ebc1e809d193\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/cadencedIdleJob.js\":\"aa05686d2488e4eb\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/callbackSet.js\":\"387340aab29bb7fe\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/clientId.js\":\"bd4aa4fd12479a58\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/codemirror.js\":\"5cc328a5b87348dd\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/codemirrorCompletion.js\":\"f0326372853345cc\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/copy.js\":\"5b0606e4fe91b4e5\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/dailyPage.js\":\"c92c432dfb5ab67a\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/dbForensics.js\":\"2bafd7c21777cac0\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/dbForensicsHooks.js\":\"fab39456f0955655\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/deleteBlockThroughUi.js\":\"21b73c105666b7ae\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/dialogs.js\":\"11fc4c31f10d17a9\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/dom.js\":\"1723505d2c3af7ee\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/downloadBlob.js\":\"b7466ebcee4dd188\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/exportSqliteDb.js\":\"b62d3965ca59b736\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/fileSystemAccess.js\":\"73ceeb4e01d3169e\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/flipSlide.js\":\"95b6fdcd96b0051e\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/fnv1a.js\":\"08fb943ad1e271ff\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/formatBytes.js\":\"2b45467b24bebfac\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/fuzzyRank.js\":\"48fe908edfe2dbae\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/idbKeyedStore.js\":\"3f2ed10ebaa646aa\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/idleCallbackPolyfill.js\":\"96536e8dbe2d0f7d\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/keyboardAwareScroll.js\":\"c2ef990954d8bf61\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/keyboardViewport.js\":\"dc647341702e92b3\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/lastWorkspace.js\":\"7c7bf4e5625ad89b\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/layoutColumns.js\":\"c5cdcf638b357c41\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/layoutSessionDom.js\":\"8bdf92e4b7eef7cb\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/layoutSessionId.js\":\"dbdd61e742426f5b\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/linkClickGestures.js\":\"0ef00e96fa0f4d73\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/linkTargetAutocomplete.js\":\"00b6688322bcd0b5\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/localDbCorruption.js\":\"96ba6801ea610877\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/localDbRecovery.js\":\"31a4344df6213145\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/markdownParser.js\":\"53b9eb7653377500\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/memoize.js\":\"81614ed1400cf453\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/nameFieldCommit.js\":\"d9e7a417f40b7a3f\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/nameList.js\":\"a7b6b358f821099a\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/navigation.js\":\"888699c804315d15\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/omnilinerNamespace.js\":\"7160ee41e5a4fd76\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/opfsPageScan.js\":\"4b5fdc8e919c31be\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/panelClearance.js\":\"05e4aba717dbce87\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/panelHistory.js\":\"3c0436918bb95d27\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/panelLanes.js\":\"e7e68fc5da596435\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/panelLayoutProjection.js\":\"f5c1ab4e33a96e7c\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/panelScrollAnchor.js\":\"6cd599aa1751bc08\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/panelUrlFlags.js\":\"cd62d9720f7cebe1\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/platform.js\":\"e2a68ce1ec139605\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/pluralize.js\":\"7a8461671b9aec03\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/propertyCreation.js\":\"2563a6a1a3458929\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/propertyNavigation.js\":\"8b555697cc2d0561\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/propertyValueContext.js\":\"a100df8fef1ee474\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/react.js\":\"31a514a0e39d804f\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/relativeDate.js\":\"7bc19daef4a680e1\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/relativeTime.js\":\"3bacf07b638228bf\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/renderScope.js\":\"1beeb71eb4a047fb\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/resolvedThenable.js\":\"f0f525b5bb64f5a3\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/routing.js\":\"fc605deafdbcf746\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/safeMode.js\":\"94bb47fc6bb05b60\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/scheduleIdle.js\":\"ee91d9e09bd08746\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/screenWakeLock.js\":\"dd27003925e6ab50\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/selection.js\":\"2651317141922414\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/softKeyboardGrab.js\":\"1805f6ec5b9e89f3\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/startupTimeline.js\":\"e629400c8b96669b\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/state.js\":\"b9f0b0fa9815780f\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/string.js\":\"0b948d432674652e\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/surfaceZoom.js\":\"eb9a6570f47eeca8\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/time.js\":\"6cf82fbb9d552186\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/toast.js\":\"d79e5d2d8933e895\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/toggleStore.js\":\"5ab4838cdeb495a8\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/untilStopped.js\":\"54713b8c35e853cd\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/userActivity.js\":\"849358f9078c5073\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/viewTransition.js\":\"81035d3603dfbeb1\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/viewport.js\":\"af71f8b52d455abc\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/webLock.js\":\"5a13873cfed8c8af\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/workspaceRecovery.js\":\"69dce36406c1cb5b\",\"/knowledge-medium/pr-preview/pr-1870/src/utils/workspaceSnapshotStore.js\":\"6bf3b41747d05a6a\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-compiler-runtime.js\":\"e102aab224b90ee8\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom-client.js\":\"71c30ed57536c060\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom-server-edge.js\":\"5bf8337447de9c0a\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom-server.js\":\"8f291d2cee47f501\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom-static-edge.js\":\"2e4cb0ebb366d491\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom-static.js\":\"b8a6be3a2a5ec361\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom-test-utils.js\":\"f99f305793c74df8\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-dom.js\":\"5782d06124837b54\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react-jsx-runtime.js\":\"5213756a966c93c1\",\"/knowledge-medium/pr-preview/pr-1870/src/vendor/react.js\":\"a948ad320b764ea9\",\"/knowledge-medium/pr-preview/pr-1870/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1870/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1870/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
