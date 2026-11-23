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
		buildId: "917e7aa1c6c8-78567eb6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/\":\"20f0f015eb61afd4\",\"/knowledge-medium/pr-preview/pr-1871/index.html\":\"20f0f015eb61afd4\",\"/knowledge-medium/pr-preview/pr-1871/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1871/assets/FacadeVFS-5-Rp_pVQ.js\":\"f53bdf1ce146c6c8\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSCoopSyncVFS-B83hK4f3.js\":\"2c426a8314537c3a\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSWriteAheadVFS-CzKeCFKl.js\":\"5e5fb96846c41f54\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-BBsewdBI.js\":\"28add0a885c8a072\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-De1cUen-.js\":\"fa7a324e3160c659\",\"/knowledge-medium/pr-preview/pr-1871/assets/worker-COJ-N9bu.js\":\"790a91f589ff8639\",\"/knowledge-medium/pr-preview/pr-1871/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1871/chunks/app-SsbO_flp.js\":\"85c8de375d3c443e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1871/index.js\":\"cb375d137262c2d9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1871/assets/AccessHandlePoolVFS-BYuHB7sq.js\":\"72973f7422af2382\",\"/knowledge-medium/pr-preview/pr-1871/assets/IDBBatchAtomicVFS-Ds943PgS.js\":\"7f92d120076c07f1\",\"/knowledge-medium/pr-preview/pr-1871/assets/MemoryVFS-CO5l7-I2.js\":\"248838b44ab2f0ea\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-CU-A7mYV.js\":\"4716fd8b6dfea46e\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-CVdZB38t.js\":\"0c70278555fb30cb\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1871/chunks/AccessHandlePoolVFS-CLRcOfPh.js\":\"3a4b937472f7c9c7\",\"/knowledge-medium/pr-preview/pr-1871/chunks/FacadeVFS-BSggi0Q3.js\":\"5330cc1e297ef122\",\"/knowledge-medium/pr-preview/pr-1871/chunks/IDBBatchAtomicVFS-DJDtTOyT.js\":\"de70e0c3d3ce778e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/MemoryVFS-Bqb4VSh9.js\":\"0a8da5852ff5e53c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSCoopSyncVFS-CNrYcSSN.js\":\"7019cdf5fdbe86be\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSWriteAheadVFS-DYwt_13V.js\":\"55abff55ced886e9\",\"/knowledge-medium/pr-preview/pr-1871/chunks/Preview-vFmmlbUb.js\":\"c0a66bdafecbc00b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/card-Ck5pYAqB.js\":\"a164758204f67cec\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-D3Gm-JbS.js\":\"80eb6c810fbe2698\",\"/knowledge-medium/pr-preview/pr-1871/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-CvTZkBC2.js\":\"d6ebcaa7e42d86b0\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-async-Cj4H6ekn.js\":\"6acbf23af4f49988\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-BN5N5SkD.js\":\"a906a42e0160b566\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-BepicW8K.js\":\"7961792d3c29cdb9\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-CJPN3QDI.js\":\"e53af4f32bfdfc2a\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-CuDPlsj1.js\":\"560e06437fcfa524\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-DQ2ILRER.js\":\"7f47b9b4a545ec6b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-DXF1h8a1.js\":\"ee4162c9322f1ac8\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-c7iZxJ6V.js\":\"a65a489c8af0ff6d\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server-legacy.browser.production-DwKluoVL.js\":\"a9c059ea52afc0d2\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.browser.production-D_lpSizX.js\":\"4cb751fb078d11c5\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.edge.production-DPLQejrG.js\":\"97909292e2459620\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-vun_R-RW.js\":\"c6feb9e3e00578b4\",\"/knowledge-medium/pr-preview/pr-1871/chunks/server.browser-DSo4jOun.js\":\"1fd2f0934d8d875f\",\"/knowledge-medium/pr-preview/pr-1871/chunks/textarea-C2SIeRPx.js\":\"4df661a49641e38b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/ui-DR0Vxta5.js\":\"1766a7dc83243ca7\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-CgBhpLTs.js\":\"ef6b03adbe20b8b1\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-async-CyAgKzcU.js\":\"12e2e079e00ddf1b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1871/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/src/App.js\":\"1431d91fc3410ab2\",\"/knowledge-medium/pr-preview/pr-1871/src/appUpdate.js\":\"26565a4e72a3d576\",\"/knowledge-medium/pr-preview/pr-1871/src/appVersion.js\":\"bb48386c9484f697\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/initialLayout.js\":\"7972bdc0a517dabc\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/openWorkspaceData.js\":\"37d6d171089f257c\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/resolveWorkspace.js\":\"5ad28c64bba0d85f\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/workspaceBootstrap.js\":\"ec10144ad3f6054e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockComponent.js\":\"e7ce6fb87ec544e3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockCrumbs.js\":\"79032214228bc95b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockEditor.js\":\"2b223c836c6d4956\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockLoadingPlaceholder.js\":\"515d53c10634e747\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockProperties.js\":\"849c1ede5a76492c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockSearchPicker.js\":\"941c525c4692918a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ConfirmBulkDeleteDialog.js\":\"b37acea51d991349\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DividerHandle.js\":\"729c6489450715f7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DraftEditor.js\":\"12219c2b5bbcb785\",\"/knowledge-medium/pr-preview/pr-1871/src/components/GutterPill.js\":\"ca0484afbbb39cde\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Header.js\":\"c6b02f95f2d987c2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/LazyBlockComponent.js\":\"cf64d988c7c15f20\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Login.js\":\"dbf1cfba6731dcce\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ZoomableSurface.js\":\"26507bb29e521687\",\"/knowledge-medium/pr-preview/pr-1871/src/components/editModeKeepalive.js\":\"47bb7099991e9705\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyDisplay/PropertyDisplayScope.js\":\"05ed1dcf98941cde\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b8e59f30927867dd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefPropertyEditor.js\":\"8a1b24963e72f89a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefTargetTypePicker.js\":\"28382843c990b7c3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/SelectPropertyEditor.js\":\"f77db965838fbcb6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/TypesPropertyEditor.js\":\"028c665bd4095c03\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/defaults.js\":\"641c7af4f9b9643a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/kernelValuePresets.js\":\"06ba702242d7f96a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/selectablePresets.js\":\"1bf94bb3c7c64893\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/typesPropertyUi.js\":\"4163a847dd12b9c2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/AddPropertyForm.js\":\"83c36f052953ca3e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyPicker.js\":\"287615206a1e76eb\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyRow.js\":\"e0baf9c9a262c997\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/Rows.js\":\"4d13837e9480d427\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/actions.js\":\"8ac4c06ebb4f57b1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/declarationOnly.js\":\"a895c3827bc8725f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/layout.js\":\"66c8c47552c57ed4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/model.js\":\"56ae37f854f2cdba\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapeUi.js\":\"e8689fd2140f706f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapes.js\":\"606e8e8df7817dbf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c0c31411c88dbbc2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/visibility.js\":\"758640e96efb8193\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanelSections.js\":\"a0410c86439cc24a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockEmbed.js\":\"17c1461fcadd62d5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockLink.js\":\"20d14245f2cf98ff\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockRef.js\":\"f1b0b82407a8da83\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/ReferenceLink.js\":\"1502e15b34eb3367\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuard.js\":\"ae6cb78fc0330742\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuardContext.js\":\"05251bb500ffa85e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/linkInteraction.js\":\"5b65d7e24d4c4a88\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/referenceLayout.js\":\"330594af10d19957\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/useBlockRefAncestors.js\":\"7f60e0b19e2594ed\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockGutter.js\":\"1435b0881e257238\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockInfoDialog.js\":\"79fa449a369ac8e4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockTypeBlockRenderer.js\":\"5972daad20b1135d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BulletHoverCard.js\":\"e6e5fd19697d9d96\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorContentRenderer.js\":\"7dad823765cd4d87\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1c93c0916e97be3b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ColumnResizeHandles.js\":\"1b9c253f90bbcd43\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0a1ddb9d0dbe9bbd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/DefaultBlockRenderer.js\":\"dde9881cdb840278\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/LayoutRenderer.js\":\"6a87d4ac2c8e545e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MarkdownContentRenderer.js\":\"e65b3b8efd9792f0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MissingDataRenderer.js\":\"4035d98286cb7b94\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PanelRenderer.js\":\"fe1e6b5d5a861987\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PropertySchemaBlockRenderer.js\":\"da6bb3d19fd012ca\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/TopLevelRenderer.js\":\"e1cb8a49e752c4fd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockGutterMode.js\":\"2324dc85af123e33\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockTitleText.js\":\"80bf6bdbcde65bb3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/fieldCreationKeydown.js\":\"cd11fa46d4d5d9a4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/layoutRootContext.js\":\"dbfe74e4a7494841\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/TypeChip.js\":\"46151b32ffb8ac4d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/chipStyle.js\":\"ae956e0e52612466\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/anchored-floating.js\":\"bf836c3954120165\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/button.js\":\"a5c37b0403c68a48\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/card.js\":\"1979ab39e44387c1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/checkbox.js\":\"d06ecf06700d1bdd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/collapsible.js\":\"5ba6ff43474d069e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/command.js\":\"0602b85cc1d5c5e0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/context-menu.js\":\"382133f7cb875073\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dialog.js\":\"e3b7e29d419d73b9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dropdown-menu.js\":\"530c4a60bf3b0ea6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/floating-listbox.js\":\"df1e88bd9166fc7d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/index.js\":\"e621a82a3c66bdbb\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/input.js\":\"d8db117ca598b392\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/kbd.js\":\"0dffda4cdb8203f6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/label.js\":\"a289f54f0994f6ae\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/textarea.js\":\"1679211b8717921d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/useEditModeYieldKeepalive.js\":\"3bfe029622fa08e3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/BootFallback.js\":\"01db06e3c6160142\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/FocusedRowLazyMount.js\":\"4c22878f3a53447d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LazyViewportMount.js\":\"ecc0e511691dd53a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LocalDbCorruptionFallback.js\":\"934356ea1186fd7f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/error.js\":\"9bb39fddd091b2c1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/lazyMountRegistry.js\":\"ff569f6aac74c9c7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/suspense.js\":\"e7066af4ee74b6ae\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/CreateWorkspaceDialog.js\":\"224ba5ef81d6f9d5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/PendingInvitations.js\":\"bbcfcd033ad39e59\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/SyncProgress.js\":\"89af36bf00288d22\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/UnlockProgress.js\":\"2d056a8477da7437\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceKeyGate.js\":\"c45b60635cbcb2f6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSettingsDialog.js\":\"9f9f1021f892bf93\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSwitcher.js\":\"8f75e31d7234b2df\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSyncGate.js\":\"b3b9876051a5569c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlow.js\":\"882aca571c5005f0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlowHost.js\":\"71d02fd868a4b7ed\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/EncryptionSection.js\":\"e1d75c6a93585ff4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/attachmentPrompts.js\":\"72556b4895751bc8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2ab7655650ea2b74\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowDeps.js\":\"c396e7c01a531a62\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowStore.js\":\"07407e92fd306eaf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/flowUi.js\":\"10ed1c503232f734\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/useConversionRun.js\":\"b7c4d9ce3d1ea4d0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/keyUi.js\":\"aa2f82e3422ec4ff\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnKeyLoss.js\":\"b2f618d0e634d7ad\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnServerE2ee.js\":\"306e0790d1d6dcbe\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/workspaceUnlocked.js\":\"0e399e8f52331652\",\"/knowledge-medium/pr-preview/pr-1871/src/context/backgroundSubtree.js\":\"2b054d51c5caf356\",\"/knowledge-medium/pr-preview/pr-1871/src/context/block.js\":\"f0975c11521af3a5\",\"/knowledge-medium/pr-preview/pr-1871/src/context/layoutWsContext.js\":\"3378a5b849472596\",\"/knowledge-medium/pr-preview/pr-1871/src/context/propertyDisplay.js\":\"034aa7084885488f\",\"/knowledge-medium/pr-preview/pr-1871/src/context/repo.js\":\"6eff3f0a78f318d1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasClaim.js\":\"e164384c35572749\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasSeatNamespace.js\":\"5a0f65159740b276\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockData.js\":\"a44a18c2bf085b5d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockType.js\":\"9b47bcc7757ad25c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/changeScope.js\":\"d703e9bc4020693d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/codecs.js\":\"606c16d9cc329adc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/derivedData.js\":\"068c987b7ad2413a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/errors.js\":\"6b3a1cfdf4364df7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/events.js\":\"94413023a217e646\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/handle.js\":\"5d6533dff733eee5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/index.js\":\"619f71b2ca8e5926\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/mutator.js\":\"7eac1a61649884d7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/processor.js\":\"a4e1398299b15bac\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/propertySchema.js\":\"a4faa6acfbd02441\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/query.js\":\"bdc7a4b416ffb386\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/sameTxProcessor.js\":\"3966939b4761e840\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/schema.js\":\"5d6533dff733eee5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/tx.js\":\"5d6533dff733eee5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/typedBlockQuery.js\":\"e326958fdbbefdbc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/user.js\":\"e9d4a246801ac6ac\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresetCore.js\":\"c15ce93ac11053d7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresets.js\":\"dbef3a5277729162\",\"/knowledge-medium/pr-preview/pr-1871/src/data/attachmentCleanerIOVerb.js\":\"c64a419fbc0f0e1d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/block.js\":\"69f64eaf226d8cff\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockCache.js\":\"474dc790d05215ae\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockId.js\":\"715ead23669d00b9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockLiveness.js\":\"8c0015511111d271\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockMerge.js\":\"0dd9b2516c56757d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockSchema.js\":\"33800ac39ce79c98\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypeLookup.js\":\"8df3e1e99cc2ed19\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypes.js\":\"377b76dc00ac0406\",\"/knowledge-medium/pr-preview/pr-1871/src/data/childrenView.js\":\"ac1666c9335e0d4a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/clientContext.js\":\"8984a6b99fff286b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/dbFileSiblings.js\":\"d452b6aa7a9a1fd3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/definitionSeeds.js\":\"688fa33de9c369bb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/derivedIds.js\":\"028771f658732537\",\"/knowledge-medium/pr-preview/pr-1871/src/data/drawnSubtree.js\":\"b769bd3bb338547e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facetBridge.js\":\"979f6f5d83195cb7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facets.js\":\"cb9f9cf6c33acb4a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/globalState.js\":\"1cee119be769a36c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/aliasClaimRederiveProcessor.js\":\"3c33bcac43ffc1d9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/ancestorBatch.js\":\"555755a090a3725a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/blockTypeTypeifyProcessor.js\":\"f874058c5a55b35b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/clientSchema.js\":\"6738ea1a2e69b44a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/commitPipeline.js\":\"9779cf763d3e2ba9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/devAssertions.js\":\"1b8eae03941378b2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/firstSync.js\":\"6e30085f7d1a80cc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/freshInitialLoad.js\":\"d7f70b42ea6bf215\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/graphBackfillClaim.js\":\"3b4dd2e730fe5c64\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/handleStore.js\":\"21b4fe2225ec3611\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/idleMarkerJobs.js\":\"c0db8d46794a68cb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initialDownload.js\":\"cdf27e6c0675ddd1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initializeClientDatabase.js\":\"76fc1d86a61d7c83\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/jsonCanonical.js\":\"2105eaf93e866b3f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelInvalidation.js\":\"2ad46e0a8feef900\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelProcessors.js\":\"4872b2e83981739d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelQueries.js\":\"8f9b8aa8f3c03f6c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/mergeTypeMembershipProcessor.js\":\"e4d169cbbba2b6f5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/normalizeReferencesProcessor.js\":\"fb87760c68f556c7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/poolInstrumentation.js\":\"4ee5d283ccd0faf7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/processorRunner.js\":\"c985131af93ba6a1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyCellBackfill.js\":\"483428aa56969ab1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildMint.js\":\"0f72c2d208be475f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildrenProcessor.js\":\"de266999ec9a8637\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionChangeProcessor.js\":\"768a3504b3ff862b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionSynthesis.js\":\"f10a1c0d33a90457\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyKeyScan.js\":\"9fe4cdc2ea03eca3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertySchemaResolution.js\":\"d5a7df27fb3d779f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyValueEdits.js\":\"d412dc7dc9d6b093\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/raiseProtocol.js\":\"f27a9fd3b748df58\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/readBatch.js\":\"5c80ea7c9145c195\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/refProjection.js\":\"72814d25108b45ec\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetLookups.js\":\"56081125514ee164\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetProcessor.js\":\"93a24cce5ffed7bd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/replayMerge.js\":\"5258754d8c55ef23\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/sqlBinds.js\":\"fc4cb517fb049c7e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4599e84b42b08a24\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/arrivalProcessors.js\":\"c640fd91e5c1e00a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/invalidate.js\":\"e102f5969d2d5c34\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/materialize.js\":\"3437a4222856fcf0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/observer.js\":\"a194c0d70bb0c75e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/reconcile.js\":\"4534b929cebbf692\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/timingMetrics.js\":\"fae491373d69cb58\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/treeQueries.js\":\"8cc42545b0793349\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txEngine.js\":\"6e973604a525150e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txSnapshots.js\":\"25a3a096ba795a12\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/typedBlockQuery.js\":\"5e79cd49aa38260a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/undoManager.js\":\"745e224bcd38935e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/invalidation.js\":\"058fd9e564725d48\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelDataExtension.js\":\"7286b62b98bf3f5e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelPage.js\":\"abcef420c9ad32cb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelValuePresetCores.js\":\"09331e92f98549e8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbCorruptionSignal.js\":\"293370007c2333e4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbStorage.js\":\"9537b4cc703a22d2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbVfs.js\":\"6bd877a0aa0caa3d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localSchema.js\":\"e456efc22e5d742f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/maintenance.js\":\"eef375155cfd5344\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mergeProperties.js\":\"7744ed961eb32f8b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/metricsConsoleHook.js\":\"bd5ecdbb94da61b1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/migrationsPage.js\":\"85c1f026cc5cc27e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mutators.js\":\"07811baaade69fa2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKey.js\":\"5985571d67c1f467\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKeyPlacement.js\":\"b34940fa576cba10\",\"/knowledge-medium/pr-preview/pr-1871/src/data/outlineSurface.js\":\"7cabe367cda7f339\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingEditorContent.js\":\"6cac2326fb52c53e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingUploadsSql.js\":\"b436a5b9d75c0fd2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pluginStateExtensions.js\":\"b3d3938552e2dfaf\",\"/knowledge-medium/pr-preview/pr-1871/src/data/powerSyncLogger.js\":\"1245e7616fa3428a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/projectorRuntime.js\":\"651c81136cee2c72\",\"/knowledge-medium/pr-preview/pr-1871/src/data/properties.js\":\"6f09cb56e15704e4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertiesPage.js\":\"da13d4b76cdba4a5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyChildren.js\":\"b5614ed5cf06b48d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionFanout.js\":\"5126bee50e58a0e8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionMetadata.js\":\"c6ae79e23ba55447\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionRegistry.js\":\"c635956eb3855fb2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDisplayMode.js\":\"dd896d8963a9930f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyRowCreation.js\":\"61fc1900a55a8dc5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySchemaCreation.js\":\"04e4ef8a40b9194e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySeeds.js\":\"5ce39e0a06ef4337\",\"/knowledge-medium/pr-preview/pr-1871/src/data/recentsPage.js\":\"24795e57553950ab\",\"/knowledge-medium/pr-preview/pr-1871/src/data/referenceBlock.js\":\"51c258b1c6360fa4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rejectedUploads.js\":\"bfd2a78de7ed204e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/releasePowerSyncConnection.js\":\"e3ec928b18a58981\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repo.js\":\"5863f4dae82d10d0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repoProvider.js\":\"5aaf72b9f8bdf238\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rowProperty.js\":\"e9dd6bef13bb22c0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/searchFilter.js\":\"ff3f3f8e0fa2b4ae\",\"/knowledge-medium/pr-preview/pr-1871/src/data/seedIdentityLedger.js\":\"0a1dd94e81142a09\",\"/knowledge-medium/pr-preview/pr-1871/src/data/stateBlocks.js\":\"c3337d49ad71d496\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralEditPolicy.js\":\"9db18557516681b6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralInsert.js\":\"c6002460c2d1e859\",\"/knowledge-medium/pr-preview/pr-1871/src/data/subtreeDelete.js\":\"93edd10e1e5cbc6f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncStreamLock.js\":\"b8000bf4096f8b74\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableSqlRecognizer.js\":\"8c7acb0db5b50020\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableWriteGuard.js\":\"eec43f9a6e43b9dd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/targets.js\":\"cbc2f603a0e1f203\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeColors.js\":\"ac7d00453924155b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionMetadata.js\":\"2ba323ee289506c3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionRegistry.js\":\"38f8aa0c8495db69\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeExtraction.js\":\"0e4c3e10dea26382\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeInitialValues.js\":\"198837373979144a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typePropertyGroups.js\":\"c66fae5512f12189\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeSeeds.js\":\"58df97aa8249c28b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeTagger.js\":\"74315afcb2e590fc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typedRecords.js\":\"35223c959fa0340b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typesPage.js\":\"691234c7e1104492\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userPrefs.js\":\"2ce11884b2645db6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userSchemasService.js\":\"9b67e6f2dff7bb2d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userTypesService.js\":\"460375f54693e43c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/valuePresetRegistry.js\":\"2106dc2dc93d0c84\",\"/knowledge-medium/pr-preview/pr-1871/src/data/visibleChildren.js\":\"d82da87004dd6361\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceConversion.js\":\"14f3b4fd27126854\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceFirstSync.js\":\"999e192cfd167bd3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceIdNamespace.js\":\"a818b3c3b7d58b46\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceSchema.js\":\"e7df248b56497573\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaces.js\":\"2e3d26019957b32c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadLog.js\":\"348ebf496654d371\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/BlockPasteShellDecorator.js\":\"a941321e42502b8c\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/atTrigger.js\":\"9622825a2527092d\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/autocomplete.js\":\"33ce2256d359d0ae\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/codeMirrorExtensions.js\":\"6b015b96cfff791f\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/contentFlush.js\":\"7f9fccea14770971\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/defaultInteractions.js\":\"6089ca29af01dc72\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/editSettleSignal.js\":\"8ba8f0717ee60806\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/insertImage.js\":\"145638e92f455751\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceCompletionRange.js\":\"6495d85a470ca44c\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceTargetTypes.js\":\"66cdc894b90ac8a0\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/syntaxContext.js\":\"b0d4991704dd002d\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/triggerMatch.js\":\"11de8c804044f3c4\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/AppRuntimeProvider.js\":\"c2136fad2494a5ce\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/BlockFocusShellDecorator.js\":\"9efd0ac3c169371e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/ExtensionRenderBoundary.js\":\"6cd46d5017bd26f4\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/PanelContentRecovery.js\":\"d8e0face2885b080\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/apiCatalog.js\":\"58780e8872452e5e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/approveExtensionHere.js\":\"e7fb1925d2b10637\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/armedCutAppMount.js\":\"d890e7b3d9f1dc5f\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/batchableKeyedStore.js\":\"3296e34ff50a2613\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockInteraction.js\":\"225dfdba057b9474\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockSelectionAction.js\":\"e034f8507f16e6c8\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compileExtensionModule.js\":\"535103891ac5bf99\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compiledModuleCache.js\":\"757d9a80035a91d6\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/continuousGestures.js\":\"d389dd29ba9fa5b5\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/core.js\":\"ecc98ef523217f5e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/defaultRenderers.js\":\"b44567277ec6e9a6\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/definitionFanoutAppMount.js\":\"78f21bce5d373894\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dialogAppMount.js\":\"52bedadf44f36a7c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensionSeeds.js\":\"3531eea09c0da7b6\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensions.js\":\"c9bcaa3542725124\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/exampleExtensions.js\":\"c0c7d73efedadb24\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionApprovalStatus.js\":\"d98838c7c7e3e8b5\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrorToast.js\":\"3198b9a602d28508\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrors.js\":\"02389ba4303e8298\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLookup.js\":\"bc877b0aa8643caf\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionToggles.js\":\"08031486a036c6e3\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionUtilitiesCss.js\":\"31983737c07dd6fc\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/kernelPageDeletionGuard.js\":\"5022c4cd6f7e5f5d\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/liveRuntime.js\":\"f3322176c88b7bf1\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/openExtensionsSettings.js\":\"3dbcfa751c4dfd4e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/overridesCache.js\":\"bd4fc233ddc36052\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/pluginIds.js\":\"e14b9adf703e26f3\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/processorRejectionToast.js\":\"2d0e84d6c1180661\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeActions.js\":\"6cc09701760a7d11\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeContext.js\":\"7fb5e9410c2ecddf\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticAppExtensions.js\":\"3c281689937735c3\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticDataExtensions.js\":\"952f3c1c876ebd4b\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/toastAppMount.js\":\"8b1e87b3f53279d9\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useOverrides.js\":\"4d0146016681711d\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useShortcutSurfaceActivations.js\":\"8e50758af6f0472d\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/discoverToggleTree.js\":\"935da141c57f1710\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/facet.js\":\"4534b86082058d25\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/resolveAppRuntime.js\":\"d625618dfcc79860\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/runtimeEvents.js\":\"7981ba740f8645b7\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/togglable.js\":\"9a974e3a98803c63\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/variantFacet.js\":\"361a0068b281aebf\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/verbFacet.js\":\"d914a4e4f1c88061\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/block.js\":\"b0ef3fedea38c99c\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/focusedChild.js\":\"69c06d8d5812c8a6\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/propertySchemas.js\":\"ec3aa0426d5607bb\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/typeRegistry.js\":\"525f0a5c9c0e367d\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAncestorCrumbs.js\":\"3bad2eabccabef73\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAutocompleteListbox.js\":\"9c2434810cf0da92\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedSearch.js\":\"fdcd2a40f78271a0\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedValue.js\":\"4b9d86799ffe6721\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsFocalRender.js\":\"ae3b787347d1ffe2\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsReadOnly.js\":\"5e0161ae3e467a20\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMaterializeBacklog.js\":\"14f600ff6132fc3f\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMinuteClock.js\":\"813d518c9fc5b73f\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePanelLayoutProjection.js\":\"cdad526a4ebee207\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePendingInvitations.js\":\"a44f37b6a670bb5a\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRendererRegistry.js\":\"51b73c36331a0d83\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRetainedFieldRows.js\":\"4c3ac2677bdcde9f\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useWorkspaces.js\":\"9c200880b5eb9f7a\",\"/knowledge-medium/pr-preview/pr-1871/src/lib/utils.js\":\"26062995a5ebe8e5\",\"/knowledge-medium/pr-preview/pr-1871/src/main.js\":\"4578f5508aa99f4c\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/MarkdownImage.js\":\"e7050859273280d1\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/blockSeparators.js\":\"d9d45cee0be25362\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/context.js\":\"f4b7559c94769cd6\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/defaultMarkdownExtension.js\":\"fe5ed880590c2434\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/extensions.js\":\"d55b0947048255e5\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/renderMarkdownHtml.js\":\"8679c0d900d32ee8\",\"/knowledge-medium/pr-preview/pr-1871/src/minimal-editor.js\":\"a0563f2b0787a873\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/armedCut.js\":\"8b44287a82ad2746\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/captureMediaVerb.js\":\"48ca2bc2351d5917\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/clipboard.js\":\"ffdf592ec9092205\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/decision.js\":\"f22df1ce7cbad3a7\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/operations.js\":\"08c1b213d8b5fdd0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/AccountHeaderItem.js\":\"f7dff97d673f927d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/index.js\":\"8b725e250dd9d537\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"831f03599817c5b4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askAgent.js\":\"5d6d5f0a01795693\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askedStore.js\":\"6434e534ecf3a7b7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7caa5b1e3877a752\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/chipState.js\":\"f7af918f43351450\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0d659041668e77da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/index.js\":\"3b0609fbb60e6a63\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c8a2734c0edf004b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/schema.js\":\"f68ec5d3c99d5687\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8a677c570d386b06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b2b7efd524a2bfc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/addMedia.js\":\"e9bf01d65a084c0f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f8a094889b094844\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/block.js\":\"337523997ca484ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/context.js\":\"0976b53073dd3692\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/displayIds.js\":\"eca207e613156c0e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/index.js\":\"9414b59bc8aefbcb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/outline.js\":\"fbe087bf184cb215\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/properties.js\":\"6a7b3ec21a71fc24\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/refs.js\":\"4dcd5f0aea99ac7d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"123ce9116d92cdff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/search.js\":\"c0f184a9e488894a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/shared.js\":\"08d1774bc2d152cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b7488d8b559d34f3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/text.js\":\"8db8665c8f60fe57\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentWrites.js\":\"cb1419233d499edc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/authoringCatalog.js\":\"1e7d0d24cfccd2f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/blockRefTargets.js\":\"8736941bbc61d874\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridge.js\":\"958bf08261968a4b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridgeLoop.js\":\"045edde6fedd3ff0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/changeHistory.js\":\"eb0955c7803036b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commands.js\":\"976b14a47dfe51d8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commentsCommands.js\":\"046d86102e639909\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataExtension.js\":\"065ff11822c256a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataModelGuide.js\":\"7bbd767cbdf9282d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/describeRuntime.js\":\"cbbccdfb9a021b0b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/extensionLint.js\":\"85c99c77a76a012a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/grainAudit.js\":\"7e246c92943961f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/healthCommand.js\":\"93caef39a9fd295b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/index.js\":\"dec1b866666cc195\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/presetIdentity.js\":\"9a0e403dcaec25ab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d2541d5f5493f233\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/readMedia.js\":\"dbc41021b1dcd7af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/schema.js\":\"38193bd08d0cd6cc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/serialization.js\":\"0d9a2cc5a5587c38\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/targets.js\":\"eb21210b851dd3a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/tokens.js\":\"93b2d6af0a8fffaa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/watchEvents.js\":\"5d6be730140ca424\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/workspaceGuard.js\":\"d68106f3474656bf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/writeCommands.js\":\"bebad2f2b3e3a1dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/AliasCollisionToast.js\":\"d9bbe46cb7926742\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/DuplicateNameBanner.js\":\"064c23361cb8fcdf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/collisionMerge.js\":\"5d1de6da5eeabf3d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/dataExtension.js\":\"b2c4e9364b51f61e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/index.js\":\"8de9d22b9b58efde\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/mergeCollisionAction.js\":\"25e38f3b18e0c3e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/pageStyling.js\":\"aab7c8f6bdef9768\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/rejectionToast.js\":\"1c13a68b6a8ac927\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/syncProcessor.js\":\"41f49444b2e00043\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/actions.js\":\"cdc881ddafd05f83\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/addComment.js\":\"8e42d48265e48dbb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchor.js\":\"8779e9f7d0cbcbec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchorState.js\":\"438c1837fa89333f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/commentLinks.js\":\"cd0c8873ea653cd9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/confirmThreadDeletion.js\":\"858974a252b430e0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/container.js\":\"6a07d8c95d7402f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/dataExtension.js\":\"a2c5a84696ff9b40\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/deleteComment.js\":\"a8af672c01974f68\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/highlights.js\":\"cda3a22ac135b64d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/index.js\":\"98ba3d8dcb53b2a9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/linkedCommentsPill.js\":\"aed09e8cde0bff78\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/margin.js\":\"9edf834849f75177\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/marginSchema.js\":\"b8c0a23f547b17cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/newComment.js\":\"e4d2a2f3af9a1c91\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ownThreadPicker.js\":\"96a276236078eca7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/placement.js\":\"fb01dacdefec60c9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/queries.js\":\"4e24d6915da4c8c9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotePosition.js\":\"d1a322f6dc978ace\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedIn.js\":\"5ac37ba7476e4535\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedRange.js\":\"49e411202ddc79e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/rangeRefs.js\":\"74a33aba88a923f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readHighlights.js\":\"10d8bb24e5329232\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelection.js\":\"4c13d7ec5c4d0026\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelectionUi.js\":\"f8d465ba83addfbb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/reanchor.js\":\"e0a8ead0d6d50080\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/schema.js\":\"a86c18c07bc8206c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scope.js\":\"c73c6d220c136637\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scopeThreads.js\":\"99143fc49b00bb3e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/splitRetarget.js\":\"f309407e3a772825\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestionCard.js\":\"43a66d453994dee9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestions.js\":\"8efb4d96c197b67c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaries.js\":\"fdaaab285c112f28\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaryBatch.js\":\"6a9f142af2b5b0c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/surface.js\":\"083588d995bf2547\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threadNavigation.js\":\"296dfa4497f8d082\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threads.js\":\"3c799e61ab05d6b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ui.js\":\"b0d6edb3d2397ecb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/uiStore.js\":\"4f5bde38b0e9822e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/appIntents.js\":\"c5a9dadf876c5365\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/index.js\":\"4a045074e04552ff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/index.js\":\"e8ca0468f049253c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/status.js\":\"19ce9feba2c4366d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3054604a62e8c473\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaBlockRenderer.js\":\"59ebad025a7ca47a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ca0037eb634473ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaUploadReconciler.js\":\"6b6826cdc21379cf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetDownLane.js\":\"a7bc668b7ac0bc29\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetResolver.js\":\"593ee2799ea3f716\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetUpload.js\":\"df24bd002403c083\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/attachmentCleanerIO.js\":\"fb98d200a0eb570d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/supabaseAuditIO.js\":\"254aba789a710e6c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/blobStore.js\":\"d06d68256178de62\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/browserMedia.js\":\"820a682301f56179\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/byteStore.js\":\"59e7c0a3df984995\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanerIO.js\":\"2564e898f7374ec2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanupAttachments.js\":\"ceea6612c76f97a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/dataExtension.js\":\"0c864338aa2c7d75\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/downLane.js\":\"5ee5cc05bae98004\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/index.js\":\"0fdce80e70121381\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/insertImageContribution.js\":\"38ec78849718aa22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneArming.js\":\"cb94674d0007903f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneLock.js\":\"54f2ba54278a0bb4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaBlock.js\":\"ecb1bd798aac962b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaCapture.js\":\"4bda01f4af1c2181\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaLanes.js\":\"b7f9d58871d891d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewers.js\":\"9cfb5df1627daad5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewersFacet.js\":\"cf1554eb483c38d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/pasteCapture.js\":\"a24bb7540cd1645f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/resolver.js\":\"2cde98f9a08d2da0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/retryUploadsAction.js\":\"c4495ede161f61d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/storagePaths.js\":\"5f5c790cb3cb7a3a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadDrain.js\":\"5adbc9a54bc395ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadLaneStatus.js\":\"95f784803df45829\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadReconcile.js\":\"ff851b5232637cce\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadRecovery.js\":\"786112b8abf2d26d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadStore.js\":\"9e2f462218167a22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/useAssetObjectUrl.js\":\"fa32aeef1a552bf4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9ea62ca5f9830392\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksViewSection.js\":\"116500e1efe5ba8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/facet.js\":\"9ebae7e909999199\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/index.js\":\"9973e6a0854d3c13\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/prop.js\":\"181f773101eda7c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinkFilters.js\":\"8753393cef82163f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2fae03392ce7cf23\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BlockEntry.js\":\"72b429121855c7e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/LinkedReferences.js\":\"3635e9443574a6eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c834d37a0acbc317\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dailyNoteDefaults.js\":\"ef7e918c45b64dbf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dataExtension.js\":\"e6d19831c8569bbb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/edgeExclusions.js\":\"ffa5dbfda73312eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/filterProperty.js\":\"968b3c912313f8f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/index.js\":\"4d47d11eafbcbb6a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a53801b8c3e3b325\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/applies.js\":\"cd0ea388a2b56dd0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/countQuery.js\":\"62252ffde2adf78e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d67adf0e6814fb15\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/index.js\":\"a26847036fdb74b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8c500f34eea7b7aa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/presentationInvalidation.js\":\"a1a3336ca9161a1f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyEditorOverride.js\":\"dc607169bbeb02a7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyFilter.js\":\"0ad6118bcc681a20\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/query.js\":\"7fbcb7a8a374c14c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/resolveFilter.js\":\"7bc2ef843e6f4e0c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sourceBatch.js\":\"830ed84bb4ff3ba6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sources.js\":\"a945a716e0ecb983\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useBacklinks.js\":\"97b525f93216ce58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"cd683d6bbb43ea7f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayCelebration.js\":\"b3c6cc2752b7a214\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayOverlay.js\":\"03bdc31c7443ad77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/gate.js\":\"88909fb06bb1f8c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/index.js\":\"2d5e2f8bcac1d92b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/wolfTheme.js\":\"2e9c979990552b3f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/BlockDragLayer.js\":\"d811cb17aa10b95a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dragController.js\":\"a6c72054448a3ef0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dropTarget.js\":\"2dd3f5b061ff58be\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/index.js\":\"b83e072bdca74f04\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/projection.js\":\"55332c68b2aecbaf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/BlockMetaCard.js\":\"3805c7eec478f75b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/index.js\":\"48d22b47c710f7a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/AddTagDialog.js\":\"f3ac25ecca15573c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d9bf51c08c967db0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/TagNameIssueHint.js\":\"f0798a593317cf31\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/addTagAction.js\":\"f7d9e680abe4226c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/appendTag.js\":\"2e29e1b844cf6479\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/config.js\":\"796115e8940de54f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/dataExtension.js\":\"5d1cc8cc8edfda7c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/index.js\":\"057bf6fbfdcc1a1f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/propertyEditorOverride.js\":\"3725fb77eb90bde7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbList.js\":\"43873a20dbef0f3c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"941305ce6e3842b2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/Breadcrumbs.js\":\"dc32c402dfe94b72\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"46a3bfab92467efb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"444c73396546cd8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/index.js\":\"224cbfc1f17e6d92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"91fb67e776fccd0a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/CharacterCountItem.js\":\"1b17055f6325a48f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f6ad2fee6bd5cf4f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/actions.js\":\"d896adaece640968\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/blockType.js\":\"13e6c6c3c198a919\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/charCount.js\":\"2fff86860bcce5b2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/dataExtension.js\":\"6a0a5fc88e225538\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/index.js\":\"e04aa17fe274e040\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/profiles.js\":\"c69a38e5f484abd8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/properties.js\":\"ba768efef7743041\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/textCounts.js\":\"3be3ca6da95a0ce0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/colemak-keybindings/index.js\":\"6cf41e142a13c147\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/CommandPalette.js\":\"305dfaabc1d887cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/HeaderItem.js\":\"ffdde06139c02f56\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/context.js\":\"4ff09778a1227ad5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/index.js\":\"3e158e5b9cc59f7c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/selection.js\":\"92bef1c12109627b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/toggleStore.js\":\"299d4c1ec53baded\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/useCommandPaletteActions.js\":\"7bb0e817a3088df8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/ContributorBadges.js\":\"007b40d811f81a01\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/author.js\":\"3b4ca92592b358af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/codeMirrorExtensions.js\":\"b81b5498383238dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/dataExtension.js\":\"e0fc2bdd570a3b04\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/index.js\":\"c5f95757a8c41d96\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/mentionAutocomplete.js\":\"649f757a6caa0314\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/processor.js\":\"3a7469758b59ceec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/profiles.js\":\"d6fb47bb9b31f788\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/queries.js\":\"05263c50bcd2815e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/schema.js\":\"db1ad451f707cc1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"0c965622671f55d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/followOrigin.js\":\"79ef33adc80c764a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/index.js\":\"905d0f3c9e23fb5f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"bade05d7e62a338b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d5a605bb1ac7dd43\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/CalendarGrid.js\":\"7ef3211a34f9fb79\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DailyNotePicker.js\":\"73d6f3a4d9ea3f07\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"91896c32cf2a1332\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateNavDecorator.js\":\"f888ae5ead8e8863\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateScrubOverlay.js\":\"bf8378105733b9fd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/HeaderItem.js\":\"1beefbfaa32a176a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/ReschedulePicker.js\":\"7353d9f71f2ed7e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/SpreadDatesDialog.js\":\"90cafcf925825b25\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/actions.js\":\"dbdd90fca6c54eb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/blockDateAdapter.js\":\"51a62fd18afc3679\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/calendar.js\":\"dbcea6ad157f6279\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dailyNotes.js\":\"e32fd763bd84b84a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dataExtension.js\":\"5b429020f0e5fb79\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubActions.js\":\"ada6a0af36f32135\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGesture.js\":\"237daf1133aca15b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ec5af3d158df9a35\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubRecognizer.js\":\"78ae354a86d470d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/deletionGuard.js\":\"48a1cbc0dc3e0183\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dueQuery.js\":\"cc7bef79fa2091c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/index.js\":\"9864deac10e7d635\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/landing.js\":\"8993e6d45f054a29\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/localSchema.js\":\"4756f69e5106c50d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/referenceDateAdapter.js\":\"4ec41694389bcc91\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/rescheduleAction.js\":\"09d49634a9b74818\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/schema.js\":\"c1dc2693e61251da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadBlockDates.js\":\"f02accd2132c2fe6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadDatesAction.js\":\"15da333deba1a7e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/today.js\":\"3ea4ac4a8a7a5166\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"fcf86ea03d64cb81\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"2c2ede38ea767c78\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/audit.js\":\"bb9426a697457a61\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditAction.js\":\"450294c6859f9d8e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditRanges.js\":\"590dcdd90a44d95a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/diagnosticsSource.js\":\"c7322040a5b6e55a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/divergenceScan.js\":\"11970b5ba12b32b6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/index.js\":\"364d570a4201c066\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/propertyChildrenChecks.js\":\"25d228c630096440\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/referencesMirror.js\":\"087aba024a888be6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/rowJson.js\":\"326c44f90ccfc46e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/schedule.js\":\"2ed8a80de0ea32e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/store.js\":\"2141bbeb00d324a1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/action.js\":\"31428382badfd0c4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/index.js\":\"efb9694a616668b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/plugin.js\":\"3d71af75042396a8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b1e0b71bd691ddd9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/actions.js\":\"c4d3b0f1be9aa02d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/changeMarker.js\":\"bdc7372838d13c46\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/diagnostics.js\":\"f240e57a344f99c1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/fileSystemAccess.js\":\"37df2ac82d85fc69\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/filenames.js\":\"fb68b807a534ca7d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/index.js\":\"aa4edb20809c7cb9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/mirror.js\":\"24b520a46c0b6fdd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runLock.js\":\"2f12496f1b460795\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runtimeHealth.js\":\"950933ce97a48b1a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/schedule.js\":\"5eb97ea85215e828\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/store.js\":\"204e6be13e6bbe5b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/index.js\":\"0301207732d4ff29\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/themes.js\":\"a3ab1a56a8381929\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/facet.js\":\"8abf337dc901cf34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/useDiagnostics.js\":\"4c4370a74fa3e37d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/dismissals.js\":\"85d32204b3352e4a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/index.js\":\"860c75d8d19247f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/status.js\":\"d9f7d2cdd1c4d007\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/store.js\":\"4ebdea6e0e2ef35d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"27b4151f38015c50\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6109a7c1d57cc4d8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/actions.js\":\"b9227d92846d4eab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/config.js\":\"23bde327f6129948\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/dataExtension.js\":\"25484fdb2ca9d2c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/effect.js\":\"87d1a8ae6120a89a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/index.js\":\"5b410d01ea853c2c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1ca0350358c662f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/useToggleTree.js\":\"93c09437475fcbc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/ExtractTypeDialog.js\":\"7f5038a3ffed6a49\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b401a4b1e6455c00\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/PropertyShapePicker.js\":\"a4ba67c6314e6580\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/action.js\":\"ec38320205ccf1f8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/index.js\":\"ea4edd640d1bc871\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/FindReplaceDialog.js\":\"635456d537b043ac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/HeaderItem.js\":\"809ac5deb300b470\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/dataExtension.js\":\"54aecff329eb128c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/index.js\":\"bb66a9d425f60d80\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/search.js\":\"eb803fc0077c1703\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/toggleStore.js\":\"337f0245ccd9b459\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/LocationPropertyEditor.js\":\"8f8195274f850bae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/MapView.js\":\"2311e5d422e3d31b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/blockTypes.js\":\"71ce78de11188cc6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/codeMirrorExtensions.js\":\"86e69b913a51a596\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/createOrFindPlace.js\":\"8827ff801781792f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/currentLocation.js\":\"25efa21056f4affc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/dataExtension.js\":\"2f71af24c0b5cdcd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/geoContentDecorator.js\":\"1611a91e2a236f68\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/googlePlacesClient.js\":\"d39c031f70e6c8a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/index.js\":\"00f53b4ec6f1a5e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/locationsPage.js\":\"b7946ed886a09511\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/mapViewport.js\":\"65144459c87cc4cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/pickCurrentLocation.js\":\"4932b12ca1ad5914\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeAutocomplete.js\":\"b68caac8de7c4bc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeNameCollision.js\":\"a9699a2feeed01ee\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/properties.js\":\"259d2ccb2341b352\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/propertyEditorOverrides.js\":\"e959d6a0bd5a2771\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/query.js\":\"08c0e834d0439856\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/usePlaceSearch.js\":\"3170c4a0aea825b8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a974c0d384a1cc6b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2da8847579eb86c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d21dacaf001e28b2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/config.js\":\"931da96b8da25dee\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/dataExtension.js\":\"3c346aa1cf4879e6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/facet.js\":\"bbc2fdcd675bf1e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/grouping.js\":\"fa74643faab08e53\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/index.js\":\"17ee32014d26d028\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e8b47e3ffff5a5fa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/query.js\":\"365977f849f31664\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/resolveConfig.js\":\"e2cf57bdd4398814\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2eec61a7adc15146\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"85ae90b860618a1f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlDocumentContent.js\":\"5076ea35799f21f1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlFrame.js\":\"66480b668cc2c897\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/actions.js\":\"8eebea6c0adef11d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/blockType.js\":\"83c58c4704642d2f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/confirmRunScripts.js\":\"d1f39a9016adc057\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/dataExtension.js\":\"25698af19efef225\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameAnnotations.js\":\"7a83e722ab5049f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameDocument.js\":\"dafcdbc23df4907c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameTheme.js\":\"e44d7e9a65cbeecf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/index.js\":\"324df852bfb89949\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/scriptConsent.js\":\"74fffbdcc913aee8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/sourceMap.js\":\"df282c2536e1cde7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/useDocumentScripts.js\":\"130e3fe53887e572\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/index.js\":\"da012ed3f080c1a5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/record.js\":\"1e6d67ef37fcf542\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/recordStore.js\":\"f4a348e463cdd72c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/responsiveness.js\":\"36bfea3b7b5242e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/schedule.js\":\"031f8b0f32622518\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/sessionContext.js\":\"cf0a3faa18875882\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ca277c14bf55b2d2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6e66d339e1d47d2c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/actions.js\":\"79f1501c2bf9b683\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/config.js\":\"f88af6881c1dc1f8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/dataExtension.js\":\"47aa17443c957da4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/effect.js\":\"1038c226a504b2b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/index.js\":\"70828daa3f5684ec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/keyCapture.js\":\"00e7f94881a7995a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/overrideStore.js\":\"e11ac1e15156afb0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"eaf1fc147551859f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/HeaderItem.js\":\"d0baf45dff521b61\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/LeftSidebar.js\":\"01a0a8b64869d731\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/actions.js\":\"b281659fc95e9cc9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/facet.js\":\"4fe6efd4dcb78880\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/index.js\":\"02b14a2086d9a68a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/shortcuts.js\":\"b9ae8bc6d2ef50e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/toggleStore.js\":\"ff6a22ba705f786e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/MergePicker.js\":\"c297cd7c27dff6da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/index.js\":\"bd5b57cc738e7736\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/mergeAction.js\":\"b79eff06eeb1a6a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/strategy.js\":\"8411762d2b45cfa4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/Button.js\":\"24db0507ab5f3d47\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"77abd6f05b008d1f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b09bc96e0372bfee\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/facet.js\":\"f47cbdced6c1fbb2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/index.js\":\"601e9345a3e23c0a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"83488ebae4446216\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c03313e6603c0d3d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d866c61cfa757a77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3c77c16a2707f08e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/index.js\":\"9a78432f2400359d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0c0245864e7a708a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/blockSubtreeMembership.js\":\"db4ca0de6366a537\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/contextMenuItem.js\":\"1f3c03681866ab11\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/index.js\":\"04250506311a572a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveAction.js\":\"136a9501fe0b5f55\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveBlocks.js\":\"c1c82b825df54e9e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/selectionAfterMove.js\":\"be49f6ce1e7f609e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/TutorialBanner.js\":\"258bf8c40492a192\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/action.js\":\"6178ad211d7d7586\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/bannerDismissal.js\":\"8134e71d0d10b237\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/documents/cheatSheet.js\":\"809547db1bc0a09a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/index.js\":\"7c23fa37a6f170bc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/keys.js\":\"154cb5e2f3adcbd6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/landing.js\":\"5ef82438c56e200e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/outline.js\":\"0f9fc19599a1cbfb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/seed.js\":\"d0ed29a8ebd84306\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/PerfTrendDialog.js\":\"56d1f9e179083ef1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/analyze.js\":\"9c377c7d87aef3e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/diagnosticsSource.js\":\"ad4ca192c916ffbf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/index.js\":\"6d2205331bfab4fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/load.js\":\"d45813e6896a63df\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/monitorRun.js\":\"c3c5bb6faa1d32a8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/schedule.js\":\"423cb59f1142f474\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/series.js\":\"df74d23368699cb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/store.js\":\"38395e67807119c1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/trendAction.js\":\"cceab108494d8c1a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/verdict.js\":\"ac1a5365d8bd9d1d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/clickToEditAction.js\":\"d2834a855c082fe2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/index.js\":\"49d90ff6b69d5e0d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/interactions.js\":\"975e744cad9ef1ff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5852c00ed9d79ee6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGate.js\":\"4cfc4bfa519bf245\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGateDialog.js\":\"f05cf895df2f1b65\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/action.js\":\"6072e48afeeb6da1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/index.js\":\"8f5e2d74ccdaedeb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/localRunMessage.js\":\"61a3e4eb5ae6e85f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/plugin.js\":\"485e9ccef4e480af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/progressReport.js\":\"d71d9e93eeefdea1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/sweepProgress.js\":\"0f352fd989c5a9b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/FieldRowRenderer.js\":\"1f963d04c89f2d62\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/ValueRowRenderer.js\":\"4e2e569a63b661a1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/actions.js\":\"2cd3fef92ceb6e15\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/autocomplete.js\":\"8e099ecc1ba918d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/fieldRow.js\":\"87f4a6c4cd4f696c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/index.js\":\"5949aaeb58899b94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/referenceWarning.js\":\"ad82793cb7c128ab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueAutocomplete.js\":\"7719ab5d4369d487\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueSchema.js\":\"045394f6de40ead5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/HeaderItem.js\":\"94e70f3b18612bf5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/QuickFind.js\":\"78d9884d1a30568e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/index.js\":\"9068f6edad065004\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/recents.js\":\"4213bfe34c766576\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/resultItems.js\":\"8bb997226bec9494\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/selection.js\":\"1e455f3b03f424b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/toggleStore.js\":\"ff55a5131e0f1416\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/HeaderItem.js\":\"cb05c5e8c4c6a2bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/RecentsPageBlockRenderer.js\":\"fa1f643f3787125d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/grouping.js\":\"707abf38e81b19c1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/index.js\":\"b4b22637a30c5af5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/target.js\":\"d3699ad9e8495bba\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/codeMirrorExtensions.js\":\"87c2da06027c57e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/contentPrefill.js\":\"8f35c27dd200e150\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/dataExtension.js\":\"3c99ff9606b21f0a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/index.js\":\"8d550a55f9f4d710\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"1b5d49e8825b4bf5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/invalidation.js\":\"1ab1c1e15a7b4f98\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/localSchema.js\":\"dd6e310c81febec6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/index.js\":\"e1c36e163b2f8c02\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bdb7156f263daf28\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/index.js\":\"7c7121210300a6b4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/referenceNode.js\":\"4abdf9513f01581f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2634369620f17147\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f194c0878b675176\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/index.js\":\"c28990921f78db1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0d55015812797ce5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6e8f818487a29a31\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/mergeRetargetProcessor.js\":\"5a70b36557b6666d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/parseFence.js\":\"9d7ce6105d4b0af3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceParser.js\":\"f54f432b58efc677\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceProjection.js\":\"dfe6d10338121589\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referencesProcessor.js\":\"61c0870080a7f630\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/renameProcessor.js\":\"b9e42537bdc06986\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/spanReplacement.js\":\"e32a8b37bf626181\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/htmlToOutline.js\":\"a9269f1a80f2984a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/index.js\":\"9243e5bd478b4a10\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/normalizeClipboardDom.js\":\"954d7e4055fc975b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/pasteDecision.js\":\"d6f82d46fef783b0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/action.js\":\"028ed3fc5b2277dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/blockIds.js\":\"486508c89ad2ae76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/content.js\":\"4844276a6ea0de40\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/effect.js\":\"365f88e3446a376a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/ids.js\":\"dee928ac8269f66a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/import.js\":\"a082055275f318af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/index.js\":\"391f7c6e87b4281f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plan.js\":\"d66e25ad111d0d92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plugin.js\":\"3ec7e31e33027ef1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/promotion.js\":\"8cda0ac0084f40b7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/properties.js\":\"e206829b43d0845c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/references.js\":\"832802c362cd05c8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/report.js\":\"bddca732a13d438c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/roamMemo.js\":\"c5792da7365dea90\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/runtime.js\":\"8ddef5168ceb6fa1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/schemaReconciliation.js\":\"61e07eb93912ca21\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/srsMarkers.js\":\"d6f064afa193a465\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/todo.js\":\"b92f1345630d9902\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/typeCandidates.js\":\"979f70e97b2be531\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/types.js\":\"1c066f541dee9433\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/index.js\":\"14b2812cc83f875a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/store.js\":\"f7937d98bae5bad4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/HeaderItem.js\":\"1460b382fd8e442f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"20d8b0a7dad5dc3c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/index.js\":\"0c011665d9983692\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/model.js\":\"50c68660fa1ebd91\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/toggleStore.js\":\"15f7378f76e0906e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/useKeyInspector.js\":\"256abb19d8f2f7d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8067001bb2f7544f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/ShellDecorator.js\":\"d81fcb26b5eb99d9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/actions.js\":\"3cde911396d88d74\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/exclusionsFacet.js\":\"44d9f47b0713eef6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/index.js\":\"9477ce548d4d70f8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/shell.js\":\"6099a0564aad870f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/surface.js\":\"ff1a381186abe91c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/walker.js\":\"923cab4a943109d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/RescheduleToast.js\":\"68e73cf545744b2c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/dataExtension.js\":\"00f1dabeae99cbff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/index.js\":\"d5157adbb64af494\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/indicator.js\":\"b897d891832412ec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/moveSrsState.js\":\"d4d74211756e5e13\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7f99a8adfad97e58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/scheduler.js\":\"9eeaebe4e5bb0558\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/schema.js\":\"4a45b5304c37c29a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3dcb58d046f9b5a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsClipboard.js\":\"24c8eaa45a28b76e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1ff632a3518cab31\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DailyNoteReviewHint.js\":\"37075c340ba0c1f5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DeckPicker.js\":\"8883be090b4b8e55\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewControls.js\":\"9a70051eaa048a75\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bbfcac887546bf1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewSession.js\":\"bd58be01fa91d824\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/actions.js\":\"ac4d29f62ca4715b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/archive.js\":\"c82d85bb156e1498\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dataExtension.js\":\"d79a47773cb40c8b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/deck.js\":\"32465fdaafc45038\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dueQuery.js\":\"0c93e09479f2bbc9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/gradeDecision.js\":\"7e1d15387356e799\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/index.js\":\"bd7f8e52c2d0d785\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/keyHints.js\":\"a9ba8b8c4279f81a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewCardLayout.js\":\"849f33f8fb2fbe92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewProgress.js\":\"f83a67767f49b66a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/schema.js\":\"fa1966256d6cb98c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/useDueCards.js\":\"617a04184f59b1bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/index.js\":\"7f663df24f5f0127\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/record.js\":\"3d5a1f8dab143e02\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/index.js\":\"ac29d4212d9986f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/persistenceStatus.js\":\"0d28b65bc37c7082\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/requestAction.js\":\"9789cc62ab4a940d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/TypeChipsDecorator.js\":\"a62a276ba4bdde40\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/codeMirrorExtensions.js\":\"d9f4b1f47aaec0ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/index.js\":\"2873f06fcfa94103\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/typeAutocomplete.js\":\"88ccce1b172467af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7a1f5f4976a64be7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/actions.js\":\"4bd18335079215af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/anchor.js\":\"bb3caf8c75682f83\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/events.js\":\"2d51fedbbefeee3b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/gestureActions.js\":\"d376c05f73af9c45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/index.js\":\"db7603cc4e1a76d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"760e5eb21114c4bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/collect.js\":\"d07e49c4919cf834\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/index.js\":\"b554adc270ad7a9b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/record.js\":\"804bd794f59a39d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/RejectionDialog.js\":\"d3437a483c1da55a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/SystemStatusHeaderItem.js\":\"53895b505fa33521\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/index.js\":\"a92e70c73733e7f8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/model.js\":\"c8098a67da87ffa3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/queueCounts.js\":\"efdebf423624414c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rejectedHelpers.js\":\"6eb0bbe5827bea0e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rematerializeAction.js\":\"fc8fb86ee7aeb216\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/useHysteresis.js\":\"d9c13907c66a7c10\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/ColumnHeaders.js\":\"443086d0b9ec69c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/QueryUi.js\":\"2b799bf241adf5dd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/TableLayout.js\":\"63926254c9c08f0c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/actions.js\":\"e3e66dd08ea5b8b6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/cellEdits.js\":\"0066f45f47c0bd77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/childrenViews.js\":\"95378c5258988a32\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/columns.js\":\"9368d5fea3c92611\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/controller.js\":\"bf696180a7e8150c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/convert.js\":\"013f42a8b8f5f628\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/dataExtension.js\":\"6719949be8cd98d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/index.js\":\"797824c175b95db4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/keys.js\":\"b6127369478952dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/model.js\":\"2257afe96c71e8ac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/backfill.js\":\"5dd384739382c113\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/completion.js\":\"d827f9c21e32c45c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/format.js\":\"46e927ce88f0bc80\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/parse.js\":\"24dea5c14b34ff80\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/queryValue.js\":\"06504413b46a7fdb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/source.js\":\"15557a631a7a8d99\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/registry.js\":\"c34f53d7de1c70e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowGutter.js\":\"4a6e9b5abf3a0796\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowVerbs.js\":\"3e2f437d6547c4b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/schema.js\":\"a410ca264e595bc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/sort.js\":\"d399bc31088deb4f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/effect.js\":\"5df21238beb819dd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/index.js\":\"a759341f91377a50\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/theme.js\":\"b6f5cc633e73557f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/actions.js\":\"f2d0e6895c2a4e4f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/dataExtension.js\":\"7e21a8962e88ea3b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/index.js\":\"c04ca963f46ca164\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/schema.js\":\"c92901e4256ccebd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/TouchSelectionLayer.js\":\"600102edabf9c115\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/actions.js\":\"07841f6a646c19a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/defaultItems.js\":\"231eae0fdf846c9c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/facet.js\":\"c6a3553acc83bcac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/holdRecognizer.js\":\"fcb943ab2674cbf2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/index.js\":\"2a0c73d9232df8d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/UpdateIndicator.js\":\"bf0f2c03cbf8abe7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/index.js\":\"49bef2778c59fe45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/loadTimes.js\":\"889a948ee71b9ff5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoNotesRenderer.js\":\"dde3325b73b5aeab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoPlayerRenderer.js\":\"3ed0fec23b783107\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoTimeStamp.js\":\"904d72409fb5a5f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/actions.js\":\"941f1f2f9057db39\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/index.js\":\"2759fc48c8bb99b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/markdown.js\":\"1d4d471b06c7494d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/notes.js\":\"457812943adb2cbe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/registry.js\":\"0bb96af94ccec46e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/remark-timestamps.js\":\"175130489cf725b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/view.js\":\"4da68b3e51e10432\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/LinkHints.js\":\"156d753ea87d664e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/index.js\":\"f680703e563f2dca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/model.js\":\"8a21553e4ed06117\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/settings.js\":\"a611af94b6c4cf2d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/actions.js\":\"62158bc5e58ee8ff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/index.js\":\"9038bac92d5fb1d8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/interactions.js\":\"a8fcd52366d6ee2b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/workspace-header/index.js\":\"6121eb911ed8010d\",\"/knowledge-medium/pr-preview/pr-1871/src/registerServiceWorker.js\":\"665d2e2021e949d2\",\"/knowledge-medium/pr-preview/pr-1871/src/requestPersistentStorage.js\":\"621e438dcdc108d0\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authRequestDeadline.js\":\"1bda8d1c5ccde813\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authStorage.js\":\"2656de2aac57d81c\",\"/knowledge-medium/pr-preview/pr-1871/src/services/powersync.js\":\"23802013c7e73010\",\"/knowledge-medium/pr-preview/pr-1871/src/services/supabase.js\":\"6831696052a85de8\",\"/knowledge-medium/pr-preview/pr-1871/src/services/uploadErrorClassifier.js\":\"ec16ef5898cefb44\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/ActiveContexts.js\":\"282b0e04da94b497\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/HotkeyReconciler.js\":\"7901be79d45b4a4c\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/WipeLocalDataDialog.js\":\"8cdefaf153166bc5\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionDispatch.js\":\"4fe9fc79f2821b4b\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionRefItems.js\":\"8a35e771bfddb69c\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/applyKeybindingOverrides.js\":\"dd6ec818136e9c3d\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockActions.js\":\"48746e6b71954a3a\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockMergeGesture.js\":\"8c8bdf6df7b2c918\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/canonicalizeChord.js\":\"8ce005e1b9ec54c7\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultContexts.js\":\"41512554a8661fa9\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultShortcuts.js\":\"d50639ceb2b9ce65\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/effectiveActions.js\":\"57ffd1fc0cfe1029\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureAction.js\":\"fc63bf7142f7b4e7\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureBinding.js\":\"4d98168d6b7847af\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/holdRegistry.js\":\"5555e1c35af4167b\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingConflicts.js\":\"7bb5f4af4f9989df\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingOverrides.js\":\"57d0f1f118d6dbb8\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/pointerAction.js\":\"d51bf1df90ada517\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/resolve.js\":\"4db181ac1151eb5f\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/runAction.js\":\"0f9b7f756a29286d\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/sequenceMatcher.js\":\"5a4eb82dd017d9ce\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/types.js\":\"9a3c42f8754a2301\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionContext.js\":\"7b1f8fec9f78f9e6\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionDiscovery.js\":\"65318c9e6674727a\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/utils.js\":\"cf7d2ba54f927237\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/bootStore.js\":\"0b9daf89e420fbdf\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/previewDatabases.js\":\"03b799971045c76d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/byteTransform.js\":\"5e64142c6f63e604\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/attachmentCleaner.js\":\"70636262cbe9311d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/attachmentParts.js\":\"78b4acdb3f1856ad\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleParts.js\":\"78f4685a41234dfb\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleRecord.js\":\"d19eae542c1ba077\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/manifest.js\":\"0d58205e34d4a619\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/takeBundle.js\":\"97d20489bd2254e1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/verifyBundle.js\":\"d15721839d67d6ec\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/cleaningStage.js\":\"0393e4a2959277a4\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionKey.js\":\"f6d85560e2ef03cc\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionServer.js\":\"c6620e25a7bef6c2\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flip.js\":\"bfb92417d46eebe4\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flipAttempts.js\":\"2a390066bc6da03f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/pages.js\":\"e41ca293299b7a4a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/preflight.js\":\"88b2a31fc91bc4cc\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/reseal.js\":\"763f46abc5a3fe98\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runConversion.js\":\"01e7c940d832c1cc\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runLock.js\":\"94891c6b330fbf86\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealing.js\":\"1f78f5e15dd3bb74\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealingStage.js\":\"bd59286a5e123a98\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/stage.js\":\"8c48249cfc7a36bb\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/verifyReseal.js\":\"0053e52f0ebc02c7\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aad.js\":\"ecc5e5f1632e72e8\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aead.js\":\"7bd60fe1b5938be4\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base32.js\":\"59f80c92c80fb89e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base64url.js\":\"1f54a55f12c70264\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/binaryEnvelope.js\":\"834f10e15034ee20\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/byteAead.js\":\"994278706ad7ac06\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/canary.js\":\"5c8a7439bbb3ba93\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentHash.js\":\"203aa4b73643f69a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentKey.js\":\"670f576c58313035\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/derivedIdNamespace.js\":\"54a63ff669ba3e3b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/envelope.js\":\"57f0c198a8c0f835\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/hex.js\":\"be98684a8921447b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/sha256Hex.js\":\"1ca67d6e71c3952c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/workspaceKey.js\":\"a8c896be412cf81c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/conversionState.js\":\"0a3825e64747b12a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/createEncryptedWorkspace.js\":\"33b86df53c89311f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/pastedKey.js\":\"98a3ba3c5e62eb3a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c858107cdf47dafa\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7f76716757f78752\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/keyStore.js\":\"1da362a92761371e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/mintWorkspaceKey.js\":\"485722726fcda646\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/modePin.js\":\"781675e814cf862e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/openWorkspaceKeys.js\":\"884db51d1c83d58e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolveWorkspaceEntry.js\":\"4ab1e92fd1fc95d4\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolver.js\":\"ead62571cce2acc1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/workspaceAccess.js\":\"65a27bd61b22d862\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/transform.js\":\"dab7a0f2be2662aa\",\"/knowledge-medium/pr-preview/pr-1871/src/themeBootDefaults.js\":\"2359c8b90efa4fb8\",\"/knowledge-medium/pr-preview/pr-1871/src/types.js\":\"5faf838376f7e2c2\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/ClientLocalSettings.js\":\"2e1b9da4bcb845cd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/abortableSleep.js\":\"7e974310bdd9d1b8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/array.js\":\"d64b249db0de2edf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/backlinkAutocomplete.js\":\"f32e2a6cb1204b25\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockCrumbs.js\":\"4bc54f9e440cb56a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockrefAutocomplete.js\":\"c2da2283cce7c244\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/cadencedIdleJob.js\":\"b4324e88983b19de\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/callbackSet.js\":\"33af6c8fcb5b9adf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/clientId.js\":\"5259ae304f06df21\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirror.js\":\"c8a2a77cc06f2882\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirrorCompletion.js\":\"9c16d470759f2f93\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/copy.js\":\"1538c7bdacbb1dac\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dailyPage.js\":\"0ba153f27997b1a3\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensics.js\":\"6d10595185cd638c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensicsHooks.js\":\"47443a5e5c002a55\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/deleteBlockThroughUi.js\":\"fbce8f01768467e6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dialogs.js\":\"200615e0914e5710\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dom.js\":\"4ce9637f015e331c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/downloadBlob.js\":\"8624fd0d30d3e158\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/drawnWalk.js\":\"5367149535231181\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/exportSqliteDb.js\":\"0f2345d41ce8441e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fileSystemAccess.js\":\"697bb197cc371b58\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/flipSlide.js\":\"ee0d97c6158159bb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fnv1a.js\":\"ab73a19022230fe7\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/formatBytes.js\":\"e4183f67b40ea56c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fuzzyRank.js\":\"af6214233b20fbaf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idbKeyedStore.js\":\"c9b506d5e9fe5cc8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idleCallbackPolyfill.js\":\"51a281fcb9acc030\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardAwareScroll.js\":\"1363271cb75b4696\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardViewport.js\":\"6443bc085acd152e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/lastWorkspace.js\":\"55b8915df646c55a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutColumns.js\":\"16e2bd91a1dbaa7e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionDom.js\":\"afef5bdf712dc743\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionId.js\":\"06a52fb181a580de\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkClickGestures.js\":\"679ed04eebfd7fbc\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkTargetAutocomplete.js\":\"f4edb81ddeff96a4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbCorruption.js\":\"010137b00a49e08f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbRecovery.js\":\"4be11803b5f39602\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/markdownParser.js\":\"6c95b7c655d733ff\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/memoize.js\":\"68679f826f995167\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameFieldCommit.js\":\"90cfa0e47bbc7465\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameList.js\":\"f3807987a50c96bf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/navigation.js\":\"86c59e9970d85ecc\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/omnilinerNamespace.js\":\"bfa7b8dc5c33fdd6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/opfsPageScan.js\":\"e33371159df5d58c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelClearance.js\":\"3d88d9a45d0eee69\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelHistory.js\":\"295e792d33207bd1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLanes.js\":\"9f73758175a7fc3a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLayoutProjection.js\":\"570a31322730e37e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelScrollAnchor.js\":\"a8ae98f43fab8ad9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelUrlFlags.js\":\"2f6f11f78532d88f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/platform.js\":\"ab608e80ff8669a5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/pluralize.js\":\"6e1c2944c38357ce\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyCreation.js\":\"881835a012aed4de\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyNavigation.js\":\"782240ba88013e14\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyValueContext.js\":\"c29380a0d69f252e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/react.js\":\"b14b6762e81ddbef\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeDate.js\":\"ad3a6a22b87c972b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeTime.js\":\"2342ddb57b941741\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/renderScope.js\":\"a7c9c96b5348039e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/resolvedThenable.js\":\"5f9929887a72ab33\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/routing.js\":\"5eed9084fc6fa04d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/safeMode.js\":\"2300d2506e6f1109\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/scheduleIdle.js\":\"623cb5170d657d64\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/screenWakeLock.js\":\"e6483792b261fed0\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/selection.js\":\"88df2e95f35633ee\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/softKeyboardGrab.js\":\"7fe5b597f86630fd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/startupTimeline.js\":\"05fb3968ef6a18f1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/state.js\":\"c503efd0e68aa701\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/string.js\":\"ca299d21dd49aac6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/surfaceZoom.js\":\"b3dbec501d296f92\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/time.js\":\"6d1e9cb697d1fa1d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toast.js\":\"7ef3bf50a4a88569\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toggleStore.js\":\"245a16da34626084\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/untilStopped.js\":\"ccbc83bff3bcad5f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/userActivity.js\":\"d5bf37ce4f91b799\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewTransition.js\":\"72b44e98f32096ce\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewport.js\":\"1b65ba8e52ba11c1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/webLock.js\":\"eccdd427a46440a9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceRecovery.js\":\"16ca706d673a9218\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceSnapshotStore.js\":\"afe63b5b1b6b4d19\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-compiler-runtime.js\":\"727d8eec64321f24\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-client.js\":\"f5578e4f3d6f469b\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server-edge.js\":\"923f7e48fbbafc0e\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server.js\":\"11c831a83b87371e\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static-edge.js\":\"a68260974621f826\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static.js\":\"a0e6955aa0d1cae2\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-test-utils.js\":\"bc42ae73a824b950\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom.js\":\"8caceb97dcb20aa8\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-runtime.js\":\"ef6a054f107f8937\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react.js\":\"282465b3bffe56a6\",\"/knowledge-medium/pr-preview/pr-1871/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
