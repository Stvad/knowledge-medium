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
		buildId: "720203200dbb-3e3ba44b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/\":\"06445f308f5544c3\",\"/knowledge-medium/pr-preview/pr-1871/index.html\":\"06445f308f5544c3\",\"/knowledge-medium/pr-preview/pr-1871/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1871/assets/FacadeVFS-5-Rp_pVQ.js\":\"f53bdf1ce146c6c8\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSCoopSyncVFS-B83hK4f3.js\":\"2c426a8314537c3a\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSWriteAheadVFS-CzKeCFKl.js\":\"5e5fb96846c41f54\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-BBsewdBI.js\":\"28add0a885c8a072\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-De1cUen-.js\":\"fa7a324e3160c659\",\"/knowledge-medium/pr-preview/pr-1871/assets/worker-COJ-N9bu.js\":\"790a91f589ff8639\",\"/knowledge-medium/pr-preview/pr-1871/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1871/chunks/app-DwwBizJm.js\":\"92a7bc1ac58b3209\",\"/knowledge-medium/pr-preview/pr-1871/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1871/index.js\":\"2bb1053e6de18421\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1871/assets/AccessHandlePoolVFS-BYuHB7sq.js\":\"72973f7422af2382\",\"/knowledge-medium/pr-preview/pr-1871/assets/IDBBatchAtomicVFS-Ds943PgS.js\":\"7f92d120076c07f1\",\"/knowledge-medium/pr-preview/pr-1871/assets/MemoryVFS-CO5l7-I2.js\":\"248838b44ab2f0ea\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-CU-A7mYV.js\":\"4716fd8b6dfea46e\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-CVdZB38t.js\":\"0c70278555fb30cb\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1871/chunks/AccessHandlePoolVFS-gQsL8xmJ.js\":\"c432a2004ae1749a\",\"/knowledge-medium/pr-preview/pr-1871/chunks/FacadeVFS-DxAOhyS4.js\":\"84bd3fbe26be44b4\",\"/knowledge-medium/pr-preview/pr-1871/chunks/IDBBatchAtomicVFS-DtYMDaCx.js\":\"ee904d6d90459520\",\"/knowledge-medium/pr-preview/pr-1871/chunks/MemoryVFS-BFChUigf.js\":\"ad806b0c1972d0ea\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSCoopSyncVFS-CwMwUBoa.js\":\"a5e2ca935b6a4040\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSWriteAheadVFS-DK0zkOVk.js\":\"69d902560fced702\",\"/knowledge-medium/pr-preview/pr-1871/chunks/Preview-C5JnKNLn.js\":\"db60b95344f0d3b0\",\"/knowledge-medium/pr-preview/pr-1871/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/card-Btc7MmIi.js\":\"679627e41fb23f3a\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-VcjymDqs.js\":\"1701dd8efd815c71\",\"/knowledge-medium/pr-preview/pr-1871/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-CvTZkBC2.js\":\"d6ebcaa7e42d86b0\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-async-Cj4H6ekn.js\":\"6acbf23af4f49988\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-B-zZ82r7.js\":\"71e2124421d5eefe\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-BnatO7zW.js\":\"80a96af718814f64\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-CBggmkrq.js\":\"6572a8df71121beb\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-CrvaXjYb.js\":\"f11d6434c3869a95\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-CtUFW-vS.js\":\"3115ce0cd7f44e39\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-DXgHQYc-.js\":\"f5212cba0adfa593\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-Ix4AzvUL.js\":\"60260240cc9b4f5d\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server-legacy.browser.production-bypghUje.js\":\"0fb90f64a92b887c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.browser.production-D2phK5kd.js\":\"c083f073273feb93\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.edge.production-BkLkJf6p.js\":\"d7746d4d205b29a3\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-zan93CM_.js\":\"73e340a4d8096ba4\",\"/knowledge-medium/pr-preview/pr-1871/chunks/server.browser-bhFMINEp.js\":\"41541bb61b899bad\",\"/knowledge-medium/pr-preview/pr-1871/chunks/textarea-BzSvfcUW.js\":\"4c8e9d02774af128\",\"/knowledge-medium/pr-preview/pr-1871/chunks/ui-DVgU3DVm.js\":\"5784c475e5613f4b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-CgBhpLTs.js\":\"ef6b03adbe20b8b1\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-async-CyAgKzcU.js\":\"12e2e079e00ddf1b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1871/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/src/App.js\":\"80723a68b6b2e557\",\"/knowledge-medium/pr-preview/pr-1871/src/appUpdate.js\":\"368e95049d89a953\",\"/knowledge-medium/pr-preview/pr-1871/src/appVersion.js\":\"3b28b6881302e2fe\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/initialLayout.js\":\"2e039e143161b27d\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/openWorkspaceData.js\":\"94c5b3c0a7671841\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/resolveWorkspace.js\":\"ead8738341172a51\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/workspaceBootstrap.js\":\"8aaab5b893f2c212\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockComponent.js\":\"6c31e61cde35f580\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockCrumbs.js\":\"e8a37fb840bf14ab\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockEditor.js\":\"f92044515b9a2f2c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockLoadingPlaceholder.js\":\"6e89ac5aa180f590\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockProperties.js\":\"7e36174d24dc66b3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockSearchPicker.js\":\"38ac8f7b3ba6c6f6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ConfirmBulkDeleteDialog.js\":\"286522e99f995919\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DividerHandle.js\":\"b049ee55561fde70\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DraftEditor.js\":\"4a8ff1e945246c2b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/GutterPill.js\":\"f908e1950da11f93\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Header.js\":\"acd5e76259f1aadd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/LazyBlockComponent.js\":\"3c11d83fe48b4bad\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Login.js\":\"55f46ab7f184589f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ZoomableSurface.js\":\"bf4ab926d6be9bee\",\"/knowledge-medium/pr-preview/pr-1871/src/components/editModeKeepalive.js\":\"2ad001664b8a7c37\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyDisplay/PropertyDisplayScope.js\":\"37c1ca655f5a94a5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4d2f26b57bfb2ced\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefPropertyEditor.js\":\"a8bda14ec6a521c6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefTargetTypePicker.js\":\"d2fe6e6aa16e9dab\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/SelectPropertyEditor.js\":\"53fe2fb16531f810\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/TypesPropertyEditor.js\":\"f7ce9255650f86d9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/defaults.js\":\"9698483b43abbc59\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/kernelValuePresets.js\":\"1e38035a8a48b3c6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/selectablePresets.js\":\"177759fb3bce806e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/typesPropertyUi.js\":\"477a7f8b0255f811\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/AddPropertyForm.js\":\"c75736582b1b4ccf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyPicker.js\":\"d840810603e9f93f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyRow.js\":\"5c9e37d376f71d95\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/Rows.js\":\"20aee576be55de3c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/actions.js\":\"f0ec6b4c77e41dd9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/declarationOnly.js\":\"51f24bd5878c410b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/layout.js\":\"a7592780ed5b84ca\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/model.js\":\"b37f291df60544e3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapeUi.js\":\"aeb9b0ac285cbce9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapes.js\":\"f672ea78541f9280\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bf8ffe9f52096c9f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/visibility.js\":\"20919fd72bef47d2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanelSections.js\":\"bd389f527ab8f211\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockEmbed.js\":\"31be621546677aaf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockLink.js\":\"415ba2d307e27c52\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockRef.js\":\"7b6f20c81119708e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/ReferenceLink.js\":\"89a7e134ee0aed6a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuard.js\":\"248437061e06ae23\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuardContext.js\":\"7df13148ad4f90e9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/linkInteraction.js\":\"a74f54c23b6880ae\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/referenceLayout.js\":\"9167d0d27e42a26f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/useBlockRefAncestors.js\":\"090a1510f47afcc0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockGutter.js\":\"c32a99431c45284c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockInfoDialog.js\":\"f92835be9b17bb20\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockTypeBlockRenderer.js\":\"a1a85990185c4556\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BulletHoverCard.js\":\"997286ba188351d7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorContentRenderer.js\":\"24674ada7dcf7120\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5d5974d855778b5b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ColumnResizeHandles.js\":\"9f3473fe5a2b6a1c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e8164da39c2174aa\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/DefaultBlockRenderer.js\":\"323de44ef502d362\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/LayoutRenderer.js\":\"0b4cf7aa90c48c9b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MarkdownContentRenderer.js\":\"15a6d91c1405a182\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MissingDataRenderer.js\":\"4c69fb68df216f87\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PanelRenderer.js\":\"9e4b4082a07fe866\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PropertySchemaBlockRenderer.js\":\"44b68f7af5285749\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/TopLevelRenderer.js\":\"dcf3ffb9da24f999\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockGutterMode.js\":\"ad64a985bc1e28c4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockTitleText.js\":\"035d6c1e425c2be8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/fieldCreationKeydown.js\":\"b6da9be57b74ef5b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/layoutRootContext.js\":\"d7e92bb058a49523\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/TypeChip.js\":\"1efcd27d3a206db3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/chipStyle.js\":\"a02cfbb92d9eaf80\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/anchored-floating.js\":\"f08796f44578ca44\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/button.js\":\"c0ec15d048cd00be\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/card.js\":\"5abd97fc3157fb2d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/checkbox.js\":\"f6ce39b1509e9a31\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/collapsible.js\":\"b0056f2684420d37\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/command.js\":\"fff959afe2186d2b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/context-menu.js\":\"123dbcab99d76385\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dialog.js\":\"c4f5a98b4a260b89\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dropdown-menu.js\":\"d1c6e6907db30cbe\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/floating-listbox.js\":\"5f62a54a7592ddf6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/index.js\":\"9f59096561d758cc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/input.js\":\"4c5a4375e9029b1b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/kbd.js\":\"72c023fc0109a8a1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/label.js\":\"26cbc3703aa18386\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/textarea.js\":\"51d9dd8de9bf40f8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/useEditModeYieldKeepalive.js\":\"e7e0f5a35e5daad2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/BootFallback.js\":\"86992bd09944a8ac\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/FocusedRowLazyMount.js\":\"38ff2fd145e17f23\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LazyViewportMount.js\":\"3f1fa9bdd8bdfab7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LocalDbCorruptionFallback.js\":\"3e66b476f27c470e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/error.js\":\"4817eb2344a5f8c4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/lazyMountRegistry.js\":\"ecce93d582f2b038\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/suspense.js\":\"91dedba2ef5d7d44\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/CreateWorkspaceDialog.js\":\"9a1eb2c8c18d1a90\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/PendingInvitations.js\":\"ce6d1521c502cbdc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/SyncProgress.js\":\"953ee3a4a81265c0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/UnlockProgress.js\":\"3578c9e6e62cc1a2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceKeyGate.js\":\"ebbbae3d200149ef\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSettingsDialog.js\":\"a64d57cea2d136c5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSwitcher.js\":\"7006b5fc759123ce\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSyncGate.js\":\"2586d65b6d33ee27\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlow.js\":\"9ade9ee57ce4fc7d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlowHost.js\":\"c8de585352fa61cb\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/EncryptionSection.js\":\"f4045312216c822a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/attachmentPrompts.js\":\"e4ce230a068c3ffd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ffe131ef40e43584\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowDeps.js\":\"43193591243d14b7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowStore.js\":\"9bbd1b0d8f66e900\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/flowUi.js\":\"9fdcdaff1f6e6a82\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/useConversionRun.js\":\"d2e124b911c779dd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/keyUi.js\":\"067db4dedb66f87f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnKeyLoss.js\":\"bead320501f7af8e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnServerE2ee.js\":\"d3c6cc04556a9bb4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/workspaceUnlocked.js\":\"0c37058579b2219b\",\"/knowledge-medium/pr-preview/pr-1871/src/context/backgroundSubtree.js\":\"e589cdf3601e71bb\",\"/knowledge-medium/pr-preview/pr-1871/src/context/block.js\":\"fde5ed1f2a21fff0\",\"/knowledge-medium/pr-preview/pr-1871/src/context/layoutWsContext.js\":\"ad55104dcf5e7e32\",\"/knowledge-medium/pr-preview/pr-1871/src/context/propertyDisplay.js\":\"599915ec6f8aa0a4\",\"/knowledge-medium/pr-preview/pr-1871/src/context/repo.js\":\"9eb1300cd4586241\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasClaim.js\":\"a60ce579f870ecf0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasSeatNamespace.js\":\"e7607673e9a59fd0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockData.js\":\"d202aef0c95dad0b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockType.js\":\"f543e0db276e7029\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/changeScope.js\":\"519f01544c8e8d94\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/codecs.js\":\"9354f1baa8634c4e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/derivedData.js\":\"44eb7fd32369abe8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/errors.js\":\"d1a75b91cafcae97\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/events.js\":\"b48dfb313f1b3f53\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/handle.js\":\"3046df203be466c8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/index.js\":\"95ce501c9fff63f8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/mutator.js\":\"d9a0ac3b4eca01b7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/processor.js\":\"31925615aecb46e4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/propertySchema.js\":\"4410bcba2ecffe9a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/query.js\":\"819f522ec3f7c0c1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/sameTxProcessor.js\":\"bff4d776228c5c20\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/schema.js\":\"3046df203be466c8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/tx.js\":\"3046df203be466c8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/typedBlockQuery.js\":\"4919ab590fa00314\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/user.js\":\"2bd88756b1b1ad2e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresetCore.js\":\"015d0c6eed0ec444\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresets.js\":\"7273d8be23801e64\",\"/knowledge-medium/pr-preview/pr-1871/src/data/attachmentCleanerIOVerb.js\":\"bdd3844b5fcb7a75\",\"/knowledge-medium/pr-preview/pr-1871/src/data/block.js\":\"94776f3d87698ca7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockCache.js\":\"c5523a6abdbc253a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockChangeCursor.js\":\"5b155f98cd9dc106\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockId.js\":\"c20983319aea0131\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockLiveness.js\":\"025425911a388253\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockMerge.js\":\"4d28f7f5dbdc38e7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockSchema.js\":\"a6934159bc509a83\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypeLookup.js\":\"fdd75e07f6189b24\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypes.js\":\"1520798ce0b40f21\",\"/knowledge-medium/pr-preview/pr-1871/src/data/childrenView.js\":\"0c7f61d06db86d0f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/clientContext.js\":\"2051359bad2e0823\",\"/knowledge-medium/pr-preview/pr-1871/src/data/dbFileSiblings.js\":\"fe4642207e976831\",\"/knowledge-medium/pr-preview/pr-1871/src/data/definitionSeeds.js\":\"3f9221a383cfcae1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/derivedIds.js\":\"eb0dacaed56af0fa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/drawnSubtree.js\":\"205f3bbe5b47a618\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facetBridge.js\":\"31818fd3a0ef8a25\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facets.js\":\"446945327235a041\",\"/knowledge-medium/pr-preview/pr-1871/src/data/globalState.js\":\"d100aab24a3237f6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/aliasClaimRederiveProcessor.js\":\"9e7d637faa8d2dc0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/ancestorBatch.js\":\"f30e4a93d7f6abad\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/blockTypeTypeifyProcessor.js\":\"309be186bdd750db\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/clientSchema.js\":\"d37e4aeb7a897aa7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/commitPipeline.js\":\"536c60ce421f94d3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/devAssertions.js\":\"ec48b91639eb6f3a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/firstSync.js\":\"b31d7eeb0581f744\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/freshInitialLoad.js\":\"ea28383dec49187a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/graphBackfillClaim.js\":\"49fd1e06f8eb9671\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/handleStore.js\":\"5ec6d116c7e589fe\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/idleMarkerJobs.js\":\"714938bca78f6ad7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initialDownload.js\":\"c9f0f1d93de9d6c1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initializeClientDatabase.js\":\"bdc4545e80407ab7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/jsonCanonical.js\":\"3bdc561f9994e029\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelInvalidation.js\":\"21bf7092f18d272b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelProcessors.js\":\"83a296add8f7396b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelQueries.js\":\"6fbfdbdb6dd3a579\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/mergeTypeMembershipProcessor.js\":\"767c19ba644261cc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/normalizeReferencesProcessor.js\":\"68d29974f1e0858c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/poolInstrumentation.js\":\"0110805711f7d9b2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/processorRunner.js\":\"54d88d35122a7289\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyCellBackfill.js\":\"810658a0a7e335f4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildMint.js\":\"c35de94b92537763\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildrenProcessor.js\":\"f323a735a524452d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ecc8f518220f228a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionSynthesis.js\":\"b2e9aad068e4e13c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyKeyScan.js\":\"4d806e5bd2bdd981\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertySchemaResolution.js\":\"9a04b7108f3c9a46\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyValueEdits.js\":\"845c61d94d195d95\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/raiseProtocol.js\":\"3fab5926c13bbbb3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/readBatch.js\":\"e0b630f22c61de76\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/refProjection.js\":\"d05bf2ef1945f5d7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetLookups.js\":\"2a1345669a89d54f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetProcessor.js\":\"f32fedfb2dc50593\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/replayMerge.js\":\"e4bb0e0e52bdf012\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/sqlBinds.js\":\"1903e17db53536fc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6ce848907066300f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/arrivalProcessors.js\":\"c42b4dd96d365a23\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/invalidate.js\":\"d4bb04f636369e04\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/materialize.js\":\"0b0ea495ba88deed\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/observer.js\":\"2c2fcdda6051ca37\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/reconcile.js\":\"bc14047c501de7f0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/timingMetrics.js\":\"bcc8552f12909f8b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/treeQueries.js\":\"506312adb7871ce0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txEngine.js\":\"4f97e576be1803e7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txSnapshots.js\":\"8b8b4af4bb890bc3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/typedBlockQuery.js\":\"f5180b40370d46d7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/undoManager.js\":\"f328b5fc0a955441\",\"/knowledge-medium/pr-preview/pr-1871/src/data/invalidation.js\":\"f0d02c2d6d7f6384\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelDataExtension.js\":\"3dcd0f5ac9eb436f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelPage.js\":\"3dee8c88d16703dc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelValuePresetCores.js\":\"b050dae2acfb1a33\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbCorruptionSignal.js\":\"8f760ca932b56379\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbStorage.js\":\"09e6b5738d43e092\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbVfs.js\":\"4a2931fe1e4f446c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localSchema.js\":\"653e06b777049b68\",\"/knowledge-medium/pr-preview/pr-1871/src/data/maintenance.js\":\"acc9bba20e347f61\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mergeProperties.js\":\"c7e81e08b0935ced\",\"/knowledge-medium/pr-preview/pr-1871/src/data/metricsConsoleHook.js\":\"b9ef41e3998a5f5a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/migrationsPage.js\":\"5bf02628a65f5b84\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mutators.js\":\"0fb1a1bb5784f1b7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKey.js\":\"0401217feb511e7a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKeyPlacement.js\":\"5b87bc61ad509f0c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/outlineSurface.js\":\"9fac9cb541962ab4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingEditorContent.js\":\"20591a2be37cb4de\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingUploadsSql.js\":\"e0cdc7003596dfbc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pluginStateExtensions.js\":\"132d2e1f10f00d74\",\"/knowledge-medium/pr-preview/pr-1871/src/data/powerSyncLogger.js\":\"3297767d2186376a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/projectorRuntime.js\":\"0a2c2cf21898a9d4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/properties.js\":\"1f42cf73a1a073d0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertiesPage.js\":\"4c802b9b733f91b5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyChildren.js\":\"65fc115b766286a5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionFanout.js\":\"eac229ffbb0f521f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionMetadata.js\":\"33a38bf9aec6e610\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionRegistry.js\":\"6fa93691b661599e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDisplayMode.js\":\"2276985a2fe3a737\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyRowCreation.js\":\"a404e234c6e4d755\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySchemaCreation.js\":\"7de28159d3c7ee8e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySeeds.js\":\"6908e107a34935ce\",\"/knowledge-medium/pr-preview/pr-1871/src/data/recentsPage.js\":\"e32989a487392a96\",\"/knowledge-medium/pr-preview/pr-1871/src/data/referenceBlock.js\":\"4662c98eb6a41952\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rejectedUploads.js\":\"5c07a1ea394f3718\",\"/knowledge-medium/pr-preview/pr-1871/src/data/releasePowerSyncConnection.js\":\"fe85eb307547499c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repo.js\":\"6f6163f5d8a795ca\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repoProvider.js\":\"4a4702a2b0ac9a5d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rowProperty.js\":\"4a78df1fa578c93e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/searchFilter.js\":\"f99176f985dc3253\",\"/knowledge-medium/pr-preview/pr-1871/src/data/seedIdentityLedger.js\":\"87ccd41bccb26378\",\"/knowledge-medium/pr-preview/pr-1871/src/data/stateBlocks.js\":\"0d325e02273f79a0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralEditPolicy.js\":\"48581a8ba222ff93\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralInsert.js\":\"cbc38e29f4e817a3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/subtreeDelete.js\":\"b98c51092787af28\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncStreamLock.js\":\"e937d48c5162aa78\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableSqlRecognizer.js\":\"a287345c4e9280b5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableWriteGuard.js\":\"543b18a93ab3dd81\",\"/knowledge-medium/pr-preview/pr-1871/src/data/targets.js\":\"1065c8bdf55696b7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeColors.js\":\"99e596eeceab2cfc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionMetadata.js\":\"3310e25300b552f4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionRegistry.js\":\"cf2864bdb96c0447\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeExtraction.js\":\"edac0c8cc4bb8596\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeInitialValues.js\":\"48f1b5e6d313bcc8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typePropertyGroups.js\":\"32199845c11e4751\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeSeeds.js\":\"818678c65a198c9f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeTagger.js\":\"cbfcc5bd4da016ef\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typedRecords.js\":\"5bfa4652f6bc9182\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typesPage.js\":\"5b91c5dd337da9fc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userPrefs.js\":\"399e106f9ed77618\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userSchemasService.js\":\"009aa2a0c242954a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userTypesService.js\":\"7fc620dfc64102d4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/valuePresetRegistry.js\":\"f64ebb47e4a4f8cb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/visibleChildren.js\":\"a62787537010b9f1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceConversion.js\":\"fec40cef5c5e3586\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceFirstSync.js\":\"472335ff7fbd361e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceIdNamespace.js\":\"cc1090eb26906495\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceSchema.js\":\"a1d5517365ee5e91\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaces.js\":\"cc81dae29da4a0b5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadLog.js\":\"95cf3cf236fc5910\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/BlockPasteShellDecorator.js\":\"c362621d21c0aa94\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/atTrigger.js\":\"d31aada0fb3671df\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/autocomplete.js\":\"bb038da98179bec4\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/codeMirrorExtensions.js\":\"ad42add600ec455b\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/contentFlush.js\":\"9b08d72da3d14e5b\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/defaultInteractions.js\":\"828a2778133dbcd4\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/editSettleSignal.js\":\"7841be37229032dc\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/insertImage.js\":\"40c70449db240c55\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceCompletionRange.js\":\"a12d07b71b5da505\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceTargetTypes.js\":\"80f1fe9d5f3b1db2\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/syntaxContext.js\":\"3c5a7d0b0b117bc2\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/triggerMatch.js\":\"7432a8e94dc644d5\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/AppRuntimeProvider.js\":\"2f9ef5bf85ef3810\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/BlockFocusShellDecorator.js\":\"8a218d4657ea49b8\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/ExtensionRenderBoundary.js\":\"3a829f2c23331b22\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/PanelContentRecovery.js\":\"a53c17809d592bba\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/apiCatalog.js\":\"83a80ea140e29579\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/approveExtensionHere.js\":\"1e1a74d27c80c764\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/armedCutAppMount.js\":\"35863e471d266d32\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/batchableKeyedStore.js\":\"2832fc65de1df0c7\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockInteraction.js\":\"5ac18680ee860c8a\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockSelectionAction.js\":\"7bc8bc35aeb422dd\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compileExtensionModule.js\":\"f91549edaa0d11bf\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compiledModuleCache.js\":\"80f0817432239380\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/continuousGestures.js\":\"44d0e722a4fe723c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/core.js\":\"8215f7c11d443312\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/defaultRenderers.js\":\"6a4a1b0407e177c0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/definitionFanoutAppMount.js\":\"7bb72c72e7c463f8\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dialogAppMount.js\":\"eef36f7c22f30402\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensionSeeds.js\":\"af40fc2a9b172051\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensions.js\":\"028d6e6d405dd24e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/exampleExtensions.js\":\"ace9340aa4cb19f0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionApprovalStatus.js\":\"ee1b603fa7ff17a1\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrorToast.js\":\"37336c6ddc32537d\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrors.js\":\"50225d94ee852d8e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLookup.js\":\"aa5c4661498e733b\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionToggles.js\":\"75f0f7550d29f175\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionUtilitiesCss.js\":\"ff50db7d225c45c0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/kernelPageDeletionGuard.js\":\"77d0bad5aee55152\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/liveRuntime.js\":\"d28fa484e0f14071\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/openExtensionsSettings.js\":\"56b90093f2666cbc\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/overridesCache.js\":\"395a2d122d989cd2\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/pluginIds.js\":\"b83af5f8bcb4025b\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/processorRejectionToast.js\":\"7229dc77ddfead94\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeActions.js\":\"bccd7a5f650dac04\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeContext.js\":\"e8134b74a7952046\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticAppExtensions.js\":\"7ccc60859cf42ca4\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticDataExtensions.js\":\"2c87fcfef87943b1\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/toastAppMount.js\":\"5984a2b18eb930b4\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useOverrides.js\":\"b555fd2b55e64daa\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useShortcutSurfaceActivations.js\":\"cc36e4960163fd9f\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/discoverToggleTree.js\":\"24c935e135e0b19a\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/facet.js\":\"3e3354a0871efcc7\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/resolveAppRuntime.js\":\"eaae5249e22a1028\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/runtimeEvents.js\":\"5646ea30f59d0597\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/togglable.js\":\"ded2d773da6a77f6\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/variantFacet.js\":\"e98c940ed7d877db\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/verbFacet.js\":\"86717292f88e7722\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/block.js\":\"67379f37ebdec909\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/focusedChild.js\":\"8f0fe60e9d01c96f\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/propertySchemas.js\":\"eb441f16162286bf\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/typeRegistry.js\":\"58f87786e9f516ce\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAncestorCrumbs.js\":\"a5cc06580d591c12\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAutocompleteListbox.js\":\"66a4e999e64dc6a4\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedSearch.js\":\"46ea48354ace4744\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedValue.js\":\"d04a78beddc8b032\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsFocalRender.js\":\"9396b3816dca7f2f\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsReadOnly.js\":\"3823f284e2429acb\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMaterializeBacklog.js\":\"270eb5b33c368189\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMinuteClock.js\":\"d7bb0a750b94f765\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePanelLayoutProjection.js\":\"eb515e16385f7bc4\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePendingInvitations.js\":\"15c739417d15fa86\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRendererRegistry.js\":\"84fc08af0f97b246\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRetainedFieldRows.js\":\"ce513642b7645174\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useWorkspaces.js\":\"1360ae275e1c395d\",\"/knowledge-medium/pr-preview/pr-1871/src/lib/utils.js\":\"8d8d82315cb74ada\",\"/knowledge-medium/pr-preview/pr-1871/src/main.js\":\"02a43a99314e5485\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/MarkdownImage.js\":\"afb6add23677cb49\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/blockSeparators.js\":\"55f9ee8949fe94a6\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/context.js\":\"c6981559720683e0\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/defaultMarkdownExtension.js\":\"c1ccd0e19f763449\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/extensions.js\":\"edc0c91ccc88d4bc\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/renderMarkdownHtml.js\":\"69757f0b4e2d84e3\",\"/knowledge-medium/pr-preview/pr-1871/src/minimal-editor.js\":\"64a802e1b87aa1b4\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/armedCut.js\":\"6a027c709614f93a\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/captureMediaVerb.js\":\"226be7cf94832978\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/clipboard.js\":\"6d00d0321ebe9f01\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/decision.js\":\"96216ac708acc626\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/operations.js\":\"a0545be6e8dac826\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/AccountHeaderItem.js\":\"99f6aa2aaf3acb1d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/index.js\":\"93f81c08e2b4fd55\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"286f22cf5df88988\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askAgent.js\":\"99131078311e2ecb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askedStore.js\":\"ad6cc14d7d017ac0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"18d71f7f6b28a7da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/chipState.js\":\"918d6e64f50e8cf3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bcd4bf1479c7b960\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/index.js\":\"cc1273e92e5274a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0f8b0e622996e0ac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/schema.js\":\"48af08a7418473ee\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/AgentTokensDialog.js\":\"473c76f652cd962c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/BridgePairingDialog.js\":\"361d7291de3a1415\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/addMedia.js\":\"611fb08b4e6c2224\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f922b42ecc1dca67\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/block.js\":\"2013c69da7de6680\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/context.js\":\"a879df478e033eb6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/displayIds.js\":\"8564eb6a43c15b5a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/index.js\":\"f215c3c83460f54b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/outline.js\":\"67c4d621b2e9f0d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/properties.js\":\"bd1d42e06e691d6f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/refs.js\":\"46fb6c20d09375f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"11560da630661a48\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/search.js\":\"5dc569514e3218b6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/shared.js\":\"c6eef54587b30125\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"72e51847f8afe5c9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/text.js\":\"bdb89eb3a2a406f2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentWrites.js\":\"4c725eda83e421a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/authoringCatalog.js\":\"e87466f6be2a2dc0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/blockRefTargets.js\":\"f95ca07c5df9e04c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridge.js\":\"358ebe5ec7266088\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridgeLoop.js\":\"bdba89d41ecdde8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/changeHistory.js\":\"0cc2091266577d67\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commands.js\":\"ac9466cf7a957f0e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commentsCommands.js\":\"a260a01d2bc3e9db\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataExtension.js\":\"9392187ff1463612\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataModelGuide.js\":\"447febceba6eac52\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/describeRuntime.js\":\"189f023bd591cec7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/extensionLint.js\":\"6c49c03fdbdd8250\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/grainAudit.js\":\"89081e3da5a524e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/healthCommand.js\":\"386b47ca1446538b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/index.js\":\"8150319379739372\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/presetIdentity.js\":\"175ef4b05d2a1cc4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"dba8b68292a384eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/readMedia.js\":\"c0ed33ae65a1be6e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/schema.js\":\"28abc1b686e6cfe5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/serialization.js\":\"06fe167bd93add94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/targets.js\":\"e8c61aebdb785e92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/tokens.js\":\"b2bc81d1c496e0eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/watchEvents.js\":\"e5c770816ab2d59c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/workspaceGuard.js\":\"20f28d66c07e5f48\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/writeCommands.js\":\"d532ee0e14e5149b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/AliasCollisionToast.js\":\"c3f22df92a719ccc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/DuplicateNameBanner.js\":\"9c2bc0a8a6bbf00d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/collisionMerge.js\":\"c8c49f889e876790\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/dataExtension.js\":\"1771cb915a69e991\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/index.js\":\"1a07999c7195be06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/mergeCollisionAction.js\":\"191804045196158d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/pageStyling.js\":\"f91f2f55af7bd018\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/rejectionToast.js\":\"d63dd28cf087a20e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/syncProcessor.js\":\"b14b8e3b4879f268\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/actions.js\":\"844aec55cce0753e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/addComment.js\":\"4f2d200a8d3a6df9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchor.js\":\"4c407c8402780065\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchorState.js\":\"1643ff9b850863c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/commentLinks.js\":\"a78ca09b2388afb0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/confirmThreadDeletion.js\":\"dbb7584f52bf5175\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/container.js\":\"97f5670a67bbd865\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/dataExtension.js\":\"efae3c0ce983881f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/deleteComment.js\":\"0680614f4a4fffe1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/highlights.js\":\"bd68a84e67a3f667\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/index.js\":\"82659f0bbe4805a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/linkedCommentsPill.js\":\"985a87f68672f2d4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/margin.js\":\"67f9935308db58d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/marginSchema.js\":\"5081cb4e763c08cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/newComment.js\":\"99b71d7f3d3e9835\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ownThreadPicker.js\":\"52155fee72271621\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/placement.js\":\"63e91f4ed8ef8100\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/queries.js\":\"b459d67ef08de382\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotePosition.js\":\"872f27d7cbeffaa5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedIn.js\":\"cc9984db64d5916d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedRange.js\":\"40def782fe060274\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/rangeRefs.js\":\"d6bf31501cf0a946\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readHighlights.js\":\"da8a92ceb9caa114\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelection.js\":\"197eec4be15eec7b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelectionUi.js\":\"acda57a356d59543\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/reanchor.js\":\"69f8da63d4ff5dfe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/schema.js\":\"8f7c16b14c1d4245\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scope.js\":\"37581a63bde8f895\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scopeThreads.js\":\"9f68fc70b227f652\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/splitRetarget.js\":\"eba2b656941d92da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestionCard.js\":\"e534a78b5503cf44\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestions.js\":\"e0280bff0406022e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaries.js\":\"9b1bb5b4bdfbb506\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaryBatch.js\":\"9aa135aa7511dca0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/surface.js\":\"4bffa9d8303f1168\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threadNavigation.js\":\"c32a6b3311edcb96\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threads.js\":\"60e6592893cc84cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ui.js\":\"bf360dfed7c38750\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/uiStore.js\":\"33044e3822de39b6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/appIntents.js\":\"c2643231766dbaaf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/index.js\":\"0f087135fa5895aa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/index.js\":\"16e0daab0bf325d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/status.js\":\"725f1d4127fb86eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"554eb938b95269ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaBlockRenderer.js\":\"9359a3a35a7b0a0b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2e6dfbbfc1317fa1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaUploadReconciler.js\":\"729e7a165c0d4110\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetDownLane.js\":\"80992f3219233c45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetResolver.js\":\"a5bd67deb3da2851\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetUpload.js\":\"61ccf0f58b5453f5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/attachmentCleanerIO.js\":\"b8b99a1d03dc3152\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/supabaseAuditIO.js\":\"20a978d144000850\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/blobStore.js\":\"745e9a3c97238f71\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/browserMedia.js\":\"c584d87123b0b4de\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/byteStore.js\":\"a0d4541c4ee5f0cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanerIO.js\":\"4e85bac0ad433fc2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanupAttachments.js\":\"395e2bf07cb76f0a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/dataExtension.js\":\"687412880dec0833\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/downLane.js\":\"fb8715feac76676d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/index.js\":\"459d7a6d60362cc4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/insertImageContribution.js\":\"abff2f15d88dfe56\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneArming.js\":\"41633fc68947c9bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneLock.js\":\"10a402e4162a7637\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaBlock.js\":\"74ba37364485cf24\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaCapture.js\":\"5dbfa61c6639ef1d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaLanes.js\":\"304b0a47f36cc910\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewers.js\":\"1a934146cd9c2edc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewersFacet.js\":\"ef286c1cbda2a4da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/pasteCapture.js\":\"e3e12f0b7efdd2bc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/resolver.js\":\"df4b7571c79fa351\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/retryUploadsAction.js\":\"5344c6072f873d22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/storagePaths.js\":\"2c918af2ea7b0888\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadDrain.js\":\"2178816abeaffc76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadLaneStatus.js\":\"4c3c7106a04a8297\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadReconcile.js\":\"3f784993be811b63\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadRecovery.js\":\"f34036d6f1d17a76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadStore.js\":\"0d4b95234f02366e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/useAssetObjectUrl.js\":\"39c8c278fe790234\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b42d3783b5324559\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksViewSection.js\":\"af3e7d32ebe8113b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/facet.js\":\"e11f9ba53bea01c9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/index.js\":\"08f774784bb66c25\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/prop.js\":\"1ba05e671c004fbd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinkFilters.js\":\"ec4796d1daacad47\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a3cf3899d0570916\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BlockEntry.js\":\"af02431abd0af716\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/LinkedReferences.js\":\"2977540753314bb5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4e5b5576e2ea32aa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dailyNoteDefaults.js\":\"2832547a98b9e49f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dataExtension.js\":\"9258924c1b2a91a8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/edgeExclusions.js\":\"205a82dd7dd7dea3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/filterProperty.js\":\"03e1e088637498b4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/index.js\":\"6bead56f8cb5a6a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0eca55ca6534b304\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/applies.js\":\"ca60c2120be50a8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/countQuery.js\":\"2ebee5c8bed8ac94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/expansionStore.js\":\"aed2f3ba4c0995ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/index.js\":\"c47d9a9ac89dfc40\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"12aa3c32d5a9a22a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/presentationInvalidation.js\":\"93101ce60188e9f8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyEditorOverride.js\":\"59c433d1a1715201\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyFilter.js\":\"43330d95a5ec1da8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/query.js\":\"c2eb6a536cfc43e7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/resolveFilter.js\":\"61d9c32b16758332\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sourceBatch.js\":\"c2146e953b59074c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sources.js\":\"f2194e40023c0d10\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useBacklinks.js\":\"d31eac9219511f5e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"995bfe6356e15fc7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayCelebration.js\":\"aa19a44395d99ff0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayOverlay.js\":\"ef2fe2c841e13a29\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/gate.js\":\"4092f20f74e429f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/index.js\":\"611ac60f19590c99\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/wolfTheme.js\":\"618b290e0465c892\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/BlockDragLayer.js\":\"16b8955f507ec5af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dragController.js\":\"880047e71e887d5a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dropTarget.js\":\"b119262a38ceba85\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/index.js\":\"edf5580586854e45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/projection.js\":\"f165bcaf8b2b1330\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/BlockMetaCard.js\":\"75e172371617c49e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/index.js\":\"993933c9e7eb0e08\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/AddTagDialog.js\":\"0af0e64ff3ac2642\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f2ac2e14db34598b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/TagNameIssueHint.js\":\"0ebccc73215cde51\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/addTagAction.js\":\"3c0f372901beb858\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/appendTag.js\":\"adeb23ff67b295fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/config.js\":\"7aa2208dbe5c885d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/dataExtension.js\":\"4140267dc3830c62\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/index.js\":\"307d575c20a73f58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/propertyEditorOverride.js\":\"f3e8f4ee469e1790\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5d69d2b41068bb17\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"936806fa7e9c8600\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c63cedc0b8d21be2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eaa25cfe13246ce7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"01740ccca5ff5537\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/index.js\":\"ca442cd6fef0a587\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3d74b6ce558afb99\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/CharacterCountItem.js\":\"6070b4066dcfefa2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fba42cedd0781b18\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/actions.js\":\"0177d6b0a25df79c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/blockType.js\":\"2e0d0a055bf9741d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/charCount.js\":\"0798b274736b5bf0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/dataExtension.js\":\"28a04611f151eebb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/index.js\":\"c16800c1afb54368\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/profiles.js\":\"b651397d00dfe795\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/properties.js\":\"af551bbe9f8b8d1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/textCounts.js\":\"0625d16183beb0b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/colemak-keybindings/index.js\":\"1de060ef3166afe0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/CommandPalette.js\":\"91aede31915daef7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/HeaderItem.js\":\"f9c146efc8cb5454\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/context.js\":\"c8ebc6915cf8c5cf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/index.js\":\"255c5a299f8f3b54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/selection.js\":\"c8c15b4c3f599c26\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/toggleStore.js\":\"63253492f40880ab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/useCommandPaletteActions.js\":\"cb0398dc14ea1839\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/ContributorBadges.js\":\"56bd7c0151b5edc0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/author.js\":\"568a471d761e46d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/codeMirrorExtensions.js\":\"6d605d21d91cb07f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/dataExtension.js\":\"0182a154773fbd18\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/index.js\":\"25353d0ddd12544d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/mentionAutocomplete.js\":\"1272f335c5b854c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/processor.js\":\"5adcaa71d9eb5b81\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/profiles.js\":\"dd9e25bf0d15217a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/queries.js\":\"73eec7ca48cbd470\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/schema.js\":\"393404056e0d7bdb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"31042698541e76bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ea167dff8d6df19d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/index.js\":\"4044ead4aee33b93\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c995741bf3269b2b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"723871a23a1e137e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/CalendarGrid.js\":\"ed5d55fb5aa3e584\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DailyNotePicker.js\":\"7a6ee3797284708b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"cc26785163e478da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateNavDecorator.js\":\"1076f80229b2ec43\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateScrubOverlay.js\":\"28b2d09a79bfb433\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/HeaderItem.js\":\"3d7f526a2457d8ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/ReschedulePicker.js\":\"e255d77b22adef3d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bbff86e506ece958\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/actions.js\":\"561ad7c805bbc82e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/blockDateAdapter.js\":\"49114930d359f3e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/calendar.js\":\"4822539a065cf465\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dailyNotes.js\":\"0f16338388ee2a35\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dataExtension.js\":\"79d61c5567901e71\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubActions.js\":\"f063d74a81574291\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGesture.js\":\"3a6cc720480e4c68\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a64560a6ddc9ade8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubRecognizer.js\":\"862b13635bed2c77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/deletionGuard.js\":\"b16a2d24a80259ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dueQuery.js\":\"5549d18102d56a95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/index.js\":\"b11c4091ae6c645f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/landing.js\":\"d34a072f232334ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/localSchema.js\":\"4b720036c12d041d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/referenceDateAdapter.js\":\"3f3a9061924c209c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/rescheduleAction.js\":\"4b7f33f9d971daa9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/schema.js\":\"5d2c0cab3ce814b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadBlockDates.js\":\"d33cfd1c4f75acf2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadDatesAction.js\":\"8b408528683f3834\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/today.js\":\"379604ca7edaf6d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9ec65569a17306d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ebeabd98c888d00b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/audit.js\":\"466c507a708b425d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditAction.js\":\"d8c6f56b700b425c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditRanges.js\":\"b7e84e84b1044aa8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/diagnosticsSource.js\":\"da314b7834a90553\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/divergenceScan.js\":\"74335781e968ff40\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/index.js\":\"31e75a0782c3fb2f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6d77914644a2bbfa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/referencesMirror.js\":\"e36ed331468139bf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/rowJson.js\":\"049ad2591e3260f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/schedule.js\":\"56e2a300440765c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/store.js\":\"9b132b29d5695260\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/action.js\":\"1b0dab7c76f4c413\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/index.js\":\"7feeea9dba989c34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/plugin.js\":\"625ce354139d818a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8ef59d0a08aebd20\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/actions.js\":\"dd2b967b829cddc4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/changeMarker.js\":\"0a9ba130ae26af5e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/diagnostics.js\":\"e33ddaa1f557ecb5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/fileSystemAccess.js\":\"7ed75050f6c12b35\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/filenames.js\":\"99b97c6eeed6ce2f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/index.js\":\"1b31a1dcaad9eaf1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/mirror.js\":\"067b6778f9a43f0d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runLock.js\":\"1b3a6a9c088220e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runtimeHealth.js\":\"e7825c3cbff7ee63\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/schedule.js\":\"d903b45a4cc15a89\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/store.js\":\"a2d5b3c5863eff94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/index.js\":\"a728230decad26ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/themes.js\":\"38f484b7c85a6528\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/facet.js\":\"fd946ee50a8d2f1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/useDiagnostics.js\":\"37ed0b6b9d83cb86\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/dismissals.js\":\"31654be6deb75d86\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/index.js\":\"d42f7bf98bb57653\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/status.js\":\"3c4b6cbc82095e45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/store.js\":\"86e65f6e3136cdea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1f1a3f67f023b3e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsSettings.js\":\"387832bed1f80399\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/actions.js\":\"74222f951b163ca9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/config.js\":\"d35d1dd330cfb425\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/dataExtension.js\":\"2d6007ec19384e58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/effect.js\":\"a60b3130de81babf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/index.js\":\"7154fdac9823242b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/propertyEditorOverride.js\":\"90b431a56ef7ac84\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/useToggleTree.js\":\"f6a9169057c9212d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/ExtractTypeDialog.js\":\"3f37a0da871e71e7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"22596f1e3a9f9854\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/PropertyShapePicker.js\":\"3fdcedf2d90e7c1c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/action.js\":\"b0348c5f138142ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/index.js\":\"d787d255f9b7d09d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/FindReplaceDialog.js\":\"40fcd13d171ab461\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/HeaderItem.js\":\"b33666e17704504b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/dataExtension.js\":\"03a7098e126529e7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/index.js\":\"a3778f30ce903cac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/search.js\":\"e53a5e66c439261b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/toggleStore.js\":\"2a1027b39ce3346a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/LocationPropertyEditor.js\":\"5b0bf7602e36253e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/MapView.js\":\"eb94e6219a00f6c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/blockTypes.js\":\"a5779f0645ca5efd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/codeMirrorExtensions.js\":\"66c3fa4ffb1839cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/createOrFindPlace.js\":\"66628fb630e2807a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/currentLocation.js\":\"88bc4966ab49caba\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/dataExtension.js\":\"93336ab71fd52939\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/geoContentDecorator.js\":\"478323019e694dda\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/googlePlacesClient.js\":\"c0620921ec48b035\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/index.js\":\"cc56f21a78c16830\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/locationsPage.js\":\"78e12b76671b12f7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/mapViewport.js\":\"c4cb2cb26e896894\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/pickCurrentLocation.js\":\"4759ffeb522f7542\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeAutocomplete.js\":\"5228dc4f01d7ec10\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeNameCollision.js\":\"dfcc2a46c12f5cb2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/properties.js\":\"f3a782dc342bc0bf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/propertyEditorOverrides.js\":\"7379aee3cfb95881\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/query.js\":\"4ff9109ef62566e5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/usePlaceSearch.js\":\"f66b6743e360dea0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"42811f5e337f368b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"faf245995cf88431\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a3575a84e45ffba8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/config.js\":\"6d193bbba9c8c13d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/dataExtension.js\":\"e607e6daeb1e00c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/facet.js\":\"bfa7d5a0db6680c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/grouping.js\":\"83765c0fff50d79a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/index.js\":\"204e161e639c475a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b950455eaf884f84\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/query.js\":\"9488ef51e475c764\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/resolveConfig.js\":\"8be42de55ece5e06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"cd15d0f4511c0c28\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"58dfa6a028eccc78\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlDocumentContent.js\":\"7a9868c1a7b71b2e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlFrame.js\":\"96c595a8be3b1033\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/actions.js\":\"c0161e4ee743a4ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/blockType.js\":\"a9c7385bd3f5b128\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/confirmRunScripts.js\":\"30f7b5085861a469\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/dataExtension.js\":\"d9aa7a5b0b0fe8c8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameAnnotations.js\":\"bf76aab842a37bc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameDocument.js\":\"26b9b15025d1d77b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameTheme.js\":\"4d24495854f27269\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/index.js\":\"7ad2ad84c4ff42d9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/scriptConsent.js\":\"01e144051e38a42d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/sourceMap.js\":\"2752dba6dc81afd2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/useDocumentScripts.js\":\"af4f7c1f122e70a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/index.js\":\"9d03a7b6d60e60e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/record.js\":\"c68fb0688d8be193\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/recordStore.js\":\"601003ecfe87639d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/responsiveness.js\":\"82d6e15b704865d9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/schedule.js\":\"4cbb2d8da097e80d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/sessionContext.js\":\"5ec4471853c23665\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"72e34f0dd5ea6eec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"de0d04638668ed25\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/actions.js\":\"ce72539e59bb55cf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/config.js\":\"29a3c61c475f3531\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/dataExtension.js\":\"5d4b4353f6ffe85a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/effect.js\":\"14f6c3f8001dad71\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/index.js\":\"7e7654f0d54dd9fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/keyCapture.js\":\"9c935dc5688e3c18\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/overrideStore.js\":\"e3542c96386d8ca2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"308da6c1dc00d4d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/HeaderItem.js\":\"d1a558ea8a0e5602\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/LeftSidebar.js\":\"447929c8eee44908\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/actions.js\":\"c96bbf9f79d05919\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/facet.js\":\"743ee94ff5ac26cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/index.js\":\"7ab52ed3096f1f9f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/shortcuts.js\":\"a8891b1a0e540e55\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/toggleStore.js\":\"0a83550e2b109c3a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/MergePicker.js\":\"f4dd6e0980aa1420\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/index.js\":\"52e24d8fe39d86a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/mergeAction.js\":\"f4304a067fc5cb81\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/strategy.js\":\"9cf4c8305eb9f07e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/Button.js\":\"f8271db663f82e30\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6c9551eb801aa591\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/defaultItems.js\":\"871f18924601ac95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/facet.js\":\"fce1c3b5d0b60609\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/index.js\":\"b2dbcf4c793eec54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ced2b3aa32bd9dc9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4498028e3d937c0e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"37b8413651c45b6e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/facet.js\":\"83622ecb193cf37b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/index.js\":\"a494db232266761b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e78ecb3b62151a3e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3d42f125336aa174\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/contextMenuItem.js\":\"5fb69e7b5f32873e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/index.js\":\"d243534003d786a5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveAction.js\":\"7513db78e0486d3c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveBlocks.js\":\"e12ef2fa0cd9dd1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/selectionAfterMove.js\":\"e42df94b68bde042\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/TutorialBanner.js\":\"132d1ef8a2f858b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/action.js\":\"6c7f8e8c5274376b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/bannerDismissal.js\":\"40520093aa91134a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/documents/cheatSheet.js\":\"8624229d393abbda\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/index.js\":\"22e95ad70350fc06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/keys.js\":\"ac0a90f5f3dcee7c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/landing.js\":\"6a6ee9e789245646\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/outline.js\":\"03ae38423f2c8234\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/seed.js\":\"c5083d5f885db85c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b54cee852ff79301\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/analyze.js\":\"46839d23730a6780\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/diagnosticsSource.js\":\"e4c5a71c5f79f676\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/index.js\":\"db020492a0db0783\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/load.js\":\"422936edf421e9f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/monitorRun.js\":\"4c45065f982ed423\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/schedule.js\":\"0e840a1621192c31\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/series.js\":\"d08194b5465a8d8e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/store.js\":\"8522eea3e5181de3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/trendAction.js\":\"4d7fb48cc06e8739\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/verdict.js\":\"5f7359edd3fb9d45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/clickToEditAction.js\":\"55a49c8829814797\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/index.js\":\"8f4003879ce1f633\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/interactions.js\":\"8a1806fd55062bd1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a1e8f3a60f1f6d7b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGate.js\":\"2bbb2433a7c94973\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGateDialog.js\":\"2e481ea2cdbf539f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/action.js\":\"617ac823bd78ac13\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/index.js\":\"7d8ce8f9211a50ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/localRunMessage.js\":\"31ed15a108a1451e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/plugin.js\":\"c6540f604beb2927\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/progressReport.js\":\"7bd2e4a2bd07c913\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/sweepProgress.js\":\"938ed51a4c1a3e06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/FieldRowRenderer.js\":\"b28d08f20738a769\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/ValueRowRenderer.js\":\"0f639187ac8fc405\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/actions.js\":\"79e19bfc8cfd4630\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/autocomplete.js\":\"e0b6399bd8dd650e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/fieldRow.js\":\"65b4cbc563a2d603\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/index.js\":\"a75d5aeca56600ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/referenceWarning.js\":\"02999614ab530293\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueAutocomplete.js\":\"55d19476ad11b717\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueSchema.js\":\"2607ce453db6ef31\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/HeaderItem.js\":\"93317961d4ade0c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/QuickFind.js\":\"654993183ce3368f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/index.js\":\"8d737cfd8dadd653\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/recents.js\":\"2236ed44dc09ae2f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/resultItems.js\":\"382e5a522e1bc982\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/selection.js\":\"0fca1f345e9eb192\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/toggleStore.js\":\"71acb0f92004d9a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/HeaderItem.js\":\"2555a94c233b3f76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/RecentsPageBlockRenderer.js\":\"34fd79d9676ceac3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/grouping.js\":\"e7539f7320f4a46b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/index.js\":\"aa35f4fd00f0d7f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/target.js\":\"fe6b0162553510bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/codeMirrorExtensions.js\":\"67c63acea217a6de\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/contentPrefill.js\":\"fbc3d8ecefa6c66d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/dataExtension.js\":\"cd66b8f4574de965\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/index.js\":\"52ba508ba0614d1c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2d60685a1d8d54d2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/invalidation.js\":\"b0b3abc0e65896ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/localSchema.js\":\"1829ccff789d774f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/index.js\":\"314cc34b37a31331\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e5a5f281fe39925b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/index.js\":\"afa9e6ebf7285009\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/referenceNode.js\":\"accd5d304ab3c5ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c041921118b505ed\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5d1190323a1406cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/index.js\":\"f1f8d32bed123208\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"abccc2832fd0fda8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"14f9154a15a64285\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/mergeRetargetProcessor.js\":\"a619caf52cd9d99b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/parseFence.js\":\"df0156c65a782990\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceParser.js\":\"1aa9d6490602c03e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceProjection.js\":\"6fe7f67555037923\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referencesProcessor.js\":\"9c60ad529f627ba4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/renameProcessor.js\":\"441feb0d0824fed7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/spanReplacement.js\":\"fd9507947e7e71f7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/htmlToOutline.js\":\"83265e96cbeafcbc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/index.js\":\"7566159624c205af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7ef0f783e2e13f37\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/pasteDecision.js\":\"04661d15e064d9a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/action.js\":\"f476c97a8a1c64cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/blockIds.js\":\"aee79a6d7ef4a223\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/content.js\":\"e72ed0a23365bfec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/effect.js\":\"70459c56ab633941\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/ids.js\":\"d65b4a81b063cfaf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/import.js\":\"ffc5e5137a392543\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/index.js\":\"b981a57a805b568a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plan.js\":\"20ee374fa7ae4c18\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plugin.js\":\"24b98c659f345311\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/promotion.js\":\"1d751436609bfa22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/properties.js\":\"3fa911429701f391\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/references.js\":\"ea6f99518a0b1d0b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/report.js\":\"4c97083871266ccf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/roamMemo.js\":\"c2c73ae6be9f9b5a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/runtime.js\":\"0f5006edfaf3ada7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/schemaReconciliation.js\":\"c0fd93891e226785\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/srsMarkers.js\":\"72a5121407a2f344\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/todo.js\":\"e479a433595f58fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/typeCandidates.js\":\"c1be88902c8433fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/types.js\":\"b559afbec459826e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/index.js\":\"356658425caf9b2f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/store.js\":\"aca16bc1c5980bc1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/HeaderItem.js\":\"2d823b697ebcfe1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"db40892650399a2c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/index.js\":\"e194622288f43918\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/model.js\":\"7ca0b371ae282ba2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/toggleStore.js\":\"50196433bfc05573\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/useKeyInspector.js\":\"a3a8d18b48fa9326\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"82afe26be3fe0e9f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/ShellDecorator.js\":\"4ecd5d5e2673e506\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/actions.js\":\"06f70c7050742ca2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/exclusionsFacet.js\":\"27e4f36dd9fc3b2c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/index.js\":\"bab15d7c538d7f94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/shell.js\":\"d684798914a8e3f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/surface.js\":\"f127a48d92d13547\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/walker.js\":\"d83e2d6dec71a1fa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/RescheduleToast.js\":\"59f515ffadadb551\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/dataExtension.js\":\"cc527ea8dfc4bded\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/index.js\":\"ac9be1d6f282ce82\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/indicator.js\":\"b20da0878f595950\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/moveSrsState.js\":\"63ee07b796beadc8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"96cb59740bb10686\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/scheduler.js\":\"0762fa4a77aebfb0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/schema.js\":\"b264f81b428e0d76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3c2ede256f3b4794\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsClipboard.js\":\"3b25b65d428545b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a0cabd149eaaf5ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3037920be6f009c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DeckPicker.js\":\"d5a51605e12cf621\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewControls.js\":\"c82e5f5f3322aabb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewDeckRenderer.js\":\"da3694c3f9bbbb8c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewSession.js\":\"f6ebc2b9e2e162f3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/actions.js\":\"e5181a6c7284bed9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/archive.js\":\"0e166212e0a2764d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dataExtension.js\":\"ad28b3bda3155c22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/deck.js\":\"666aa5cbc4badfb1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dueQuery.js\":\"225d00e0e917d7e6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/gradeDecision.js\":\"07ba792621ad9a15\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/index.js\":\"e59863025fd3ebf8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/keyHints.js\":\"994952a7681590d9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewCardLayout.js\":\"7808775bd9cc962c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewProgress.js\":\"6c14ca45baec9db2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/schema.js\":\"53a28bf9888288cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/useDueCards.js\":\"3103a626293d0fed\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/index.js\":\"0270d51b19a8ddcf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/record.js\":\"b405216f451814c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/index.js\":\"242202897b255392\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/persistenceStatus.js\":\"5fa36bd00263e9d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/requestAction.js\":\"2c71242bd24ca537\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/TypeChipsDecorator.js\":\"47eea5168469db1c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/codeMirrorExtensions.js\":\"350a0da5f2de44e0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/index.js\":\"6b5d8fd3b8d7f33d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/typeAutocomplete.js\":\"ce4b1a2da76a8395\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"46f2ef833d817517\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/actions.js\":\"f06f0526302c15dd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/anchor.js\":\"0ce2f7cc9066ac09\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/events.js\":\"3132ffbb4a68dbef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/gestureActions.js\":\"7bc5ab7e62992fcf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/index.js\":\"47d80f4882866e7f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9739970825a75c34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/collect.js\":\"7798bef693709d3f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/index.js\":\"6eb9e63245a37fc5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/record.js\":\"75a12533110e0b86\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/RejectionDialog.js\":\"9bb824daff0ef9bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1181b2fffacf63a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/index.js\":\"70a0239a17b93f5f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/model.js\":\"f4c83382cae67c8c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/queueCounts.js\":\"9b090da3b4479d62\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rejectedHelpers.js\":\"5b9d48c6aef9bbac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rematerializeAction.js\":\"8903bb4aa837a2aa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/useHysteresis.js\":\"9d1d2d6e0c2176a1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/ColumnHeaders.js\":\"4b2411381ee40337\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/QueryUi.js\":\"c443f3d837e53de2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/TableLayout.js\":\"127c761fd4949dce\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/actions.js\":\"7a89a3104e2c875d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/cellEdits.js\":\"e70dc43bc609362a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/childrenViews.js\":\"7114708099920261\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/columns.js\":\"99bfa17adf18f132\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/controller.js\":\"05cbecba5106ba21\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/convert.js\":\"05997bdb7ac66087\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/dataExtension.js\":\"54ece04ae1dffac2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/index.js\":\"8d66102f9fa50bdc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/keys.js\":\"81394dfefe9ed6ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/model.js\":\"3eb4a240e541b5f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/backfill.js\":\"1e2b65f7412bde8c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/completion.js\":\"8c92452b716d9bc4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/format.js\":\"43ad2ea607fd7298\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/parse.js\":\"a5d490a03ac37818\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/queryValue.js\":\"d5a8e0c5a3e35f59\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/source.js\":\"9c5bbf79b53e7b45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/registry.js\":\"1d5f1d1b743b6344\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowGutter.js\":\"590f4305dd801867\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowVerbs.js\":\"d1ece7854791af68\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/schema.js\":\"19cae486da8c558e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/sort.js\":\"528c54b3d9eda788\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/effect.js\":\"06278e9b93e1518d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/index.js\":\"2a299226acd7b146\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/theme.js\":\"74e3e5127ea2ef23\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/actions.js\":\"73b38d05c9525d9b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/dataExtension.js\":\"ac966b9b535cbfcd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/index.js\":\"74e4189607909ba8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/schema.js\":\"28b80420dab57684\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/TouchSelectionLayer.js\":\"40e5f435be0f1c34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/actions.js\":\"1c869ece92285a9a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/defaultItems.js\":\"2e1ce53fc1efabd5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/facet.js\":\"21218aba785eb7c3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/holdRecognizer.js\":\"f2756ce46550e4d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/index.js\":\"a5af98287cf3fa6e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/UpdateIndicator.js\":\"497db1460c4fe9fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/index.js\":\"29f968ee92a13e95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/loadTimes.js\":\"f527e1e78e4e9aa1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoNotesRenderer.js\":\"10f4b3d0b6653094\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoPlayerRenderer.js\":\"be3457ef5f33f98a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoTimeStamp.js\":\"3ee7cc0c53dfdd47\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/actions.js\":\"bd1d34ae4132b575\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/index.js\":\"748914b352f2f5b2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/markdown.js\":\"7cb99a00762aa033\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/notes.js\":\"ffd1fa3edad50515\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/registry.js\":\"9e8cd97849e07c26\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/remark-timestamps.js\":\"f34849f15b58e7d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/view.js\":\"02a1138ae116407e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/LinkHints.js\":\"430858eb7ea2f794\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/index.js\":\"cba11194c8add52c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/model.js\":\"b5403d7d59341e1f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/settings.js\":\"076b6f4401c0c204\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/actions.js\":\"007bd8f2f36c1113\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/index.js\":\"cc8b01522d65f7d6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/interactions.js\":\"15cb35b3da160193\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/workspace-header/index.js\":\"0cfe17f9f07b8013\",\"/knowledge-medium/pr-preview/pr-1871/src/registerServiceWorker.js\":\"c81375f1d75bff31\",\"/knowledge-medium/pr-preview/pr-1871/src/requestPersistentStorage.js\":\"3ca202c276b78f51\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authRequestDeadline.js\":\"f5e92c91e54f018b\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authStorage.js\":\"b0067739c31cf2f1\",\"/knowledge-medium/pr-preview/pr-1871/src/services/powersync.js\":\"2b151cd7b9536061\",\"/knowledge-medium/pr-preview/pr-1871/src/services/supabase.js\":\"1dfd70bbd8244d12\",\"/knowledge-medium/pr-preview/pr-1871/src/services/uploadErrorClassifier.js\":\"62c17c41e4d0c342\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/ActiveContexts.js\":\"0e51d1ea61403bcd\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/HotkeyReconciler.js\":\"de5274ad19d1da8b\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/WipeLocalDataDialog.js\":\"da546714eb164f50\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionDispatch.js\":\"610b244e8aa59663\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionRefItems.js\":\"d4e70f3f7d6678ea\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/applyKeybindingOverrides.js\":\"00e163437735e91e\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockActions.js\":\"90af1ca0d5654354\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockMergeGesture.js\":\"042d7cd1380fa211\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/canonicalizeChord.js\":\"60d54c40a39982f2\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultContexts.js\":\"07cd4d77044a5424\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultShortcuts.js\":\"591cbbead5a3bdc9\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/effectiveActions.js\":\"7cb1f9bef02a2729\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureAction.js\":\"a71c2758153b0e7c\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureBinding.js\":\"d64ed76dff2b4117\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/holdRegistry.js\":\"c100ad479b300317\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingConflicts.js\":\"a9a91c01b986a9c6\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingOverrides.js\":\"c03c38ec3edeac08\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/pointerAction.js\":\"d021b232381a7bf6\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/resolve.js\":\"23784dcf1da3ca45\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/runAction.js\":\"e212c98df8d5834f\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/sequenceMatcher.js\":\"4e6c08b3ed3d67d6\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/types.js\":\"2e8fc37bd8a337ed\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionContext.js\":\"aa7405bc94d4520c\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionDiscovery.js\":\"1c1982d2898ed99a\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/utils.js\":\"d30392b07ee837bf\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/bootStore.js\":\"625f56d550ebd347\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/previewDatabases.js\":\"0ae7f9e16d90c41c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/byteTransform.js\":\"89b8da9fbe1199d6\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/attachmentCleaner.js\":\"27a9efcb8b670c1a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/attachmentParts.js\":\"ad9071756887cd3a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleParts.js\":\"74c51330233996fd\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleRecord.js\":\"19fc7e2a836e7cf6\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/manifest.js\":\"95633636330bcf8f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/takeBundle.js\":\"0eb44a0da74a839d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/verifyBundle.js\":\"d4186a1cf4f18d5b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/cleaningStage.js\":\"0667e0ba0099793b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionKey.js\":\"75375beab76a2b34\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionServer.js\":\"9f6c485c248a1fb0\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flip.js\":\"3c8c837a934c56fe\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flipAttempts.js\":\"91edf3f5cb7850ce\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/pages.js\":\"f67d6c32b8e39c78\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/preflight.js\":\"bd6858f56b0ebfc1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/reseal.js\":\"d6acf945bdd745ee\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runConversion.js\":\"fc95643b91f7df1c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runLock.js\":\"081477d612c06c6d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealing.js\":\"64c24b84b4482918\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealingStage.js\":\"ff2596761a5cbff9\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/stage.js\":\"11b17b522a7e968a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/verifyReseal.js\":\"6a1ff37cfbc3be4b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aad.js\":\"2f2b202cd7cb1cc7\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aead.js\":\"ba767f06aab31817\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base32.js\":\"0b0e9615096fcc38\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base64url.js\":\"d3ec8c8aa852085a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/binaryEnvelope.js\":\"8af94a10edefcb9e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/byteAead.js\":\"e7bf5ef045ee4488\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/canary.js\":\"0b815f80f2cc7238\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentHash.js\":\"999ce52a42825434\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentKey.js\":\"02d269707af8996c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/derivedIdNamespace.js\":\"ef0941aff47fdd3f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/envelope.js\":\"6dd2a8d197487f18\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/hex.js\":\"4a7d773266ad2443\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/sha256Hex.js\":\"5ab532c8ee56af43\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/workspaceKey.js\":\"324465460730e830\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/conversionState.js\":\"7655e8a38dde1c39\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6065e881b444b73c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/pastedKey.js\":\"9c471098ed013822\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5d442c42956a6382\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5ef3763d72775d71\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/keyStore.js\":\"dacc573b50b74cd2\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/mintWorkspaceKey.js\":\"f8c8f2818753b81e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/modePin.js\":\"de972f1d9bac45ef\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/openWorkspaceKeys.js\":\"18b8234ba48127a1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolveWorkspaceEntry.js\":\"f3df94ef4ba1ac44\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolver.js\":\"213cff3a727f4a3b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/workspaceAccess.js\":\"1c900ade8ba6f918\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/transform.js\":\"fe798c34e0d1ae58\",\"/knowledge-medium/pr-preview/pr-1871/src/themeBootDefaults.js\":\"6a4cee97bd2502a4\",\"/knowledge-medium/pr-preview/pr-1871/src/types.js\":\"c8ba8cbfbe9b5e69\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/ClientLocalSettings.js\":\"5aae00b5a71636c0\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/abortableSleep.js\":\"8f7314a95edb952e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/array.js\":\"b2f40af99b0cee16\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/backlinkAutocomplete.js\":\"e872f7822bfc7a49\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockCrumbs.js\":\"c44b909df67d796c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockrefAutocomplete.js\":\"c9c1499be2923b4f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/cadencedIdleJob.js\":\"3b18a5e788c1d1dd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/callbackSet.js\":\"791aa51b0f7b8455\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/clientId.js\":\"5b808556a2feda22\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirror.js\":\"68b2ea4fc8e99caf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirrorCompletion.js\":\"17be4b0694a1ccc4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/copy.js\":\"d829cc75a4739ccb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dailyPage.js\":\"32006e504cef19fb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensics.js\":\"95d2932e4c0467b1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensicsHooks.js\":\"53c31e8d62f0fb63\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/deleteBlockThroughUi.js\":\"68bba57fe542d093\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dialogs.js\":\"d57668267d045f24\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dom.js\":\"87648860fa2b0bdf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/downloadBlob.js\":\"8350fbb67905b908\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/drawnWalk.js\":\"7674159392faefa1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/exportSqliteDb.js\":\"852daab2fd8edf2b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fileSystemAccess.js\":\"82339965e10d7bd5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/flipSlide.js\":\"7c623f339b037589\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fnv1a.js\":\"dba6cf39da0e082e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/formatBytes.js\":\"8d39361d6fa1296a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fuzzyRank.js\":\"e8879f13be73c9ab\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idbKeyedStore.js\":\"c7e8eebdee8ba8af\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idleCallbackPolyfill.js\":\"7b75f98e884db57e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardAwareScroll.js\":\"e58dfd1ea2d40f8b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardViewport.js\":\"a7b40bacc9c1c7ab\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/lastWorkspace.js\":\"b5191ca022fcfd65\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutColumns.js\":\"3e4020c25b283e7f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionDom.js\":\"97756a2d93166f9f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionId.js\":\"7cafe80925781d37\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkClickGestures.js\":\"1e11953c16e52abf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkTargetAutocomplete.js\":\"57b4bbea1d5dde71\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbCorruption.js\":\"002a66b0b59ac7e4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbRecovery.js\":\"60c6c7bf65cfbef7\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/markdownParser.js\":\"97f75c1622967d58\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/memoize.js\":\"2ab265242c9c97f8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameFieldCommit.js\":\"1e7db27fc461bf95\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameList.js\":\"364e8454d6256773\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/navigation.js\":\"b558b6627fe5326d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/omnilinerNamespace.js\":\"4b54614c9d835727\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/opfsPageScan.js\":\"146814d3ed66c4a6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelClearance.js\":\"ba6f0b3b82db5072\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelHistory.js\":\"a08d8ac12f1a78c4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLanes.js\":\"6f340149470bc896\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLayoutProjection.js\":\"f3e20e021dd69a05\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelScrollAnchor.js\":\"9db3faf97ab597c5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelUrlFlags.js\":\"d14025956d887cf4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/platform.js\":\"100337b37a6af74b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/pluralize.js\":\"c9bee44616da01d1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyCreation.js\":\"25db614d9c3f05f1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyNavigation.js\":\"6f4941d31dcf0114\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyValueContext.js\":\"31b770169e64a8a9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/react.js\":\"45c0b169a2fe0bb3\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeDate.js\":\"0331bd74f5754f5f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeTime.js\":\"7a1fb342a7648dbc\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/renderScope.js\":\"466d5a6c5d126713\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/resolvedThenable.js\":\"3db30e1fa95df006\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/routing.js\":\"aac145640c46da5f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/safeMode.js\":\"7b531ae26bf34e94\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/scheduleIdle.js\":\"00b576604edc3503\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/screenWakeLock.js\":\"0311341baf563100\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/selection.js\":\"35183b92675835b1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/softKeyboardGrab.js\":\"44167df5dcb2af2a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/startupTimeline.js\":\"8d053cd49661294f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/state.js\":\"3f20aa572b7a74c0\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/string.js\":\"3d0a75f2d17cf80f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/surfaceZoom.js\":\"e4926e6ef142eb4e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/time.js\":\"20be947c0b82dabf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toast.js\":\"54c714d969ed597c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toggleStore.js\":\"639b83025c0cc28b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/untilStopped.js\":\"2457652b0b796521\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/userActivity.js\":\"d3d459ddca785a83\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewTransition.js\":\"543fe8ab5443cfc7\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewport.js\":\"f3f37831a8f57d2f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/webLock.js\":\"701bb9bf4271801a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceRecovery.js\":\"8fd5cf32dd85c3dd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceSnapshotStore.js\":\"550d097c977ac884\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-compiler-runtime.js\":\"a1386f5ed364cca8\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-client.js\":\"4491b903db168dee\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server-edge.js\":\"e902bf554882977b\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server.js\":\"4fee046faa7c0905\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static-edge.js\":\"f8c460ff93e1842a\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static.js\":\"872603d7555283d3\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-test-utils.js\":\"f547d69d2b8dc7be\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom.js\":\"bca99fcb455c4041\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-runtime.js\":\"7975a686ba319a2d\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react.js\":\"28c1aff6f4c4b2a5\",\"/knowledge-medium/pr-preview/pr-1871/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
