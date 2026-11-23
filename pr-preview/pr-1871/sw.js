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
		buildId: "042b171ad475-fa7ca063",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/\":\"aa24ee70b6a8ed29\",\"/knowledge-medium/pr-preview/pr-1871/index.html\":\"aa24ee70b6a8ed29\",\"/knowledge-medium/pr-preview/pr-1871/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1871/assets/FacadeVFS-5-Rp_pVQ.js\":\"f53bdf1ce146c6c8\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSCoopSyncVFS-B83hK4f3.js\":\"2c426a8314537c3a\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSWriteAheadVFS-CzKeCFKl.js\":\"5e5fb96846c41f54\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-BBsewdBI.js\":\"28add0a885c8a072\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-De1cUen-.js\":\"fa7a324e3160c659\",\"/knowledge-medium/pr-preview/pr-1871/assets/worker-COJ-N9bu.js\":\"790a91f589ff8639\",\"/knowledge-medium/pr-preview/pr-1871/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1871/chunks/app-D2ZBbwx9.js\":\"53a569ee5668cc94\",\"/knowledge-medium/pr-preview/pr-1871/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1871/index.js\":\"3111568fb97db0cb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1871/assets/AccessHandlePoolVFS-BYuHB7sq.js\":\"72973f7422af2382\",\"/knowledge-medium/pr-preview/pr-1871/assets/IDBBatchAtomicVFS-Ds943PgS.js\":\"7f92d120076c07f1\",\"/knowledge-medium/pr-preview/pr-1871/assets/MemoryVFS-CO5l7-I2.js\":\"248838b44ab2f0ea\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-CU-A7mYV.js\":\"4716fd8b6dfea46e\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-CVdZB38t.js\":\"0c70278555fb30cb\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1871/chunks/AccessHandlePoolVFS-Bn7XQwCK.js\":\"d5b47d8a46f4ed30\",\"/knowledge-medium/pr-preview/pr-1871/chunks/FacadeVFS-BHtGAab8.js\":\"ea5d12ad4b323cac\",\"/knowledge-medium/pr-preview/pr-1871/chunks/IDBBatchAtomicVFS-BQCzVjgT.js\":\"7f96b71756149b40\",\"/knowledge-medium/pr-preview/pr-1871/chunks/MemoryVFS-Dp6OPvSV.js\":\"f92d8c72bef21b20\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSCoopSyncVFS-Bn3VQIBX.js\":\"106bcbf4c94e731b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSWriteAheadVFS-CUITWbPp.js\":\"00969a999d9db580\",\"/knowledge-medium/pr-preview/pr-1871/chunks/Preview-CTaQ34Dp.js\":\"a004c65daf30a5da\",\"/knowledge-medium/pr-preview/pr-1871/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/card-BVzYedwp.js\":\"da19fb7a3e1d44bd\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-BESrIhJQ.js\":\"eadafdb225cc9c0b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1871/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-CvTZkBC2.js\":\"d6ebcaa7e42d86b0\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-async-Cj4H6ekn.js\":\"6acbf23af4f49988\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-BMQZhcz-.js\":\"4948baeaddeff9d7\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-C6dzgPdV.js\":\"9b21f83d91947ac1\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-CgZh_5fE.js\":\"0c48ea0f2fdaacf8\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-ChbqBIYk.js\":\"cb28e20a1f787fd8\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-DYi-U4Pp.js\":\"ae51d16530befddc\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-Ey0DVECo.js\":\"3c257051f2b32873\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-RaZWGVyj.js\":\"8774e31b78861957\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-bYxNPzUI.js\":\"56d4359589d29a4a\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server-legacy.browser.production-D-L5536k.js\":\"baa0743d17699e7d\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.browser.production-CnanA1wG.js\":\"4a723242d518cf80\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.edge.production-DEbZ3CG7.js\":\"c7707106c2c603ab\",\"/knowledge-medium/pr-preview/pr-1871/chunks/server.browser-C7WIYMwP.js\":\"09f73a15934a75be\",\"/knowledge-medium/pr-preview/pr-1871/chunks/textarea-ZUfLEbNO.js\":\"bd6213cf77bbe4da\",\"/knowledge-medium/pr-preview/pr-1871/chunks/ui-CWbVTuDv.js\":\"fe69dfcc99ee38dd\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-CgBhpLTs.js\":\"ef6b03adbe20b8b1\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-async-CyAgKzcU.js\":\"12e2e079e00ddf1b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1871/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/src/App.js\":\"b7b8efcc7fae8168\",\"/knowledge-medium/pr-preview/pr-1871/src/appUpdate.js\":\"c6f7225336e679e6\",\"/knowledge-medium/pr-preview/pr-1871/src/appVersion.js\":\"b10d9f1ce1bde9b3\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/initialLayout.js\":\"f006b5f94e121495\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/openWorkspaceData.js\":\"87a4854dd39a884d\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/resolveWorkspace.js\":\"43c9d504263885a9\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/workspaceBootstrap.js\":\"1574c64d70bbcbd3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockComponent.js\":\"a63e3b4c1e283c5c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockCrumbs.js\":\"8baeb193e43aa7ee\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockEditor.js\":\"dce25a20b160abbf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockLoadingPlaceholder.js\":\"859dfa68e61e9ef6\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockProperties.js\":\"d1cbc76b5a2ceec0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockSearchPicker.js\":\"0794f72507215571\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ConfirmBulkDeleteDialog.js\":\"18590e9cd65a3131\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DividerHandle.js\":\"80075ce921128732\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DraftEditor.js\":\"54f86eee90c27316\",\"/knowledge-medium/pr-preview/pr-1871/src/components/GutterPill.js\":\"0dba5ed4417632cf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Header.js\":\"485ac050155a797f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/LazyBlockComponent.js\":\"9157de26ec0cf296\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Login.js\":\"8e1058d38c70679d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ZoomableSurface.js\":\"64a4db9accc5214a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/editModeKeepalive.js\":\"01fb0f63e1afba7d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyDisplay/PropertyDisplayScope.js\":\"99127bfd59693148\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"644128f8720d830c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefPropertyEditor.js\":\"a1f748d33630f170\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefTargetTypePicker.js\":\"fb8b9135818e853d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/SelectPropertyEditor.js\":\"a4587aa20937faf4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/TypesPropertyEditor.js\":\"42580c99da355116\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/defaults.js\":\"350c85895acb0648\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/kernelValuePresets.js\":\"8945e3774e05c76f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/selectablePresets.js\":\"307394cf3e103c7d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/typesPropertyUi.js\":\"90f210e1356e7dd1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/AddPropertyForm.js\":\"305dbf9569551e6c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyPicker.js\":\"f01fc8eee1a19d83\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyRow.js\":\"80374317914ef12a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/Rows.js\":\"12d5aa2747c4d352\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/actions.js\":\"33a2c971cbb81cb2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/declarationOnly.js\":\"6a6a3cbf2c61afc1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/layout.js\":\"df659f3a03920dbf\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/model.js\":\"b8c9f2cb218c9c8e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapeUi.js\":\"4989f1eed55dc6e2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapes.js\":\"f2567ff8acd7be74\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/usePropertyEditingActivation.js\":\"50de1fe847d3b252\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/visibility.js\":\"d73daf0a8d2a56f1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanelSections.js\":\"47712a3998299b21\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockEmbed.js\":\"a66b2a9d7ab65fc7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockLink.js\":\"623bd23932e6af4f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockRef.js\":\"c516dccbeaa83c45\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/ReferenceLink.js\":\"1411af0bbb0bc6a2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuard.js\":\"96ff3ac6c93ef20d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuardContext.js\":\"1e3d6d90e0673f38\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/linkInteraction.js\":\"9258a57027692b4e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/referenceLayout.js\":\"36ef12fa749ec909\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/useBlockRefAncestors.js\":\"42a421e9e8870300\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockGutter.js\":\"bc7ce05b9b88f9cc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockInfoDialog.js\":\"240adc03f3650d19\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockTypeBlockRenderer.js\":\"65ab43607e14dd5d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BulletHoverCard.js\":\"eb41c6e0162621e4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorContentRenderer.js\":\"e4d5df900d5830b8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9c4598413e54aa39\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ColumnResizeHandles.js\":\"3a02e77dc1760c7f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1d22364d4a08afef\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/DefaultBlockRenderer.js\":\"95c7f83485889b5d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/LayoutRenderer.js\":\"7a6db707dd7c12ba\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MarkdownContentRenderer.js\":\"087b9a9fc5911888\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MissingDataRenderer.js\":\"447a59180d1550d1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PanelRenderer.js\":\"520839468f10170f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PropertySchemaBlockRenderer.js\":\"78ebe2c980889d46\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/TopLevelRenderer.js\":\"640d50268b8fa80d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockGutterMode.js\":\"3f90219a82aa0dfe\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockTitleText.js\":\"651484cdc9bd9659\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/fieldCreationKeydown.js\":\"ecdb8670b2d135f8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/layoutRootContext.js\":\"3276ef63a8cbae5f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/TypeChip.js\":\"41b24c3b6e6e0d6f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/chipStyle.js\":\"fb6fa11676d952b9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/anchored-floating.js\":\"6a975cc5f893abbd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/button.js\":\"f87c6db6f6a04fed\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/card.js\":\"b7cc86982fcaf290\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/checkbox.js\":\"a059f4771391daf3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/collapsible.js\":\"a3954e0b3bdcd854\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/command.js\":\"5e34f743c555be1e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/context-menu.js\":\"626e279b21842f49\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dialog.js\":\"4396faaea4a33858\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dropdown-menu.js\":\"dfa74eda98b33988\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/floating-listbox.js\":\"7da4749ce8f43fb2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/index.js\":\"e52cdff77e7e5a21\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/input.js\":\"a7ba86ab1e411a4d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/kbd.js\":\"45c1603bee25d5b7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/label.js\":\"7192eb5416bc12af\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/textarea.js\":\"cc085460a9332c72\",\"/knowledge-medium/pr-preview/pr-1871/src/components/useEditModeYieldKeepalive.js\":\"ba711cf8db9a7f4c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/BootFallback.js\":\"f5a8e5f0761bbaa0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/FocusedRowLazyMount.js\":\"d79bc9777329108f\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LazyViewportMount.js\":\"67bf9895911ee8e8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LocalDbCorruptionFallback.js\":\"68683cc37f54d8cd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/error.js\":\"94a08c29eed2383d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/lazyMountRegistry.js\":\"2caa3f6b7a4678d1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/suspense.js\":\"493f2f06c7eb8bb3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/CreateWorkspaceDialog.js\":\"1bef82c472911927\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/PendingInvitations.js\":\"3661b7e4b7e6e80d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/SyncProgress.js\":\"0d22795f9b70335c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/UnlockProgress.js\":\"bee8af31e2ef58c8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceKeyGate.js\":\"733c4af56c972ef0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSettingsDialog.js\":\"3662fb8549a35d8e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSwitcher.js\":\"787222c7d46315c1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSyncGate.js\":\"afadd9e9425fd8ad\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlow.js\":\"d0f311e7fc20b765\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlowHost.js\":\"3f3622f0521af0fa\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/EncryptionSection.js\":\"ecf56f4a6ed3098d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/attachmentPrompts.js\":\"fdc6032bed44a24a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0d4a1b6d6442db85\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowDeps.js\":\"49a6234539ff1bdc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowStore.js\":\"c8736e317224bf50\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/flowUi.js\":\"45449f708ccd361b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/useConversionRun.js\":\"2ff24d2fbd61b4ff\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/keyUi.js\":\"5ba64cbe31a5103e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnKeyLoss.js\":\"c76540b36c90c384\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnServerE2ee.js\":\"dd876d55c2d82c77\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/workspaceUnlocked.js\":\"da5ca2a45760f0e2\",\"/knowledge-medium/pr-preview/pr-1871/src/context/backgroundSubtree.js\":\"c51a6bc6d9208378\",\"/knowledge-medium/pr-preview/pr-1871/src/context/block.js\":\"aa74bd5a8a0f287c\",\"/knowledge-medium/pr-preview/pr-1871/src/context/layoutWsContext.js\":\"006eaa7ff3721788\",\"/knowledge-medium/pr-preview/pr-1871/src/context/propertyDisplay.js\":\"ebbf7dc996978a75\",\"/knowledge-medium/pr-preview/pr-1871/src/context/repo.js\":\"2743f1dcd6fd5ca1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasClaim.js\":\"a5b2da1db2d72db0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasSeatNamespace.js\":\"83fe25f856f55951\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockData.js\":\"1436eb8176107bef\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockType.js\":\"6f4b8ac42dc45983\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/changeScope.js\":\"4549d3ad6d62aaf8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/codecs.js\":\"acda225faaab7500\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/derivedData.js\":\"01c1b6ea8f6497bc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/errors.js\":\"52178e2bb1cfd39c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/events.js\":\"f34c061023a0d8cd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/handle.js\":\"8e9e1eddd01d7756\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/index.js\":\"bcd3139f71f60428\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/mutator.js\":\"21c909cd461b235c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/processor.js\":\"f9482820d8293588\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/propertySchema.js\":\"f2d51c9c6902d5c3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/query.js\":\"d00b87c8047cea82\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/sameTxProcessor.js\":\"3e392495a6499d8e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/schema.js\":\"8e9e1eddd01d7756\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/tx.js\":\"8e9e1eddd01d7756\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/typedBlockQuery.js\":\"5358324a2e333196\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/user.js\":\"9a746f9504da8283\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresetCore.js\":\"d465ce13b9f9e224\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresets.js\":\"7cd90ce1f086986e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/attachmentCleanerIOVerb.js\":\"215a0b2f65ad6c1b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/block.js\":\"7d14ab09b4b3200a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockCache.js\":\"3984b7314e01a77b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockId.js\":\"7db5b4a59eceb61d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockLiveness.js\":\"384cfbc2a557a59f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockMerge.js\":\"85b8b359f3673639\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockSchema.js\":\"1a6699b3d40c8e24\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypeLookup.js\":\"be3180b3afd56e53\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypes.js\":\"80501e6d22df8346\",\"/knowledge-medium/pr-preview/pr-1871/src/data/childrenView.js\":\"2fed55b9abf4a571\",\"/knowledge-medium/pr-preview/pr-1871/src/data/clientContext.js\":\"d2bd2c96881f77ae\",\"/knowledge-medium/pr-preview/pr-1871/src/data/dbFileSiblings.js\":\"9fadb621f360a78e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/definitionSeeds.js\":\"8b5b6824880e4b28\",\"/knowledge-medium/pr-preview/pr-1871/src/data/derivedIds.js\":\"4565cb21b471c61d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/drawnSubtree.js\":\"8137858a51087f46\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facetBridge.js\":\"c85f9d441d08da4e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facets.js\":\"3a59eb8d5fd9ada2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/globalState.js\":\"d950a871549dfadc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/aliasClaimRederiveProcessor.js\":\"e24367a7d6d95af8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/ancestorBatch.js\":\"74048fabd2d52f88\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/blockTypeTypeifyProcessor.js\":\"40c8d232a36365a9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/clientSchema.js\":\"65ed31f93b006799\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/commitPipeline.js\":\"077c062b9353846c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/devAssertions.js\":\"9eba08da5f2e55ed\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/firstSync.js\":\"3aba0a5ad2aa1b93\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/freshInitialLoad.js\":\"0a1f278ad76379b0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/graphBackfillClaim.js\":\"241b2d726024aae7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/handleStore.js\":\"8bc05bbb936a7dc5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/idleMarkerJobs.js\":\"339ae34da8907c04\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initialDownload.js\":\"a75f718867fe6a76\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initializeClientDatabase.js\":\"ed36791009da0425\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/jsonCanonical.js\":\"95e370442e606d0e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelInvalidation.js\":\"cb16986e0c33e53a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelProcessors.js\":\"2ffcca1c10227dce\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelQueries.js\":\"4593f584d45c388d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/mergeTypeMembershipProcessor.js\":\"3d7e2f9e08beecef\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/normalizeReferencesProcessor.js\":\"ef49bd2f53858f10\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/poolInstrumentation.js\":\"111ecafd75cb94c4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/processorRunner.js\":\"ac00d9c2a54ce054\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyCellBackfill.js\":\"00b7f8d9b19b4c01\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildMint.js\":\"e838a8695a65d8f3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildrenProcessor.js\":\"db864a2a4fe8cc5b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c9db84f6a08e907e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionSynthesis.js\":\"1d3fa44d34f68c14\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyKeyScan.js\":\"7f94eae43a6c253e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertySchemaResolution.js\":\"c53f1e070fcd66ff\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyValueEdits.js\":\"86ba16b213f83852\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/raiseProtocol.js\":\"4f37e8f105cb7e53\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/readBatch.js\":\"7e01e1fc6cc13b46\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/refProjection.js\":\"45406d41b6e8444f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetLookups.js\":\"bd17443e554dc56f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetProcessor.js\":\"ccbcf9dae5319a96\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/replayMerge.js\":\"a489aa4b8fa91c8a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/sqlBinds.js\":\"e20792f8fa37381d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"158cc5a2940a4ecf\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/arrivalProcessors.js\":\"66482ccbc451376e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/invalidate.js\":\"1ac3bc18b69b160a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/materialize.js\":\"29491c635d100717\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/observer.js\":\"3e10894b5fa24b2c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/reconcile.js\":\"a8d1b28340f852bc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/timingMetrics.js\":\"93a1a2e04f5b0566\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/treeQueries.js\":\"09adcb2b621426c4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txEngine.js\":\"64543cbbffee6219\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txSnapshots.js\":\"d47ac5ece98a2903\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/typedBlockQuery.js\":\"8d2e49da3427b0cd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/undoManager.js\":\"de7a5d879299d3a2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/invalidation.js\":\"d146fc0ad75d1aa7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelDataExtension.js\":\"9536c81ea875c240\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelPage.js\":\"c649331d0a70f050\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelValuePresetCores.js\":\"8299d4e8f32c6d7d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbCorruptionSignal.js\":\"93a8ffd5d01dfab1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbStorage.js\":\"89a20ffe4b5808f6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbVfs.js\":\"93d523981ef8dbcc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localSchema.js\":\"974a8ab5c9703650\",\"/knowledge-medium/pr-preview/pr-1871/src/data/maintenance.js\":\"f6f0f2d9e11ac0a4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mergeProperties.js\":\"76dd2a491ced4b56\",\"/knowledge-medium/pr-preview/pr-1871/src/data/metricsConsoleHook.js\":\"1736017a9b4a0841\",\"/knowledge-medium/pr-preview/pr-1871/src/data/migrationsPage.js\":\"7fa7c1b214725f0b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mutators.js\":\"1ee455002da61605\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKey.js\":\"6ad63b550065a265\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKeyPlacement.js\":\"0441df8df42b851b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/outlineSurface.js\":\"480930f6d11b0caa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingEditorContent.js\":\"b6c8ff21b81aaef0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingUploadsSql.js\":\"85c1d6ae92c8d410\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pluginStateExtensions.js\":\"31b090f230f7d35a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/powerSyncLogger.js\":\"7dc439e75f0607db\",\"/knowledge-medium/pr-preview/pr-1871/src/data/projectorRuntime.js\":\"3b5fcff07734bcc9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/properties.js\":\"2917ade3d6b3e861\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertiesPage.js\":\"6ec9d5c9889584c7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyChildren.js\":\"b72ca2bd23f1bd44\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionFanout.js\":\"0aaf035053d3eb59\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionMetadata.js\":\"baaee763d8da2a1f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionRegistry.js\":\"7a1eeb3af43f1b08\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDisplayMode.js\":\"68b7cb92d9545913\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyRowCreation.js\":\"0b4e5bcb907d5021\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySchemaCreation.js\":\"9fa6b34636061a4f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySeeds.js\":\"e45eb6f2d2be5b34\",\"/knowledge-medium/pr-preview/pr-1871/src/data/recentsPage.js\":\"b4c86a07ca164ffe\",\"/knowledge-medium/pr-preview/pr-1871/src/data/referenceBlock.js\":\"66d696ebaa86e2be\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rejectedUploads.js\":\"4e255cbbbb48d7bd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/releasePowerSyncConnection.js\":\"04e96261badec850\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repo.js\":\"aab17db0d16faaf0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repoProvider.js\":\"5cd06cbc27ee542e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rowProperty.js\":\"c7ece8f2ddcc96ac\",\"/knowledge-medium/pr-preview/pr-1871/src/data/searchFilter.js\":\"beaa24afa6dcc06d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/seedIdentityLedger.js\":\"2337edb7b3136e68\",\"/knowledge-medium/pr-preview/pr-1871/src/data/stateBlocks.js\":\"d4d92a348d51cbd0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralEditPolicy.js\":\"8badfe297232857c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralInsert.js\":\"e85a12e0194e7ec5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/subtreeDelete.js\":\"eed00314134f62e5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncStreamLock.js\":\"985484b8303b6ffa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableSqlRecognizer.js\":\"ba72cc446bb1a093\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableWriteGuard.js\":\"e3c30d3ac215c2e1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/targets.js\":\"3de0f783bf45d84e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeColors.js\":\"513743ffa381e282\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionMetadata.js\":\"6e2e5c95765c19fc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionRegistry.js\":\"a0d37730a4d50fa9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeExtraction.js\":\"dc8dba896392f2ea\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeInitialValues.js\":\"df754000f947baad\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typePropertyGroups.js\":\"dda0c7eef1ced21d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeSeeds.js\":\"d3a1449c2ea1e856\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeTagger.js\":\"b643bd2ce7f78bf9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typedRecords.js\":\"b0398caac88ddbc6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typesPage.js\":\"daeac7b34546886d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userPrefs.js\":\"b432be216b50dc24\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userSchemasService.js\":\"30abdadf1d0cf324\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userTypesService.js\":\"e7bc613ba3141767\",\"/knowledge-medium/pr-preview/pr-1871/src/data/valuePresetRegistry.js\":\"9de068ba462e4a0b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/visibleChildren.js\":\"6cfadb0b6686cb73\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceConversion.js\":\"9da3a5903463d326\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceFirstSync.js\":\"5bf6227a90269dfd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceIdNamespace.js\":\"9a953d5a8256bf37\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceSchema.js\":\"723ae5f15bab0c8b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaces.js\":\"c3321fb9fc0e1b0f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadLog.js\":\"3a9013caded46c34\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/BlockPasteShellDecorator.js\":\"a7fdf2c6f86b0958\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/atTrigger.js\":\"c97cf3862d563fd7\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/autocomplete.js\":\"e5522713d8b31920\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/codeMirrorExtensions.js\":\"12b612cc690c0156\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/contentFlush.js\":\"9bca4108b6666e83\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/defaultInteractions.js\":\"64b6d20248600d33\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/editSettleSignal.js\":\"cd2a6e44ff68114a\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/insertImage.js\":\"352e77b903988641\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceCompletionRange.js\":\"6da51d6b6b774076\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceTargetTypes.js\":\"67500315c2cc81a0\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/syntaxContext.js\":\"d5e370610955c8f5\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/triggerMatch.js\":\"8dd5e9afdb9c016f\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/AppRuntimeProvider.js\":\"1f96d6ace8c50880\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/BlockFocusShellDecorator.js\":\"96aa5cc23d9111f2\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/ExtensionRenderBoundary.js\":\"b757345996cab7ac\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/PanelContentRecovery.js\":\"c55059cf633dd3dd\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/apiCatalog.js\":\"323c071c8194dad4\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/approveExtensionHere.js\":\"540626d63440d89a\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/armedCutAppMount.js\":\"5fb539d036548bde\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/batchableKeyedStore.js\":\"0006326c152800dd\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockInteraction.js\":\"61aa5c2adf0c7317\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockSelectionAction.js\":\"0521a3cd4859819b\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compileExtensionModule.js\":\"88e9aa7742c957d8\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compiledModuleCache.js\":\"e44532b5f3046621\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/continuousGestures.js\":\"3970650269f7f070\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/core.js\":\"daad453befe91e3c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/defaultRenderers.js\":\"f270d2ca14c186e6\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/definitionFanoutAppMount.js\":\"37f3018c5ea6139f\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dialogAppMount.js\":\"dcbda20cd4a06376\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensionSeeds.js\":\"a2fd4c2c66e1a9cc\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensions.js\":\"a77a45a83bf8ae25\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/exampleExtensions.js\":\"4eb71a651146ec4a\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionApprovalStatus.js\":\"066e7a013411d4ef\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrorToast.js\":\"b396788caf50b5fe\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrors.js\":\"055f030c0ca4c523\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLookup.js\":\"4fabe1c419632c67\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionToggles.js\":\"6be777b309d3f5e7\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionUtilitiesCss.js\":\"ac76cf048148f9c0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/kernelPageDeletionGuard.js\":\"d42f58f73b3cb8e0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/liveRuntime.js\":\"1c8c7f7d9b287ccf\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/openExtensionsSettings.js\":\"ccc075eb6b2166ef\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/overridesCache.js\":\"5da6d2fe7145c8fa\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/pluginIds.js\":\"bdca99f9503222e9\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/processorRejectionToast.js\":\"4e133673d001cf85\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeActions.js\":\"19847b8e7293a63f\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeContext.js\":\"b8c2ad577547a27b\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticAppExtensions.js\":\"4f8bf57e9d5856d3\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticDataExtensions.js\":\"ea21285884d12295\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/toastAppMount.js\":\"06839822462af113\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useOverrides.js\":\"a7879db4d6df53b0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useShortcutSurfaceActivations.js\":\"f418519d96e01f62\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/discoverToggleTree.js\":\"3045897f4799e572\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/facet.js\":\"68e5afd6ae59bdcf\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/resolveAppRuntime.js\":\"b40b1265f66e9c91\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/runtimeEvents.js\":\"dc26560823a7af2c\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/togglable.js\":\"aa52e12ce2ba7fc0\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/variantFacet.js\":\"a3cc82331cb7e5de\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/verbFacet.js\":\"cc38cd37d5c215f3\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/block.js\":\"d93eca917e1a0fee\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/focusedChild.js\":\"388b987981dae9d5\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/propertySchemas.js\":\"19a3d8b83b12d0b5\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/typeRegistry.js\":\"b8d37c29f8bc5d99\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAncestorCrumbs.js\":\"36bea92b98e95a07\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAutocompleteListbox.js\":\"37c602b53aa43487\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedSearch.js\":\"8009ffe34cffc883\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedValue.js\":\"ee281a4036dae065\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsFocalRender.js\":\"8f41997ed272bcca\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsReadOnly.js\":\"3b1bb7a2d687a7a5\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMaterializeBacklog.js\":\"94d7ea6852006c66\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMinuteClock.js\":\"94148af9c15943e9\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePanelLayoutProjection.js\":\"415a3829a49ac5c8\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePendingInvitations.js\":\"c97c43b2133df389\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRendererRegistry.js\":\"a75221c10109fb70\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRetainedFieldRows.js\":\"3fdef070a5a4185e\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useWorkspaces.js\":\"3e0bea7741c2da4d\",\"/knowledge-medium/pr-preview/pr-1871/src/lib/utils.js\":\"78d1247f79cc6963\",\"/knowledge-medium/pr-preview/pr-1871/src/main.js\":\"dbb50b7cfd01fe85\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/MarkdownImage.js\":\"e21e9c0cc6145aa7\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/blockSeparators.js\":\"5865ae3c6a938422\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/context.js\":\"98f6514a4fc2180c\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/defaultMarkdownExtension.js\":\"f59872e39125f154\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/extensions.js\":\"f2c90061bd68f465\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/renderMarkdownHtml.js\":\"1dcf3f93020d3253\",\"/knowledge-medium/pr-preview/pr-1871/src/minimal-editor.js\":\"7153e4a635648711\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/armedCut.js\":\"5e9605244264a504\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/captureMediaVerb.js\":\"9481298006ace1fe\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/clipboard.js\":\"847e8f11f4ca245b\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/decision.js\":\"0a40e556058400ef\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/operations.js\":\"ac661157fd213f12\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/AccountHeaderItem.js\":\"f1dc44f3823491c4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/index.js\":\"10d59e97b614e0e1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bad555e84b0a6457\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askAgent.js\":\"7cf74198d3e98d18\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askedStore.js\":\"a7539e43857c3ee2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"123dae648be8cdb6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/chipState.js\":\"69fdf25ec7e41779\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/dataExtension.js\":\"96226863877edbc4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/index.js\":\"b8f36bec42fec3fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7c3baf343e665f87\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/schema.js\":\"53dbe91250a8750a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f43b20929557059c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/BridgePairingDialog.js\":\"85c1188fa9b55122\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/addMedia.js\":\"48319ba798e1cd6e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8c12b75e0bec7031\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/block.js\":\"db9878ad1b533fd3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/context.js\":\"7e5289b33b20b203\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e1b37e2e10078ba3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/index.js\":\"2bc58c0c790b42b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/outline.js\":\"99d056c687e22f57\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/properties.js\":\"442a0864d0c3d725\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/refs.js\":\"e2b54daab8c5844a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"de84d9c753b1736a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/search.js\":\"8a1c1c187e83b773\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/shared.js\":\"452b1eb45a4a69db\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"613e65a9b7b05341\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/text.js\":\"9bfe9d9f956c7567\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentWrites.js\":\"93ec2310ffe04963\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/authoringCatalog.js\":\"bcec30fee50cdd58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/blockRefTargets.js\":\"7ca82d56e5d3b759\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridge.js\":\"f58c267f8587a274\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridgeLoop.js\":\"54a2ad738a2a3324\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/changeHistory.js\":\"25ee4204afe0d2a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commands.js\":\"83bce6610ebe2838\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commentsCommands.js\":\"47512be2076e29f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataExtension.js\":\"97fc0ede2df6a996\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataModelGuide.js\":\"e5efc34e91348dc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/describeRuntime.js\":\"0b64c3080611974d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/extensionLint.js\":\"360bcc894d4fd060\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/grainAudit.js\":\"b02c5e5572cacaf3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/healthCommand.js\":\"3cfff45fc065bce1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/index.js\":\"df5f855ad120e7b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/presetIdentity.js\":\"f9fcf92ef9deaebe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f803e321655d443b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/readMedia.js\":\"cc07baebe44deb4f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/schema.js\":\"fba2b0459d9f0fc0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/serialization.js\":\"904d07090d1cd655\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/targets.js\":\"aadbe5249b43b6c5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/tokens.js\":\"154c24379ff6c7d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/watchEvents.js\":\"1a68e7bd01e9942a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/workspaceGuard.js\":\"4f452fa3f79b6882\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/writeCommands.js\":\"0fea8b5589972d7e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/AliasCollisionToast.js\":\"7d4743af6832a0d2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/DuplicateNameBanner.js\":\"73622a818f6c40b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/collisionMerge.js\":\"0d0492eaa583d155\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/dataExtension.js\":\"de260b7168a155bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/index.js\":\"145f4e007f4e1136\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/mergeCollisionAction.js\":\"6900d6ec69e28d13\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/pageStyling.js\":\"524c1882606a4271\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/rejectionToast.js\":\"9edb9375c5993740\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/syncProcessor.js\":\"11fd4c3118a6d45a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/actions.js\":\"d2fe0897ba4e3109\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/addComment.js\":\"1bcaf86f853b40ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchor.js\":\"89daa5b2284d5dad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchorState.js\":\"384b5e52b511b1a7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/commentLinks.js\":\"c96c188f3aca3a22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/confirmThreadDeletion.js\":\"046aff9505df9ef9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/container.js\":\"5ad4fcb74033eab9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/dataExtension.js\":\"c034b5485484ffc5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/deleteComment.js\":\"0f79f29dc4b8db87\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/highlights.js\":\"d25b2b912f72d1d2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/index.js\":\"e54e39db9de55415\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/linkedCommentsPill.js\":\"733e547495448cfb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/margin.js\":\"fbb3c57563352099\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/marginSchema.js\":\"4957635ebe4a94f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/newComment.js\":\"89833b35a4912470\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ownThreadPicker.js\":\"2c7a127c71a358cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/placement.js\":\"8c326512a1dd2bfb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/queries.js\":\"f5537550a94a184f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotePosition.js\":\"b0fba6c1c96cd5a9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedIn.js\":\"ca40fd1efb7e1627\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedRange.js\":\"a777427e1e4f6c09\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/rangeRefs.js\":\"8b1c528f62ae4a17\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readHighlights.js\":\"11a26e795a10132f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelection.js\":\"4ec4dbe434f45811\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelectionUi.js\":\"b8f57a1f3ef35897\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/reanchor.js\":\"8922e5d3c35fcd06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/schema.js\":\"36435fcd97a8edcc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scope.js\":\"448e7974ae96f4ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scopeThreads.js\":\"2da0f6c63370dfce\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/splitRetarget.js\":\"e2a3fa0e07f2fef4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestionCard.js\":\"119f4dc5a1589869\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestions.js\":\"d3bfa64035fb1fa6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaries.js\":\"3bac847ead8e8332\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaryBatch.js\":\"259a75328003a6b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/surface.js\":\"a218dcc16e05b810\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threadNavigation.js\":\"f30cfed46d5fbf5e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threads.js\":\"938a830abff329f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ui.js\":\"456042ec11f9d482\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/uiStore.js\":\"dee4357406ca5214\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/appIntents.js\":\"36a52de4c114a19e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/index.js\":\"a5197e2bc9c26414\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/index.js\":\"6040620deeb8a6bf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/status.js\":\"08f206de404c4433\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e12c0bb715ee79c1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaBlockRenderer.js\":\"d48df2763b2d7047\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaDownLaneReplicator.js\":\"64bc7b064fe36aa9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaUploadReconciler.js\":\"85abaf24c8f14a11\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetDownLane.js\":\"e89d5d11dca172f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetResolver.js\":\"137fd86d2dbbc5bf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetUpload.js\":\"40417cee4a537caa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/attachmentCleanerIO.js\":\"b62c0ea193efcad0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/supabaseAuditIO.js\":\"04a4ab62f833215a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/blobStore.js\":\"ab88d6739e897f22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/browserMedia.js\":\"539800c74a1e5cfa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/byteStore.js\":\"9a6b79d90ca8c294\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanerIO.js\":\"68265868d80b5aa1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanupAttachments.js\":\"ead0285b9d3e063a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/dataExtension.js\":\"02f8e4bdf1b14069\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/downLane.js\":\"e5a0591f2fe5d44f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/index.js\":\"3086fb366315bb41\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/insertImageContribution.js\":\"4a22abedba61f4a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneArming.js\":\"ff7c6486251ee4f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneLock.js\":\"307da5155673e90a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaBlock.js\":\"75ed25ecaf8ee63f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaCapture.js\":\"b7b83b39ab649f1a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaLanes.js\":\"c5a245a5fe1081d1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewers.js\":\"12899d9d8573455c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewersFacet.js\":\"e8cdfbac2c0d72be\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/pasteCapture.js\":\"43cc421db3cd1af1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/resolver.js\":\"00c68c5a0deeefc8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/retryUploadsAction.js\":\"32b749ddb922b994\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/storagePaths.js\":\"030306e6147ad2f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadDrain.js\":\"bfc722eaca429fa3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadLaneStatus.js\":\"b1e6bd65ff796d4f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadReconcile.js\":\"bee0a7eaccf05066\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadRecovery.js\":\"761c405c6f7c24ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadStore.js\":\"bb0b782d6252d9e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/useAssetObjectUrl.js\":\"fce793f617123d8f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"72ee9660effea2bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksViewSection.js\":\"782dba754dac58d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/facet.js\":\"67d026f7678de4e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/index.js\":\"bedba26ad36bf410\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/prop.js\":\"aec0ebaae194c6c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinkFilters.js\":\"9d86ddbb376b312a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e16c7eb10e792cac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BlockEntry.js\":\"62730598629a2125\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/LinkedReferences.js\":\"fb170626dca9944a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"09952963932fb5f7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dailyNoteDefaults.js\":\"c2d95f96c0933bf4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dataExtension.js\":\"e893c87e89a622bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/edgeExclusions.js\":\"094cbe4fb7c222db\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/filterProperty.js\":\"b37e3be5ee5ec00f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/index.js\":\"d7808f1b20ac8304\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"83a82629eafe4ceb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/applies.js\":\"439fb704ec5d33bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/countQuery.js\":\"7ce3fd651eb166eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ea9d8fb2308cf326\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/index.js\":\"5394ba45c22c511c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"10d9741bbb996961\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/presentationInvalidation.js\":\"12c6ddb93c704010\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyEditorOverride.js\":\"d171ad786a04cd0c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyFilter.js\":\"86fb8b56a2bf0288\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/query.js\":\"47b59ced4c847b17\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/resolveFilter.js\":\"e3b9f0c62eb08c56\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sourceBatch.js\":\"afe02131d30a2714\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sources.js\":\"3c7e8cb9e4228d45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useBacklinks.js\":\"411d783d99f4405a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1d012c4476d7d583\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayCelebration.js\":\"104f28817d4037a9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayOverlay.js\":\"3d2206e5b03d8ea0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/gate.js\":\"32102f129baffc04\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/index.js\":\"a278aa654b44e968\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/wolfTheme.js\":\"1e94ff23424d3bec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/BlockDragLayer.js\":\"26c3e6f4a14128fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dragController.js\":\"45d94fef296ca58f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dropTarget.js\":\"e5071913b08ff76c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/index.js\":\"f5aa4c638c7f8e16\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/projection.js\":\"567a04ed06d8f3bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/BlockMetaCard.js\":\"158eb97a0c23d904\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/index.js\":\"55bb125f73aa7f9f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/AddTagDialog.js\":\"2aaf16aab3c886ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"728f940c5129c647\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/TagNameIssueHint.js\":\"c0b4512ace741d7d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/addTagAction.js\":\"67733e6d9ba49c76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/appendTag.js\":\"3ff2727f2247f6a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/config.js\":\"dd4782a0a4e1f2b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/dataExtension.js\":\"2bbe5997a964a2e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/index.js\":\"29b71411bb0cb1c3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/propertyEditorOverride.js\":\"efd8775d66269624\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7254af6f0feead5c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"387eab3cc8ff40c8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b8a97d694af37d6f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ec88fa5bcfa86ce9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"84760918c67bb6fa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/index.js\":\"1edba885e71ceda4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"63123d77e28f58b4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/CharacterCountItem.js\":\"b9ad9209ac29537a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a5b84a7e97b9c9b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/actions.js\":\"b59b3055478e9623\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/blockType.js\":\"7d5e43c9b714be88\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/charCount.js\":\"3591a24a3b3335f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/dataExtension.js\":\"573524e30c7fbde7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/index.js\":\"2bb893e70b8416b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/profiles.js\":\"b4fefb4d504cbcae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/properties.js\":\"3568d1c0ad39b7f8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/textCounts.js\":\"23d7fa59bafd69ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/colemak-keybindings/index.js\":\"f4c2955794fbd312\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/CommandPalette.js\":\"8c2662f350221eb8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/HeaderItem.js\":\"5ee325a7e4128e80\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/context.js\":\"e05aa6cbba756717\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/index.js\":\"ebb1d1ad5c393503\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/selection.js\":\"656983a417f4fa81\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/toggleStore.js\":\"3ff2aee370375a84\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/useCommandPaletteActions.js\":\"534fb8baabd2f85c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/ContributorBadges.js\":\"a236fe11a8dad212\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/author.js\":\"88dd745aae369cec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/codeMirrorExtensions.js\":\"c9f35cd07a0c8112\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/dataExtension.js\":\"72a8663fb4edb67d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/index.js\":\"7d75d3feb2d15799\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/mentionAutocomplete.js\":\"35c613c475610d77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/processor.js\":\"6d7fafb9e6281aff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/profiles.js\":\"8f39137ceaa325c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/queries.js\":\"4f8d0e4bb4fb171d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/schema.js\":\"33d1ab25218c8573\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3fd6a2d9eab6e568\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/followOrigin.js\":\"45fbc08262912815\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/index.js\":\"c583d493f4339719\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8dcfc96911bf08b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"954f9cd38ef326b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/CalendarGrid.js\":\"3899195e609e3cdd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DailyNotePicker.js\":\"e62b2ba1263fa021\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f08e5bbbac51f337\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateNavDecorator.js\":\"7e1bb4bc364394bf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateScrubOverlay.js\":\"90720bcc35c25f4d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/HeaderItem.js\":\"cd6b85aebb2a61cc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/ReschedulePicker.js\":\"2afc5e50d739f8b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/SpreadDatesDialog.js\":\"498ff00a7fa0832f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/actions.js\":\"e50aaa2df127eea9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/blockDateAdapter.js\":\"bf007534b195efcd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/calendar.js\":\"9e5618d6eee041d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dailyNotes.js\":\"8b310b680340343c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dataExtension.js\":\"5386345225799956\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubActions.js\":\"c30a361ce7524b06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGesture.js\":\"dd823de9ab3eb588\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0481c1610b3dcc8f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubRecognizer.js\":\"493801abbdc61867\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/deletionGuard.js\":\"1066ab5f69e41f19\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dueQuery.js\":\"1b8e7d46df86eb49\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/index.js\":\"17a431b75c97adb3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/landing.js\":\"d5f65f0705044b93\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/localSchema.js\":\"213642535226049c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/referenceDateAdapter.js\":\"ee35de62975348a2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/rescheduleAction.js\":\"9952dfd7d48e5e1a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/schema.js\":\"33e0efc9495d483a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadBlockDates.js\":\"ab5e7861271062ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadDatesAction.js\":\"de3d7b1bcb2ce529\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/today.js\":\"9e2ec09ab488607f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7686e31de724954d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"444abf67fb3d37c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/audit.js\":\"85b7a05e71c786b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditAction.js\":\"7936dbf42e2bb1cf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditRanges.js\":\"5a0ef4843cb3b259\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/diagnosticsSource.js\":\"94401021b2df5878\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/divergenceScan.js\":\"6021d2d1a72d1511\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/index.js\":\"a900e60e9e42c547\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/propertyChildrenChecks.js\":\"472fbd126ccfa9d1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/referencesMirror.js\":\"e8381d936528b01d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/rowJson.js\":\"b3285f0f59903990\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/schedule.js\":\"b533d45e7792f6cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/store.js\":\"bbb2e4b237a0289c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/action.js\":\"98b586a1784571fa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/index.js\":\"9fcf953276884fb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/plugin.js\":\"70bbbdcb049779f2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"12621ac46b35e0c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/actions.js\":\"14bc8eee27ee1d92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/changeMarker.js\":\"11a901e7699aecd9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/diagnostics.js\":\"6e9c1016806e9d92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/fileSystemAccess.js\":\"26793ee73a35f73e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/filenames.js\":\"60b4f7498aac015f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/index.js\":\"649deceb2a5eb943\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/mirror.js\":\"8802ea4dc5b3b068\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runLock.js\":\"7a8c08d443c5b2b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runtimeHealth.js\":\"a363a2c3cbd44c29\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/schedule.js\":\"694d8728bc478611\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/store.js\":\"fee2e7dada92e3d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/index.js\":\"735e71d8b8d72400\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/themes.js\":\"9e06261e81765026\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/facet.js\":\"c1e707224de4f166\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/useDiagnostics.js\":\"636d94fe494f9075\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/dismissals.js\":\"19235746ca049e4a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/index.js\":\"08c358a7911fea2a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/status.js\":\"0d0cec3877f6d8cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/store.js\":\"505926ba71478d7e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"006f21fc5d599512\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsSettings.js\":\"08204a3aa673e48a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/actions.js\":\"86ba6c9496bfbdcd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/config.js\":\"1e8a653e6917175e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/dataExtension.js\":\"3456dd6dfa9cc67a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/effect.js\":\"ccd4a89186b481e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/index.js\":\"d2d95624fd04dad1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/propertyEditorOverride.js\":\"531d0d59f34dbdd2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/useToggleTree.js\":\"707d387763adf760\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/ExtractTypeDialog.js\":\"1570b2078b67008f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b03618b0dd152b07\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/PropertyShapePicker.js\":\"66d7e922d96a3ef7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/action.js\":\"54b1fb80edc45b8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/index.js\":\"3fdd7639626d08c8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/FindReplaceDialog.js\":\"fbf6eadaa705e0e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/HeaderItem.js\":\"25ba018f412b4da8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/dataExtension.js\":\"8d7f687fc34dc4d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/index.js\":\"03123215241ac99a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/search.js\":\"bffe2d60354d8894\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/toggleStore.js\":\"a6b76cdb8d333b05\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/LocationPropertyEditor.js\":\"bac9c695f7bb5444\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/MapView.js\":\"34e34ffce3ea504b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/blockTypes.js\":\"5405d3b10d0809fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/codeMirrorExtensions.js\":\"ab0a26b41a098a5e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/createOrFindPlace.js\":\"dfde96206559fa55\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/currentLocation.js\":\"9858a8eb4b7a5151\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/dataExtension.js\":\"4b54ed74f13aa59f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/geoContentDecorator.js\":\"ae59c1057d53190c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/googlePlacesClient.js\":\"f72ed3bdcac58b5f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/index.js\":\"541b1fbf424d4fed\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/locationsPage.js\":\"5e0f2cada635639e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/mapViewport.js\":\"4b167e3487fa8a5b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/pickCurrentLocation.js\":\"16e276a21f2a42bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeAutocomplete.js\":\"385fe5aae7ce0b30\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeNameCollision.js\":\"44541f6f00e0adb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/properties.js\":\"d74154e9f221bcbc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/propertyEditorOverrides.js\":\"915f6d18a70f1873\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/query.js\":\"5b0bef4accc5bf19\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/usePlaceSearch.js\":\"a630abfd1513b682\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c4dffef9526890d4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5afb3a239c770396\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ef378df1cc01c819\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/config.js\":\"92633e9ef95075f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/dataExtension.js\":\"17aadb6970e25ee5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/facet.js\":\"f8518c4ca918a687\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/grouping.js\":\"791909d39af568ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/index.js\":\"1df83302f199a8b6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"013430310844699c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/query.js\":\"23966ec57f400d8c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/resolveConfig.js\":\"b47716be12326698\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4cd216682c8ec92b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"17622ff0459d2830\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlDocumentContent.js\":\"ebf2882bae390561\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlFrame.js\":\"444fc949bc757f41\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/actions.js\":\"954c7430d4168bdb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/blockType.js\":\"42d7fc37d2468a8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/confirmRunScripts.js\":\"784b78a9c984981b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/dataExtension.js\":\"53267af3a29389c5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameAnnotations.js\":\"c73646847dbaf85e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameDocument.js\":\"b64f15c8ea1e97cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameTheme.js\":\"9d1c6efd4dddaac9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/index.js\":\"4a7328e74ff2c13f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/scriptConsent.js\":\"03fc6ae17c52cb59\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/sourceMap.js\":\"e0e9a25ef3d8f046\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/useDocumentScripts.js\":\"3eda4499bf43a5ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/index.js\":\"88e3ad82a070945a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/record.js\":\"93fe3667da366990\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/recordStore.js\":\"5b7ccd67b55b750a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/responsiveness.js\":\"002b1aba0d185a82\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/schedule.js\":\"3c6ecf0b3fb56461\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/sessionContext.js\":\"4e39bb9b91821a94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cfeeaadda6b7d4af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7c62d432c00db678\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/actions.js\":\"dd0ca6281565f0ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/config.js\":\"ec81c37866e9cac4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/dataExtension.js\":\"6943395569071e34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/effect.js\":\"ab9015ae12d2016c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/index.js\":\"7e0696626af071e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/keyCapture.js\":\"526e0a4bd2396ef3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/overrideStore.js\":\"618ab5b08ee70867\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"41e919e0403f422a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/HeaderItem.js\":\"70b36fb1852a63fe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/LeftSidebar.js\":\"63ffe75a95743961\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/actions.js\":\"77c95bfd818a64a5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/facet.js\":\"43e380fdfe458187\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/index.js\":\"599c7072b33db07a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/shortcuts.js\":\"ad42bb08992e7ffb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/toggleStore.js\":\"362135c0a990492a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/MergePicker.js\":\"60a47370df388117\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/index.js\":\"ae4a92aede0e97be\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/mergeAction.js\":\"62c6616c57945986\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/strategy.js\":\"c19ef1218bdc3a34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/Button.js\":\"12b5ef5e38de048f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"647562abd67ce7f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ef1537bb5fc73324\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/facet.js\":\"c4e97c8b57f03a0c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/index.js\":\"a67b04c41d495458\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"79140b59e27e80bc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e0e6c00199100270\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"238dc81e3b6281e1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7c57fd27de1ecf7d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/index.js\":\"8ee582b8d3b18a6e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/MoveDestinationPicker.js\":\"50bb795b9711c0af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/blockSubtreeMembership.js\":\"38619380f6ebcc97\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/contextMenuItem.js\":\"c63e87625bcb6a1c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/index.js\":\"d58f85cdbefa4f43\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveAction.js\":\"92b008092bb60928\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveBlocks.js\":\"11a40ec57815d85e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/selectionAfterMove.js\":\"1ac7e8bc6b3bb461\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/TutorialBanner.js\":\"31e913bb4e10b693\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/action.js\":\"5045e7ef1c0f0235\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/bannerDismissal.js\":\"3efc18ed4ed8a9e6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/documents/cheatSheet.js\":\"cb2a788c565963e5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/index.js\":\"70be7d0cec5e32cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/keys.js\":\"2aa3caff26c01b7f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/landing.js\":\"9b76297f01cdcee5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/outline.js\":\"ff3954b8a2e6f9e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/seed.js\":\"9f748f06a1247dd1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5b9496fe00a72983\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/analyze.js\":\"662a4e9f668a384c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/diagnosticsSource.js\":\"1f4dc4540ff52e9c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/index.js\":\"0b06526e30125391\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/load.js\":\"18a2ddfe7060444b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/monitorRun.js\":\"167263ca5db2b7fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/schedule.js\":\"78bd0f1ede4e8641\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/series.js\":\"fba309daa5574676\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/store.js\":\"b58f75cd18994c6d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/trendAction.js\":\"82840be02aadfc51\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/verdict.js\":\"9a9e5cc92b068bb1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/clickToEditAction.js\":\"65f3d2c7a67fbdb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/index.js\":\"895d544216e843f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/interactions.js\":\"1fd70c99bc7c29f7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1b73e5a84cc915a3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGate.js\":\"da886cfe6928e3e0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGateDialog.js\":\"fcad560134887617\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/action.js\":\"894d3e35f04b426e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/index.js\":\"243587af7320356e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/localRunMessage.js\":\"c413f25abbdd2a95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/plugin.js\":\"d787761c823cbbf9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/progressReport.js\":\"21318cd3b7f39c1c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/sweepProgress.js\":\"c72123a408f3e4a8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/FieldRowRenderer.js\":\"da78a4f3ec4d9caa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/ValueRowRenderer.js\":\"477c5a217a724f86\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/actions.js\":\"afc4babfbddc1028\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/autocomplete.js\":\"3a916e8d052ad4e5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/fieldRow.js\":\"9c7b03641e23055d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/index.js\":\"ec5a63a10910dd40\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/referenceWarning.js\":\"4853de4e1085bd34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueAutocomplete.js\":\"f00eef5f3af5ae82\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueSchema.js\":\"f299b2903346ef18\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/HeaderItem.js\":\"7d7b7bf47ceef5a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/QuickFind.js\":\"39ad700c1aa8b269\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/index.js\":\"bd1f330809b371e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/recents.js\":\"4aa5134ce42f9d7b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/resultItems.js\":\"1448fb343afe5d45\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/selection.js\":\"b638430a77bb3a2f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/toggleStore.js\":\"2c7015ea86d29c0d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/HeaderItem.js\":\"d5d710887366bf5e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/RecentsPageBlockRenderer.js\":\"99273c57913dec2c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/grouping.js\":\"3b75797967bb804a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/index.js\":\"83e65f172e6dd7e6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/target.js\":\"7a299498b603a3e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/codeMirrorExtensions.js\":\"fd087d3511f1fa70\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/contentPrefill.js\":\"447d5dc455f14041\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/dataExtension.js\":\"a323c4d311e21509\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/index.js\":\"0d062843cca30ffd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9ba60e576acc6ac6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/invalidation.js\":\"a911b250a111a2bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/localSchema.js\":\"25f09a750913c54d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/index.js\":\"5d08efe9b8454e0a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"df6ec93d84bef6d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/index.js\":\"4b942659dfe30308\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/referenceNode.js\":\"6983b41246f68e14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cc62d20e1c77b608\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e2cf9ad02bafd495\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/index.js\":\"7ccf43b70b44b582\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e39f7e017983ac77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f7a067a3dde7c31a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/mergeRetargetProcessor.js\":\"68e9b2faf0a2053b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/parseFence.js\":\"266cda331ff9a9fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceParser.js\":\"e1d0a3f6ca398a6a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceProjection.js\":\"8f4200ba22e45736\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referencesProcessor.js\":\"ae25502eab1ad162\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/renameProcessor.js\":\"2dc20fc56ca1ec04\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/spanReplacement.js\":\"14dda45793f3c3f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/htmlToOutline.js\":\"8a00c6a164f719d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/index.js\":\"e0df8c395a2ae564\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/normalizeClipboardDom.js\":\"54f846fcd422bd91\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/pasteDecision.js\":\"11c2f0608d2c6715\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/action.js\":\"023cd7e6a507749f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/blockIds.js\":\"f5a3cc81e208331f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/content.js\":\"89484f20802d9306\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/effect.js\":\"d60a8760d6d8f400\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/ids.js\":\"f859c7ebf427bd56\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/import.js\":\"b44e333dd82af378\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/index.js\":\"70fcdced576607ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plan.js\":\"976e37b940d7c969\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plugin.js\":\"805c6469c946ab8f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/promotion.js\":\"351008154266c2ce\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/properties.js\":\"e4a878cd7b4a6c7c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/references.js\":\"545631bfafae9643\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/report.js\":\"3dce0a593716d004\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/roamMemo.js\":\"22d3a0436d043b6f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/runtime.js\":\"c61516487afa470e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/schemaReconciliation.js\":\"a604dc7d94a32a78\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/srsMarkers.js\":\"cb90209faf8c4e46\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/todo.js\":\"777ef68992d6d044\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/typeCandidates.js\":\"25ad869203061850\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/types.js\":\"e7c229a8857e2ee7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/index.js\":\"eda6e9815cbdf6fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/store.js\":\"709096db736a44d8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/HeaderItem.js\":\"b1dd8e502adf4527\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7658aa64f6d3959a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/index.js\":\"ef09e19e207b641e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/model.js\":\"2fcb2b8c72f6f1df\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/toggleStore.js\":\"4293a97363a47097\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/useKeyInspector.js\":\"653e510fd87ddd36\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"000c36f057ef6dba\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/ShellDecorator.js\":\"5c69b6973f8ee5ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/actions.js\":\"87e4751e6e8ae9ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/exclusionsFacet.js\":\"eca01db23c8e5196\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/index.js\":\"28d5f5e08922e680\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/shell.js\":\"8baa5c6fa687ae5b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/surface.js\":\"b8e267665f565bc2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/walker.js\":\"64c7a40028f4d7c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b0da0cf8bec32c03\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/dataExtension.js\":\"91e97a7e7ddffe66\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/index.js\":\"df063ef83f6a0c49\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/indicator.js\":\"93a06dd15e504f3f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/moveSrsState.js\":\"c284b9b9776ad6ba\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"073eb276841e8e3b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/scheduler.js\":\"9cc8b49d93377d33\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/schema.js\":\"d3eb886ebb4cf085\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3256d4fe1a8c4fe7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsClipboard.js\":\"5c7a90618e3cef4d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ed1a7b78d7b4273a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DailyNoteReviewHint.js\":\"88f41a21b99e90c5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DeckPicker.js\":\"63e01b9183b3d666\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewControls.js\":\"b866f38d1c08699a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e08b6ba3c3ef0541\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewSession.js\":\"214e34c84a900635\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/actions.js\":\"cf5b2167cd23a134\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/archive.js\":\"53a279cdcb1aa7e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dataExtension.js\":\"b95f69a0a9aac2f7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/deck.js\":\"c8ee9fea4753e946\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dueQuery.js\":\"6b116ad714594170\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/gradeDecision.js\":\"c45fc8956c934495\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/index.js\":\"a5d000e53431643d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/keyHints.js\":\"a8d8af96270b532e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewCardLayout.js\":\"ce62f72028a520dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewProgress.js\":\"adbda18e05b456c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/schema.js\":\"26dd411ac1589aea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/useDueCards.js\":\"71f8d6dfc4b6a21a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/index.js\":\"8d22f32bfc047c01\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/record.js\":\"cd5779b1690e4a96\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/index.js\":\"5610fb3cc564dec6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/persistenceStatus.js\":\"bf2236768882d9cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/requestAction.js\":\"fe8c0ccccadc42de\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/TypeChipsDecorator.js\":\"7467d7e12034ea7f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/codeMirrorExtensions.js\":\"a51b5a3fca709108\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/index.js\":\"cafd84f401daf6dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/typeAutocomplete.js\":\"3615d3afd9ac2fab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2ef871b3437d154c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/actions.js\":\"5cc16b406cf83f4a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/anchor.js\":\"b9f3fe80f3d18b10\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/events.js\":\"64a84817aedf59f1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/gestureActions.js\":\"d29c517a47101a7b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/index.js\":\"97c57c967fd8880b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3db08f855da02aa5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/collect.js\":\"2a11ce65efb4b243\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/index.js\":\"657ebcab44c678e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/record.js\":\"6b716297b1c14784\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/RejectionDialog.js\":\"af13b3c7259883dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d9e90b98c97c327c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/index.js\":\"a8cb14a48b988d95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/model.js\":\"8a88399dfaef72b4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/queueCounts.js\":\"e019fc47e91d51fe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rejectedHelpers.js\":\"8f24c0e88ca74f8a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rematerializeAction.js\":\"acc5ba59aadea030\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/useHysteresis.js\":\"1ca06132c2d4208d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/ColumnHeaders.js\":\"f21d5a642050527f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/QueryUi.js\":\"c2a25bb50418d2f3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/TableLayout.js\":\"d6c515c6aebae973\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/actions.js\":\"75d44af39b3ad9e6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/cellEdits.js\":\"72bdcf9089f3c4be\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/childrenViews.js\":\"0097a449ad476237\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/columns.js\":\"93fa00f25e3b2e7d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/controller.js\":\"91093ee6220b7a00\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/convert.js\":\"975d673126b01ce7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/dataExtension.js\":\"575ff001cce2c7ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/index.js\":\"fc00a662a6ecc0f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/keys.js\":\"42bb1894b9666728\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/model.js\":\"29f76aecb96f3db8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/backfill.js\":\"579078dbaf23fa84\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/completion.js\":\"d5ff350b90810a76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/format.js\":\"44bfde83a6f16b9b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/parse.js\":\"0cbe1bf5eec87df9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/queryValue.js\":\"3ec506a462d4dd02\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/source.js\":\"582ca0da32a5cba8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/registry.js\":\"98a2e7c823e03499\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowGutter.js\":\"505e933ecb21ca66\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowVerbs.js\":\"d355c94fce82bbda\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/schema.js\":\"b712e4dfb8c1c7d1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/sort.js\":\"b198effa03311685\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/effect.js\":\"c2ca7fb01bfc90e0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/index.js\":\"a9fa588c1078d880\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/theme.js\":\"829c92d8a0aa36e3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/actions.js\":\"d85f9fb3a3dc0572\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/dataExtension.js\":\"70d5f55c0bccab6e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/index.js\":\"bb50a5ebcb6771f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/schema.js\":\"ecf6b44b96b00d1c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f5d07c535d957be1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/actions.js\":\"2f3f86df469c6130\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/defaultItems.js\":\"290e9771c37a8d35\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/facet.js\":\"32699cc08fc9aea3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/holdRecognizer.js\":\"39c45bd2a109cf4e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/index.js\":\"1afa4c2c5b6c22a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/UpdateIndicator.js\":\"e86d2c430620b95b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/index.js\":\"4412ab04882b9b47\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/loadTimes.js\":\"1d40f11e89dd8441\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoNotesRenderer.js\":\"83d4fc999a1919e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoPlayerRenderer.js\":\"39f1bef6513e561d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoTimeStamp.js\":\"e53f78cdeebd7d1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/actions.js\":\"fc1cc11ce0c13333\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/index.js\":\"f79821f84d741fdc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/markdown.js\":\"5f02370d07a6ed80\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/notes.js\":\"f5d2a6e1312aec22\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/registry.js\":\"52cef51d2ca541b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/remark-timestamps.js\":\"07c8d6b4f45cb517\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/view.js\":\"625e09fc048aa2d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/LinkHints.js\":\"35aa86ecc4c819da\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/index.js\":\"c26790ac79e37b3e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/model.js\":\"a4302f903ceb789f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/settings.js\":\"1a491a045637deeb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/actions.js\":\"50e946cc75965724\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/index.js\":\"a429f0fd17a43073\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/interactions.js\":\"654761f6aa162c34\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/workspace-header/index.js\":\"ef8744bab15ad4b0\",\"/knowledge-medium/pr-preview/pr-1871/src/registerServiceWorker.js\":\"887e5f8c2566cf84\",\"/knowledge-medium/pr-preview/pr-1871/src/requestPersistentStorage.js\":\"c9d021fd5823e100\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authRequestDeadline.js\":\"904d6e846de3db6b\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authStorage.js\":\"dfa0fd8378c49038\",\"/knowledge-medium/pr-preview/pr-1871/src/services/powersync.js\":\"989a80fa76b38785\",\"/knowledge-medium/pr-preview/pr-1871/src/services/supabase.js\":\"b6003cb9a03d0a48\",\"/knowledge-medium/pr-preview/pr-1871/src/services/uploadErrorClassifier.js\":\"4b970778b8a1a3fd\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/ActiveContexts.js\":\"76ee98d033945870\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/HotkeyReconciler.js\":\"d40e4585ca58cba8\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/WipeLocalDataDialog.js\":\"2307ca6c5ca844b5\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionDispatch.js\":\"cb47cd8ee3a1128d\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionRefItems.js\":\"1bf48665b7fbb87d\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/applyKeybindingOverrides.js\":\"75f7e6992b0b32d5\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockActions.js\":\"7a7f21187302648a\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockMergeGesture.js\":\"01f70846d4c41944\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/canonicalizeChord.js\":\"5c5c22aed3d62f25\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultContexts.js\":\"d704eef6033a5c84\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultShortcuts.js\":\"90d593da7a4e151f\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/effectiveActions.js\":\"3eb880855450909b\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureAction.js\":\"ceb28b8435974e54\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureBinding.js\":\"8113ec627fbf29e1\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/holdRegistry.js\":\"49284b9a57db9f51\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingConflicts.js\":\"0b583b8e9c9da598\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingOverrides.js\":\"28f3889beabfa8b9\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/pointerAction.js\":\"59ce547961483d33\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/resolve.js\":\"4a53238ba2e1e31f\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/runAction.js\":\"4b916bd3f0044663\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/sequenceMatcher.js\":\"2da5dbf3708c7c6d\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/types.js\":\"25c027f790538e34\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionContext.js\":\"1d2c21c999a346bf\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionDiscovery.js\":\"2fce09813713582e\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/utils.js\":\"e2290caee39edb13\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/bootStore.js\":\"be174e9f3c8d8c7e\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/previewDatabases.js\":\"f25343d300ebe85f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/byteTransform.js\":\"24ac69099625ac00\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/attachmentCleaner.js\":\"6e69ed7892ee79e5\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/attachmentParts.js\":\"ecedced433a8330a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleParts.js\":\"8482c17fefa59ac9\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleRecord.js\":\"3b8ae0086a697835\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/manifest.js\":\"2420bc4003372cde\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/takeBundle.js\":\"eeca2446c0c7d92f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/verifyBundle.js\":\"51bbf2cf8c273fc3\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/cleaningStage.js\":\"eae35bb4be052b4b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionKey.js\":\"cc5c49d05499f3f7\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionServer.js\":\"2920b2471f0fda19\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flip.js\":\"e8055568d0526b60\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flipAttempts.js\":\"4edb6ebdf6c53e48\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/pages.js\":\"32594e32e96971be\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/preflight.js\":\"57bcb0b35d0aed28\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/reseal.js\":\"4e897d52e34a068a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runConversion.js\":\"601bdef638b95695\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runLock.js\":\"f2488f0d40274587\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealing.js\":\"bfc4f2447ae1df81\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealingStage.js\":\"3fc1e327d2728463\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/stage.js\":\"35f7a959533d7403\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/verifyReseal.js\":\"e1f07d1888442bf4\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aad.js\":\"aaf46956a58a36ec\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aead.js\":\"7454843dd53466e8\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base32.js\":\"9c1353ada4c8799c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base64url.js\":\"ce1e517963155d24\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/binaryEnvelope.js\":\"3d3e04961a9e17c5\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/byteAead.js\":\"c74070de41b337e3\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/canary.js\":\"c1fc8e3c391691d5\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentHash.js\":\"4242a16e05cf6abf\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentKey.js\":\"70bd41bd98bdacd2\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/derivedIdNamespace.js\":\"132aed7097ebd850\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/envelope.js\":\"8027dcd3ffe31ec6\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/hex.js\":\"4f805df4c9e1837f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/sha256Hex.js\":\"ee6cba65228d98ad\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/workspaceKey.js\":\"a9114638a28a784d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/conversionState.js\":\"78ce54d4bfa04852\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/createEncryptedWorkspace.js\":\"15cf681000282b5f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/pastedKey.js\":\"a5326966ca3cebd0\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f33e5dc076792d8e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c5ce250d5a304bbb\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/keyStore.js\":\"62838bfb10e4e66f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/mintWorkspaceKey.js\":\"8cfaae2931ae21d5\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/modePin.js\":\"53d6b1162aba261a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/openWorkspaceKeys.js\":\"b19bea210c0f3193\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolveWorkspaceEntry.js\":\"a8893c1b77c4b676\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolver.js\":\"4d4297ead69e2b6c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/workspaceAccess.js\":\"9c7c6f328a8d3d1c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/transform.js\":\"a3d4696a1b7a9bcf\",\"/knowledge-medium/pr-preview/pr-1871/src/themeBootDefaults.js\":\"4865beef955dafd1\",\"/knowledge-medium/pr-preview/pr-1871/src/types.js\":\"5d18c03f591547ee\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/ClientLocalSettings.js\":\"3b742ed11ce57b95\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/abortableSleep.js\":\"81f845481b5f6edb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/array.js\":\"b765a84bb43f8989\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/backlinkAutocomplete.js\":\"bdd721879d1b36eb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockCrumbs.js\":\"8a2baee3451943f4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockrefAutocomplete.js\":\"1450b616b568469c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/cadencedIdleJob.js\":\"fbbf45cfd51fc427\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/callbackSet.js\":\"b76483a7fe79638d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/clientId.js\":\"2f378cc93ea9f736\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirror.js\":\"90481f7d04934e98\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirrorCompletion.js\":\"d8d4e0f3130e107e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/copy.js\":\"5241bb77d83564a4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dailyPage.js\":\"19e26691ff122463\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensics.js\":\"4d67c7da0784a9c4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensicsHooks.js\":\"e757c6264f382df5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/deleteBlockThroughUi.js\":\"c6545614d4d44aa4\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dialogs.js\":\"77863353ffaaaad5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dom.js\":\"aa04f85f95de6227\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/downloadBlob.js\":\"07ac9ab4cfaa16ec\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/drawnWalk.js\":\"c218f34a844fbcdb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/exportSqliteDb.js\":\"33f39c6757335c2f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fileSystemAccess.js\":\"35065d4883f06a95\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/flipSlide.js\":\"8cf2660c7549eafe\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fnv1a.js\":\"1c64c59b55b73368\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/formatBytes.js\":\"0463b77952453999\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fuzzyRank.js\":\"6cf063ec061a8948\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idbKeyedStore.js\":\"349036d465816e03\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idleCallbackPolyfill.js\":\"9b4ae0939267bf90\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardAwareScroll.js\":\"0ac208f0d9655178\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardViewport.js\":\"facb2fd690db388f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/lastWorkspace.js\":\"120dd8fcc05684e1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutColumns.js\":\"40c1c232a56583ba\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionDom.js\":\"083473858e466846\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionId.js\":\"4946f0f0300d7d0a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkClickGestures.js\":\"23d0401df82ea795\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkTargetAutocomplete.js\":\"cdba3da0e0529913\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbCorruption.js\":\"504297f6395ac2a5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbRecovery.js\":\"c3f46f1a2015c9af\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/markdownParser.js\":\"6633334f2de2a730\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/memoize.js\":\"afc1943dbf0fcd3e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameFieldCommit.js\":\"18809f916bccd3a6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameList.js\":\"40685c3f9a8a46f8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/navigation.js\":\"667ec0aa5821186d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/omnilinerNamespace.js\":\"b43265aa4494d7cd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/opfsPageScan.js\":\"dcf5409036562125\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelClearance.js\":\"9dd456a053e81c99\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelHistory.js\":\"9eee9a63a765da63\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLanes.js\":\"19c6cfc6e9aaaf09\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLayoutProjection.js\":\"6ce32d92632e088c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelScrollAnchor.js\":\"39b8e7f0115ce52e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelUrlFlags.js\":\"7f1ec2eb84961fce\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/platform.js\":\"47e5dc51e23e4bbf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/pluralize.js\":\"3543a1101ee314bf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyCreation.js\":\"3a36bbb9f9d8c6ef\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyNavigation.js\":\"8e723773d9276910\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyValueContext.js\":\"3584ea2ac7c4b9d0\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/react.js\":\"e369d9085beb5bbf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeDate.js\":\"e121a7e41c707194\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeTime.js\":\"3320235bc9f1e429\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/renderScope.js\":\"f0326fe552ca6422\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/resolvedThenable.js\":\"560eecbe2ecf4ab8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/routing.js\":\"2b478f86f28b8484\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/safeMode.js\":\"939852d38b0646d0\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/scheduleIdle.js\":\"a100c5bf19d2eed1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/screenWakeLock.js\":\"6bb3a20cc7ffa2a3\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/selection.js\":\"88eb05408f7ec7dc\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/softKeyboardGrab.js\":\"6981e00a3ab3446f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/startupTimeline.js\":\"1b6f03b06d3428a6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/state.js\":\"1645bb61771717d8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/string.js\":\"433cf370c957f2aa\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/surfaceZoom.js\":\"04ab5d8717e34d85\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/time.js\":\"d5b3c95abfb1a769\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toast.js\":\"fc0a2e6464d47e93\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toggleStore.js\":\"9e2fabf824ce80c9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/untilStopped.js\":\"87c2df407dc6ac7b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/userActivity.js\":\"d28f43272f4e5e0a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewTransition.js\":\"550f66679f589670\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewport.js\":\"ab2895f86c9d2104\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/webLock.js\":\"a0b30cbefb7613ef\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceRecovery.js\":\"8c42a91c1a8b4bb2\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceSnapshotStore.js\":\"fd9b6a786dd7b6f6\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-compiler-runtime.js\":\"3b91cab455e8452d\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-client.js\":\"353c4d28b1f50cca\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server-edge.js\":\"fe9b40d6ed5724ae\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server.js\":\"21e7c005e659fb41\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static-edge.js\":\"b6590d3341d8f01c\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static.js\":\"71205087b32d61b6\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-test-utils.js\":\"95b515444eb61c67\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom.js\":\"c804e9be6c3a1ca8\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-runtime.js\":\"498e3227470c6569\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react.js\":\"1447754f65531983\",\"/knowledge-medium/pr-preview/pr-1871/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
