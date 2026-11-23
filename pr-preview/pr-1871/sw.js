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
		buildId: "52290b8cbfc8-37721583",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/\":\"4ab66a8f17688b12\",\"/knowledge-medium/pr-preview/pr-1871/index.html\":\"4ab66a8f17688b12\",\"/knowledge-medium/pr-preview/pr-1871/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1871/assets/FacadeVFS-5-Rp_pVQ.js\":\"f53bdf1ce146c6c8\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSCoopSyncVFS-B83hK4f3.js\":\"2c426a8314537c3a\",\"/knowledge-medium/pr-preview/pr-1871/assets/OPFSWriteAheadVFS-CzKeCFKl.js\":\"5e5fb96846c41f54\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-BBsewdBI.js\":\"28add0a885c8a072\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/assets/wa-sqlite-async-De1cUen-.js\":\"fa7a324e3160c659\",\"/knowledge-medium/pr-preview/pr-1871/assets/worker-COJ-N9bu.js\":\"790a91f589ff8639\",\"/knowledge-medium/pr-preview/pr-1871/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1871/chunks/app-CMicRqj9.js\":\"cf65505f5accb28c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1871/index.js\":\"4639d07edd7ece91\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1871/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1871/assets/AccessHandlePoolVFS-BYuHB7sq.js\":\"72973f7422af2382\",\"/knowledge-medium/pr-preview/pr-1871/assets/IDBBatchAtomicVFS-Ds943PgS.js\":\"7f92d120076c07f1\",\"/knowledge-medium/pr-preview/pr-1871/assets/MemoryVFS-CO5l7-I2.js\":\"248838b44ab2f0ea\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-CU-A7mYV.js\":\"4716fd8b6dfea46e\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-CVdZB38t.js\":\"0c70278555fb30cb\",\"/knowledge-medium/pr-preview/pr-1871/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1871/chunks/AccessHandlePoolVFS-DPdhCvz1.js\":\"52279a5c1cb637f6\",\"/knowledge-medium/pr-preview/pr-1871/chunks/FacadeVFS-hFY592sZ.js\":\"4e838c7a22d7067a\",\"/knowledge-medium/pr-preview/pr-1871/chunks/IDBBatchAtomicVFS-CARFhvr9.js\":\"bcef1c214b858ce6\",\"/knowledge-medium/pr-preview/pr-1871/chunks/MemoryVFS-CJMD1SMy.js\":\"160a9c90aa042f98\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSCoopSyncVFS-sx9svKon.js\":\"57cad5ede6c1884c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/OPFSWriteAheadVFS-BIo2FBDc.js\":\"fa8caafe6c1c49d2\",\"/knowledge-medium/pr-preview/pr-1871/chunks/Preview-C6oz8tSl.js\":\"d02749b77497a13c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1871/chunks/card-BxiX1Zr9.js\":\"243faec5b733af99\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1871/chunks/dist-CUW5sO6K.js\":\"97f64e27dfe08862\",\"/knowledge-medium/pr-preview/pr-1871/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-CvTZkBC2.js\":\"d6ebcaa7e42d86b0\",\"/knowledge-medium/pr-preview/pr-1871/chunks/mc-wa-sqlite-async-Cj4H6ekn.js\":\"6acbf23af4f49988\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-BiERXccl.js\":\"d3261b7c1c27f15a\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-Bm7MiVaf.js\":\"b48f171a1fccda83\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-C9p5IZEN.js\":\"dbe1d9c82d739ded\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-Coz0r7pf.js\":\"b556b949ca770150\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-DBGfXARI.js\":\"225da214540a5e34\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-DCN8DM9J.js\":\"67e0558880779839\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-NB1mkfA9.js\":\"3994081bf14935a0\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server-legacy.browser.production-B4PVV02T.js\":\"88f44446431def2b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.browser.production-DMZZJMOz.js\":\"e2b095f96b55f908\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-dom-server.edge.production-BONeJFMO.js\":\"c7473f4fbd4821f3\",\"/knowledge-medium/pr-preview/pr-1871/chunks/react-i-UOhiQj.js\":\"580a24ecc98ea17e\",\"/knowledge-medium/pr-preview/pr-1871/chunks/server.browser-DY1P1ORi.js\":\"89b7712fe3d3a000\",\"/knowledge-medium/pr-preview/pr-1871/chunks/textarea-B3Aig_Cf.js\":\"2fcf8a48a51530a9\",\"/knowledge-medium/pr-preview/pr-1871/chunks/ui-BB3iJJoW.js\":\"4860555dffb0992b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-CgBhpLTs.js\":\"ef6b03adbe20b8b1\",\"/knowledge-medium/pr-preview/pr-1871/chunks/wa-sqlite-async-CyAgKzcU.js\":\"12e2e079e00ddf1b\",\"/knowledge-medium/pr-preview/pr-1871/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1871/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1871/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1871/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1871/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1871/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1871/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1871/src/App.js\":\"225c963cbdf66145\",\"/knowledge-medium/pr-preview/pr-1871/src/appUpdate.js\":\"f5be7dbb1dc3e850\",\"/knowledge-medium/pr-preview/pr-1871/src/appVersion.js\":\"f64d4ae1f6688869\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/initialLayout.js\":\"5123c2bfec76149e\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/openWorkspaceData.js\":\"38d799f5b586c27c\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/resolveWorkspace.js\":\"a8710224ea600b82\",\"/knowledge-medium/pr-preview/pr-1871/src/bootstrap/workspaceBootstrap.js\":\"6f6c981443077b3c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockComponent.js\":\"454bc0e4ed2754f7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockCrumbs.js\":\"448e6e8956829c13\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockEditor.js\":\"365e96802e4c26f4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockLoadingPlaceholder.js\":\"bf359438073378a4\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockProperties.js\":\"7bf94e917f278af0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/BlockSearchPicker.js\":\"815d835c07d3b8de\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ConfirmBulkDeleteDialog.js\":\"1f97455b3cd2e1c1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DividerHandle.js\":\"64d3c37a24469e9a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/DraftEditor.js\":\"20610d6ad8ed2cbc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/GutterPill.js\":\"84f760606d972d52\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Header.js\":\"921bce7974fe78c7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/LazyBlockComponent.js\":\"8ad3d5a1e26a1aef\",\"/knowledge-medium/pr-preview/pr-1871/src/components/Login.js\":\"51b0a72f67ada152\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ZoomableSurface.js\":\"742ad27c2720efe9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/editModeKeepalive.js\":\"5952e12d032e3898\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d69e41806bc1b426\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e4d1026925943dad\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefPropertyEditor.js\":\"a5f2973833875266\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/RefTargetTypePicker.js\":\"6cca3cbe96168fba\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/SelectPropertyEditor.js\":\"e9caae3f9d8707a3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/TypesPropertyEditor.js\":\"22f894be59f4159a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/defaults.js\":\"1fffef2e251550d0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/kernelValuePresets.js\":\"096638252c839c8c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/selectablePresets.js\":\"fb247643582dbca5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyEditors/typesPropertyUi.js\":\"b5461362c8928b02\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/AddPropertyForm.js\":\"958c3060ab8899e3\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyPicker.js\":\"ebf13bbb4747231d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/PropertyRow.js\":\"04305bbf1da3da4c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/Rows.js\":\"712336ab2bcd2302\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/actions.js\":\"624f0dd031f9d477\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/declarationOnly.js\":\"d883a00364051194\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/layout.js\":\"45e8e85e6a44c9e1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/model.js\":\"51f299f76f8dcbd0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapeUi.js\":\"f0b80133796f8e4a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/shapes.js\":\"ce14f148db92efdc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/usePropertyEditingActivation.js\":\"add47b719f76b5b9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanel/visibility.js\":\"cb6967d2bc406402\",\"/knowledge-medium/pr-preview/pr-1871/src/components/propertyPanelSections.js\":\"002878d42306a270\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockEmbed.js\":\"0755b2307da82923\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockLink.js\":\"fe6f28a0ea098e08\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/BlockRef.js\":\"d5a24c3c707ac5b7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/ReferenceLink.js\":\"d96410951ef6450b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuard.js\":\"3371ba2639fb918b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/cycleGuardContext.js\":\"185f02cdb554b204\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/linkInteraction.js\":\"ae65cc08f9b093fd\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/referenceLayout.js\":\"d9989a9a31290101\",\"/knowledge-medium/pr-preview/pr-1871/src/components/references/useBlockRefAncestors.js\":\"66cf31071108def8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockGutter.js\":\"fb5f964f897339e5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockInfoDialog.js\":\"2e693752acf12438\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BlockTypeBlockRenderer.js\":\"7a621f0974cb91ea\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/BulletHoverCard.js\":\"b27e8155639e18c5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorContentRenderer.js\":\"d5b14c995f4feb4b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"dabc9ded63c35e84\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ColumnResizeHandles.js\":\"7c25508a38adc430\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b2ec0283c1208e37\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/DefaultBlockRenderer.js\":\"7befca473c4e0081\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/LayoutRenderer.js\":\"30df86256f561498\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MarkdownContentRenderer.js\":\"115507aaa9190d52\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/MissingDataRenderer.js\":\"d5666564a856e340\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PanelRenderer.js\":\"97b81ad0a4d2e34d\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d13cf3fef083e3f2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/TopLevelRenderer.js\":\"c4b62401043b2941\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockGutterMode.js\":\"eb3bf9c438cd586e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/blockTitleText.js\":\"8fc1cce24acaaab2\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/fieldCreationKeydown.js\":\"a05a77371fab927b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/renderer/layoutRootContext.js\":\"e89cc66478c81a4e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/TypeChip.js\":\"7525ffa516c953b0\",\"/knowledge-medium/pr-preview/pr-1871/src/components/typeChip/chipStyle.js\":\"cf8b7597957403bc\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/anchored-floating.js\":\"44fa8d85af516219\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/button.js\":\"3fa1a2986bdc8be1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/card.js\":\"d7925e85e71da7e9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/checkbox.js\":\"06424f9a9d54e9c1\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/collapsible.js\":\"a70e4daa0ac3f9a8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/command.js\":\"80c9d22bf416dfd7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/context-menu.js\":\"54e209b2dd393cae\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dialog.js\":\"2af3fe852527642a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/dropdown-menu.js\":\"0bf85a4c787e4312\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/floating-listbox.js\":\"a6433c507c688aa9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/index.js\":\"73952fc844867191\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/input.js\":\"335d11cba738b019\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/kbd.js\":\"a71a5903eebaeb0b\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/label.js\":\"e0bed59ba7567970\",\"/knowledge-medium/pr-preview/pr-1871/src/components/ui/textarea.js\":\"5e86dfb5c49c3903\",\"/knowledge-medium/pr-preview/pr-1871/src/components/useEditModeYieldKeepalive.js\":\"4f2f840d4078a6e7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/BootFallback.js\":\"8bf7f2d65a2f4c36\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/FocusedRowLazyMount.js\":\"750e8bd80651e20c\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LazyViewportMount.js\":\"6c17314ecb285a14\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/LocalDbCorruptionFallback.js\":\"3712c8f21df20d39\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/error.js\":\"cc144589e5550794\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/lazyMountRegistry.js\":\"683bd3c8a6d7634e\",\"/knowledge-medium/pr-preview/pr-1871/src/components/util/suspense.js\":\"d5e40c39244daa59\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/CreateWorkspaceDialog.js\":\"764fc743e7f825d7\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/PendingInvitations.js\":\"099fb13fed2e6805\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/SyncProgress.js\":\"eb11df5dbe2a8c10\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/UnlockProgress.js\":\"1dd6ed8042f4e993\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceKeyGate.js\":\"826a9f950d575a27\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSettingsDialog.js\":\"ff883a6c1c4c9933\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSwitcher.js\":\"1a353af6a6acd3aa\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/WorkspaceSyncGate.js\":\"c3fb0d1a0d28b336\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlow.js\":\"6ee560f97cd9aa6a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/ConversionFlowHost.js\":\"c6f1ff05a706b4ad\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/EncryptionSection.js\":\"3935673b84546d7a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/attachmentPrompts.js\":\"13f2a6c481e340c8\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/bundleFolderPrompts.js\":\"070fb7607832adf5\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowDeps.js\":\"9f942a551bf5c542\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/conversionFlowStore.js\":\"ca3cd240ab2c01e9\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/flowUi.js\":\"12cd61693916d167\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/conversion/useConversionRun.js\":\"4605f09cc2b2eaee\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/keyUi.js\":\"f7774777e6b6ab0a\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnKeyLoss.js\":\"641a148128d79389\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/useCloseOnServerE2ee.js\":\"8eaa4130d23fce90\",\"/knowledge-medium/pr-preview/pr-1871/src/components/workspace/workspaceUnlocked.js\":\"c54f95af84678933\",\"/knowledge-medium/pr-preview/pr-1871/src/context/backgroundSubtree.js\":\"414fc3cd8abd8af3\",\"/knowledge-medium/pr-preview/pr-1871/src/context/block.js\":\"f217eb7ca428f7b1\",\"/knowledge-medium/pr-preview/pr-1871/src/context/layoutWsContext.js\":\"cf667a749b3edeb3\",\"/knowledge-medium/pr-preview/pr-1871/src/context/propertyDisplay.js\":\"cfb902467df008ad\",\"/knowledge-medium/pr-preview/pr-1871/src/context/repo.js\":\"91a6aff8031b7cc9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasClaim.js\":\"6e2f2f1703ae207a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/aliasSeatNamespace.js\":\"19dfa8e9cc9046fb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockData.js\":\"240dbdec356fcd32\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/blockType.js\":\"bc9b4b1d1ec444c6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/changeScope.js\":\"1f25b4993204f00b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/codecs.js\":\"c70075200d2a42a1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/derivedData.js\":\"921428d50ef82388\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/errors.js\":\"c9739691aa473ad8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/events.js\":\"33ec8fffb2b72d9b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/handle.js\":\"69905bb9ec2e53e7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/index.js\":\"5b82ee52fe5ddda6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/mutator.js\":\"688fabe19b909135\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/processor.js\":\"62e6edc0adbeb15c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/propertySchema.js\":\"dacdced66c08173c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/query.js\":\"731533115d7521b4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/sameTxProcessor.js\":\"b228817a786a516f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/schema.js\":\"69905bb9ec2e53e7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/tx.js\":\"69905bb9ec2e53e7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/typedBlockQuery.js\":\"37df573e644527d4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/user.js\":\"b3b1cb6f6e12119a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresetCore.js\":\"d548d1606e16f4ae\",\"/knowledge-medium/pr-preview/pr-1871/src/data/api/valuePresets.js\":\"19a0caec32a16e37\",\"/knowledge-medium/pr-preview/pr-1871/src/data/attachmentCleanerIOVerb.js\":\"73c78c7831cf52fc\",\"/knowledge-medium/pr-preview/pr-1871/src/data/block.js\":\"610a50c779a2f8d5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockCache.js\":\"b46499a24c06763b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockId.js\":\"10dfbc4ab1e92d01\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockLiveness.js\":\"747f0288c15c2f51\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockMerge.js\":\"6ffc78af86b53f35\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockSchema.js\":\"25869dfbbe99813c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypeLookup.js\":\"cf4a0e74ae1138a8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/blockTypes.js\":\"183e97eb38530abf\",\"/knowledge-medium/pr-preview/pr-1871/src/data/childrenView.js\":\"288e768d290f11c0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/clientContext.js\":\"1bf4ef10e7c9b483\",\"/knowledge-medium/pr-preview/pr-1871/src/data/dbFileSiblings.js\":\"c45ccca74c4bd234\",\"/knowledge-medium/pr-preview/pr-1871/src/data/definitionSeeds.js\":\"a5829a99c9114bc1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/derivedIds.js\":\"795a9afbc212f8aa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/drawnSubtree.js\":\"83c43739f2a41c59\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facetBridge.js\":\"69d4bfc53d20ec2c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/facets.js\":\"42eb4a1067986248\",\"/knowledge-medium/pr-preview/pr-1871/src/data/globalState.js\":\"e0d3ce26f8a0b534\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/aliasClaimRederiveProcessor.js\":\"e093747e03712765\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/ancestorBatch.js\":\"5ff2327e7d9e43fd\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/blockTypeTypeifyProcessor.js\":\"f9b5648937136239\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/clientSchema.js\":\"ab471f0b592ad502\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/commitPipeline.js\":\"c05bc204d0a79fed\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/devAssertions.js\":\"928de06bc5e5a330\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/firstSync.js\":\"3c8104c7ba40d3a6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/freshInitialLoad.js\":\"8be7eb132f46f9a9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/graphBackfillClaim.js\":\"ff1e580e45480640\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/handleStore.js\":\"a1560563d018184b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/idleMarkerJobs.js\":\"bb7e7b20cf879629\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initialDownload.js\":\"594dc2e934ac6e16\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/initializeClientDatabase.js\":\"a9293141a264e868\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/jsonCanonical.js\":\"09d9bf870acd3f74\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelInvalidation.js\":\"7f149dc6eec00b15\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelProcessors.js\":\"76d29ff8296706c7\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/kernelQueries.js\":\"76c4d79a0cc291eb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/mergeTypeMembershipProcessor.js\":\"8c9adbb9e050e002\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/normalizeReferencesProcessor.js\":\"81e1d4361ae2a916\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/poolInstrumentation.js\":\"f1fd0b74d486887c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/processorRunner.js\":\"047488d37bb7c7e8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyCellBackfill.js\":\"e4fe73423c56857e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildMint.js\":\"f88d539a7b00ce6c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyChildrenProcessor.js\":\"9e3c04361715eaee\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d11322174ca4b596\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyDefinitionSynthesis.js\":\"5ef868ed3756f4ce\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyKeyScan.js\":\"d02cdd0345564cea\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertySchemaResolution.js\":\"a8400a8a27d0f7cf\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/propertyValueEdits.js\":\"1b3ccbc6f61a2508\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/raiseProtocol.js\":\"8c17038dc6eab518\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/readBatch.js\":\"9ade26f2a1a3ac60\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/refProjection.js\":\"c2156213ce9b5fbe\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetLookups.js\":\"5f998d7f5e13b1b6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/referenceTargetProcessor.js\":\"dc8630ed375767f6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/replayMerge.js\":\"9c999c533b98e624\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/sqlBinds.js\":\"9fce30b196a299d9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9bc0ace96b76480f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/arrivalProcessors.js\":\"edafdd9fb0e16ad6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/invalidate.js\":\"95b67ac9867738fa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/materialize.js\":\"af33e52e24c766e0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/observer.js\":\"b3c94591dd2ed78b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/syncObserver/reconcile.js\":\"b8ccc438cba852e4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/timingMetrics.js\":\"5de206095f75e944\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/treeQueries.js\":\"19f5d91c40d1c79d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txEngine.js\":\"2c98e9bd8f0e6bac\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/txSnapshots.js\":\"4d5766539c941824\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/typedBlockQuery.js\":\"06db2ff922b6ca9a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/internals/undoManager.js\":\"ee15a436dd179293\",\"/knowledge-medium/pr-preview/pr-1871/src/data/invalidation.js\":\"d28b0d2e0c476d3c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelDataExtension.js\":\"9025d7d0ba303a77\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelPage.js\":\"a9caae484b1ea9bf\",\"/knowledge-medium/pr-preview/pr-1871/src/data/kernelValuePresetCores.js\":\"f83f16b3f0feaf0d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbCorruptionSignal.js\":\"8547f74907a4bbcb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbStorage.js\":\"c27520c25e223cff\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localDbVfs.js\":\"fcc342669a97a754\",\"/knowledge-medium/pr-preview/pr-1871/src/data/localSchema.js\":\"f57c207afd2a3410\",\"/knowledge-medium/pr-preview/pr-1871/src/data/maintenance.js\":\"0f2f09e9196ecda6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mergeProperties.js\":\"52ce037fc99c9af6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/metricsConsoleHook.js\":\"d84582bfb3ac354d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/migrationsPage.js\":\"facb9d758553ad9f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/mutators.js\":\"5d5761f4b002965c\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKey.js\":\"509aa76ea396e367\",\"/knowledge-medium/pr-preview/pr-1871/src/data/orderKeyPlacement.js\":\"642ef97b5e9096f8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/outlineSurface.js\":\"0b862f265f7dc323\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingEditorContent.js\":\"a1f63dc7e0973381\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pendingUploadsSql.js\":\"08e733f0bd3c7d77\",\"/knowledge-medium/pr-preview/pr-1871/src/data/pluginStateExtensions.js\":\"1125f7a8c4980c49\",\"/knowledge-medium/pr-preview/pr-1871/src/data/powerSyncLogger.js\":\"10bd7d4f722e25d4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/projectorRuntime.js\":\"15c8400fa1eb5beb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/properties.js\":\"abb559688f11bdcb\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertiesPage.js\":\"e73b60fe16656fae\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyChildren.js\":\"47f06575f82314e1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionFanout.js\":\"c883299e8019e60d\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionMetadata.js\":\"2e2e8ef556b749b4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDefinitionRegistry.js\":\"3f66d05a9e3cad7b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyDisplayMode.js\":\"747bd7b1e8eb87ce\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertyRowCreation.js\":\"c18bb91270ff9765\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySchemaCreation.js\":\"888e6fbb512e44f5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/propertySeeds.js\":\"b4c9d00acdd97ac8\",\"/knowledge-medium/pr-preview/pr-1871/src/data/recentsPage.js\":\"63eefdc2d2f95662\",\"/knowledge-medium/pr-preview/pr-1871/src/data/referenceBlock.js\":\"73567ed4519e87e4\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rejectedUploads.js\":\"ae2e8e8ea73f285e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/releasePowerSyncConnection.js\":\"b249eedd6678d1ed\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repo.js\":\"b90732efa32df371\",\"/knowledge-medium/pr-preview/pr-1871/src/data/repoProvider.js\":\"905a5e2d7065dafa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/rowProperty.js\":\"96e0bda9d6770bf3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/searchFilter.js\":\"4f01f2a61fe19cbe\",\"/knowledge-medium/pr-preview/pr-1871/src/data/seedIdentityLedger.js\":\"5d6e2c3e96802177\",\"/knowledge-medium/pr-preview/pr-1871/src/data/stateBlocks.js\":\"8b35ee9002b203db\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralEditPolicy.js\":\"9131b63d06c9a8a0\",\"/knowledge-medium/pr-preview/pr-1871/src/data/structuralInsert.js\":\"fd9b2e6df15e4cc3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/subtreeDelete.js\":\"bc692aad9ac5447b\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncStreamLock.js\":\"29f843ff4e14dbd5\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableSqlRecognizer.js\":\"f0d038117e2999b1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/syncedTableWriteGuard.js\":\"fc6ccbc8053fc3e2\",\"/knowledge-medium/pr-preview/pr-1871/src/data/targets.js\":\"ad97a457925646c1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeColors.js\":\"0c00b7ef7873f86f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionMetadata.js\":\"1da8aa18b26ae273\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeDefinitionRegistry.js\":\"6e09750e5d11c0b1\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeExtraction.js\":\"20b0814e6f41f75f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeInitialValues.js\":\"ae63991ecf0417a3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typePropertyGroups.js\":\"6824a4f0f321fb9a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeSeeds.js\":\"23ad2ab45f65518a\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typeTagger.js\":\"10737ee2633ba275\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typedRecords.js\":\"8ac8d7e5eed26204\",\"/knowledge-medium/pr-preview/pr-1871/src/data/typesPage.js\":\"841b653bd5acdea6\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userPrefs.js\":\"17c491cc63857948\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userSchemasService.js\":\"92c1e29281c15f42\",\"/knowledge-medium/pr-preview/pr-1871/src/data/userTypesService.js\":\"0c4c4e4f87977fd3\",\"/knowledge-medium/pr-preview/pr-1871/src/data/valuePresetRegistry.js\":\"bffd70e13f0b99c9\",\"/knowledge-medium/pr-preview/pr-1871/src/data/visibleChildren.js\":\"e684bbbb2ceadede\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceConversion.js\":\"f975b89cfb08cd0f\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceFirstSync.js\":\"a2c733526cbeb6ed\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceIdNamespace.js\":\"9b5970715a19aa04\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaceSchema.js\":\"45d20b10f4a32dfa\",\"/knowledge-medium/pr-preview/pr-1871/src/data/workspaces.js\":\"8100907d42936cce\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadLog.js\":\"faf3cb1fce48268e\",\"/knowledge-medium/pr-preview/pr-1871/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/BlockPasteShellDecorator.js\":\"b8d1819772eb114d\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/atTrigger.js\":\"c61259b27ef2b500\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/autocomplete.js\":\"0ecd8124631c0a78\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/codeMirrorExtensions.js\":\"a94d67c637fd5093\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/contentFlush.js\":\"e61e23dd4652ab68\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/defaultInteractions.js\":\"224a4b742ad65977\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/editSettleSignal.js\":\"d61430d87cbd8c68\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/insertImage.js\":\"2053dd49bd59e56a\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceCompletionRange.js\":\"509c84f61a4457eb\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/referenceTargetTypes.js\":\"d32a96158a5bc87e\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/syntaxContext.js\":\"bb0a3c3974f15be7\",\"/knowledge-medium/pr-preview/pr-1871/src/editor/triggerMatch.js\":\"b139764ccd7ce74c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/AppRuntimeProvider.js\":\"f2cccd4a4e3b2575\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/BlockFocusShellDecorator.js\":\"adee06c01ad69484\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/ExtensionRenderBoundary.js\":\"624f511efa8c102d\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/PanelContentRecovery.js\":\"b80c656db3b826e1\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/apiCatalog.js\":\"2f292ebe0cc69ea9\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/approveExtensionHere.js\":\"d633622a2e03c698\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/armedCutAppMount.js\":\"2f47b0bcab2ec2c9\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/batchableKeyedStore.js\":\"a3d30576292bf99a\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockInteraction.js\":\"221648a989343c68\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/blockSelectionAction.js\":\"c662efdd26e48f5d\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compileExtensionModule.js\":\"a5695689b0ba53f6\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/compiledModuleCache.js\":\"faa219b84e1de81f\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/continuousGestures.js\":\"58d736acd489fba0\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/core.js\":\"2fdcc86cc503ef86\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/defaultRenderers.js\":\"a277bf2d30035a0e\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/definitionFanoutAppMount.js\":\"9b5dc2d23380c256\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dialogAppMount.js\":\"6bfbc2018d84965c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensionSeeds.js\":\"284fedd1cbcca7c8\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/dynamicExtensions.js\":\"9354dbd875a20b31\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/exampleExtensions.js\":\"5a2ca7d10c125bdc\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionApprovalStatus.js\":\"e21901dae5711aa1\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrorToast.js\":\"61bc646100fb3103\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLoadErrors.js\":\"cfdbad610f5b0bbc\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionLookup.js\":\"c95527a0c5d03533\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionToggles.js\":\"beef80a066ae6ba1\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/extensionUtilitiesCss.js\":\"2124269f3998140c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/kernelPageDeletionGuard.js\":\"4e2f45f8c50df951\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/liveRuntime.js\":\"1bc36afda4ade862\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/openExtensionsSettings.js\":\"2b803a88df58a271\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/overridesCache.js\":\"8dfa6ab0db2cbba3\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/pluginIds.js\":\"92466888132c7113\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/processorRejectionToast.js\":\"f9529f47fa07428c\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeActions.js\":\"e338fc3f3498da58\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/runtimeContext.js\":\"c0141dd7ffdceae7\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticAppExtensions.js\":\"68ac1f7068bf646d\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/staticDataExtensions.js\":\"bce63ea1a3d87a76\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/toastAppMount.js\":\"4d926a2e8c1d16ca\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useOverrides.js\":\"21510b6a7d8fda01\",\"/knowledge-medium/pr-preview/pr-1871/src/extensions/useShortcutSurfaceActivations.js\":\"3297d3bd3f8597eb\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/discoverToggleTree.js\":\"5b826633a727ee5d\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/facet.js\":\"687048ee8eca703f\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/resolveAppRuntime.js\":\"4818a18e5a9c9eb4\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/runtimeEvents.js\":\"47bf2f4850065b2d\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/togglable.js\":\"cb36bc24b8bfd7d6\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/variantFacet.js\":\"45e37ef64ae6a0e3\",\"/knowledge-medium/pr-preview/pr-1871/src/facets/verbFacet.js\":\"a9f6ffaea5d024af\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/block.js\":\"4d19bcb0dfadce70\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/focusedChild.js\":\"e31308cbda21b549\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/propertySchemas.js\":\"fbd303969c1abb95\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/typeRegistry.js\":\"d0138cda68ff606d\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAncestorCrumbs.js\":\"3cbcecce728998c2\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useAutocompleteListbox.js\":\"524b78c671656e30\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedSearch.js\":\"15f17a2d25550cdc\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useDebouncedValue.js\":\"26ef22b42ecc512c\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsFocalRender.js\":\"77ac6819aa38e609\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useIsReadOnly.js\":\"730c5c8eea1a0428\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMaterializeBacklog.js\":\"f95fd4775e99162c\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useMinuteClock.js\":\"22b203a8d41131cd\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePanelLayoutProjection.js\":\"27b638ba4a0d52c4\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/usePendingInvitations.js\":\"d16af4e8cf293da5\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRendererRegistry.js\":\"8baaf6d68e08493d\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useRetainedFieldRows.js\":\"336f3ec92f87c3aa\",\"/knowledge-medium/pr-preview/pr-1871/src/hooks/useWorkspaces.js\":\"7f905b26be7b6a87\",\"/knowledge-medium/pr-preview/pr-1871/src/lib/utils.js\":\"3b215e547f828265\",\"/knowledge-medium/pr-preview/pr-1871/src/main.js\":\"0991d49da957aba3\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/MarkdownImage.js\":\"05fb1b6d5f128cc3\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/blockSeparators.js\":\"07b9b57d02eab170\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/context.js\":\"df207b6702ee0100\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/defaultMarkdownExtension.js\":\"11eb8dde0f1bb06d\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/extensions.js\":\"397aef2a0bcd7deb\",\"/knowledge-medium/pr-preview/pr-1871/src/markdown/renderMarkdownHtml.js\":\"b017796f3f51168d\",\"/knowledge-medium/pr-preview/pr-1871/src/minimal-editor.js\":\"d879862b73dceb4c\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/armedCut.js\":\"fdfb8c8bda4df80a\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/captureMediaVerb.js\":\"8f780b7d8f9bb039\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/clipboard.js\":\"cda8354d488be182\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/decision.js\":\"153d313638e30edb\",\"/knowledge-medium/pr-preview/pr-1871/src/paste/operations.js\":\"5fc7c39f8ecea313\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/AccountHeaderItem.js\":\"53b4999f629d9500\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/account-header/index.js\":\"27ba72aa1d4326d4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fadf9c2e3da4e1ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askAgent.js\":\"97bf2816cd0ebcc0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/askedStore.js\":\"446a92e99cb2b5a7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f933690745a00944\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/chipState.js\":\"b1afc5ed2559aeb6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c208c97af7b588ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/index.js\":\"d8bee8550dbc0c89\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5dd13c1416d227ed\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-dispatch-companion/schema.js\":\"d2af30ca647f004a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/AgentTokensDialog.js\":\"acb47e1784bbfe57\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/BridgePairingDialog.js\":\"83b7a9b37095a798\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/addMedia.js\":\"adf08eb86d4461a5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3dfe1e44307b8984\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/block.js\":\"f8ce4a8322a68f41\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/context.js\":\"99a695f0ce395695\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a5c09f244dde3c9b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/index.js\":\"5202886a9b908529\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/outline.js\":\"e00ffb4f971cf18e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/properties.js\":\"c64497bac4fab9e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/refs.js\":\"10dbcf3bc0257f15\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6626cf1f44599aa5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/search.js\":\"cac8695a086a7cd4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/shared.js\":\"ccf7af4c3b4470e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7be6735736388eb4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentViews/text.js\":\"c7a5baafa28173ed\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/agentWrites.js\":\"6ea0d6777e7ce525\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/authoringCatalog.js\":\"3800e3d32ed56bf7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/blockRefTargets.js\":\"49b22f06d00180e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridge.js\":\"dddd6d50a286e877\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/bridgeLoop.js\":\"7ea6fec2bb2cf03c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/changeHistory.js\":\"b9b085f019bd41dd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commands.js\":\"874f30f9618678c4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/commentsCommands.js\":\"3cde5825d637fdd9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataExtension.js\":\"53645cd98b714924\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/dataModelGuide.js\":\"afdb25a91209b3c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/describeRuntime.js\":\"5142cdd05d42d0ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/extensionLint.js\":\"29d76867980362f2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/grainAudit.js\":\"5ba6ac53fe4c1d6c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/healthCommand.js\":\"00203af817cae0e7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/index.js\":\"569075cae2520cde\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/presetIdentity.js\":\"0015984236b50d6b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e5f28d8d465606e2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/readMedia.js\":\"1a844b8150a19700\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/schema.js\":\"8d1ff8784fdd4a54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/serialization.js\":\"a102b21077154497\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/targets.js\":\"4de510b225b3234a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/tokens.js\":\"c25a76d2635ebb87\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/watchEvents.js\":\"e30b8cb30ac04e46\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/workspaceGuard.js\":\"d23ce21319776373\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/agent-runtime/writeCommands.js\":\"0f6b6fd03b50ae8d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/AliasCollisionToast.js\":\"ae06587da7c89ea5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/DuplicateNameBanner.js\":\"2bb9dc687d6e4643\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/collisionMerge.js\":\"3768580326840b89\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/dataExtension.js\":\"0f438ce2728f407a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/index.js\":\"27d6f9cb94d725bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/mergeCollisionAction.js\":\"dc6faab376bb10c9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/pageStyling.js\":\"7ebd60c30468ea33\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/rejectionToast.js\":\"e57082626e3981ab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/alias/syncProcessor.js\":\"50a3ffa79196fb94\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/actions.js\":\"f91d677d5ea8ee10\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/addComment.js\":\"ca37f4814e9fb1c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchor.js\":\"32293230a96c1286\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/anchorState.js\":\"af609e3d3c8c5637\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/commentLinks.js\":\"470d02ceb133b3fa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/confirmThreadDeletion.js\":\"fec3aaaa7cb4f984\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/container.js\":\"e98c29726f2dd737\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/dataExtension.js\":\"2130134b8e6c115b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/deleteComment.js\":\"abafd8dcf2a6917b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/highlights.js\":\"b58f102d56d9feeb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/index.js\":\"fa0facc3ac24cd7e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/linkedCommentsPill.js\":\"b56747317f79efdb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/margin.js\":\"72e7a3b3c9133b75\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/marginSchema.js\":\"59a89e798bc14184\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/newComment.js\":\"944db50737da5b03\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ownThreadPicker.js\":\"0b3ff733283c84f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/placement.js\":\"287f1ba380ae4f06\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/queries.js\":\"030120ee189d454b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotePosition.js\":\"65c3fdf5ee585e6d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedIn.js\":\"8b42240567ac69a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/quotedRange.js\":\"0d0daa21e81b8d72\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/rangeRefs.js\":\"4b7cf10faa8046e5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readHighlights.js\":\"376ef651571d6aea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelection.js\":\"b7d45164bc764a1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/readSelectionUi.js\":\"0bc21c556a393d0c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/reanchor.js\":\"40a89c083df78c6d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/schema.js\":\"de64da7e61eff2b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scope.js\":\"52a7ed9eb58e10c1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/scopeThreads.js\":\"0adf09de2da950ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/splitRetarget.js\":\"ccbc7c51fb647d89\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestionCard.js\":\"2795a431b7df98a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/suggestions.js\":\"670dac6d69a949fe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaries.js\":\"404839634cf07699\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/summaryBatch.js\":\"1c90aa1dff7d4214\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/surface.js\":\"2d0a97b5472d441f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threadNavigation.js\":\"e54abae3f7351fe1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/threads.js\":\"82af48857877202e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/ui.js\":\"d423f8dd607013e4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/annotations/uiStore.js\":\"8de7e6ce54edd1f9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/appIntents.js\":\"f43efbb5acc6a1ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-intents/index.js\":\"c04adb3e92859110\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/index.js\":\"b6cb9160f89f6bae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/app-update-prompt/status.js\":\"a4a4b7c4cec8de43\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"110be25acf48f557\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaBlockRenderer.js\":\"c1ac907a17742c15\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b1030033a1ea9eb1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/MediaUploadReconciler.js\":\"7d49b6d5ff11cda3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetDownLane.js\":\"90c1bb34c1c07e88\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetResolver.js\":\"e6745afb6db363f3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/assetUpload.js\":\"25e8139d76b768fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/attachmentCleanerIO.js\":\"f26bfab1dfdd1e9c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/supabaseAuditIO.js\":\"191630700e46dc52\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/blobStore.js\":\"d7eb324625f793ff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/browserMedia.js\":\"78317eecab73ab39\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/byteStore.js\":\"66c8488cf825f9d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanerIO.js\":\"67b92b76e8089ae1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/cleanupAttachments.js\":\"929808469e04e13b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/dataExtension.js\":\"93d8fbfc4ad9419f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/downLane.js\":\"10a8823d0417146e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/index.js\":\"775b990d5aaebebb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/insertImageContribution.js\":\"2150de07a99a2822\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneArming.js\":\"11339ade57b3b35c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/laneLock.js\":\"5cf328282a0a9e0f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaBlock.js\":\"b2766ebd4b52e4be\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaCapture.js\":\"dc515987ada19124\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaLanes.js\":\"16565f3f70acd658\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewers.js\":\"5ba49437c2c5fa74\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/mediaViewersFacet.js\":\"c062847af092ce33\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/pasteCapture.js\":\"7b2f716b7f11f7b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/resolver.js\":\"6f28ab92301b4def\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/retryUploadsAction.js\":\"e8add1a8c707e8c1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/storagePaths.js\":\"83aa9cc3ff3aad91\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadDrain.js\":\"b05cb5d34dfa8913\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadLaneStatus.js\":\"3651c7f47324039b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadReconcile.js\":\"a923e366ec91a0b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadRecovery.js\":\"74ab58a1de6d0608\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/uploadStore.js\":\"fafbe78b395b38c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/attachments/useAssetObjectUrl.js\":\"8accba6fd9623471\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b9d634f8c9e0532f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3703c962f16e9125\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/facet.js\":\"efefcc10a3dd3bb0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/index.js\":\"7ca1078be2899bd6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks-view/prop.js\":\"7f837115d813bc42\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinkFilters.js\":\"3dd932e1192aa39c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"149f5dfe1524c198\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/BlockEntry.js\":\"c2ed8bf281756107\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/LinkedReferences.js\":\"4868d48b16c13057\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"367a66d756e04ed0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dailyNoteDefaults.js\":\"7b59ada0461e75eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/dataExtension.js\":\"087752c02acf4c56\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/edgeExclusions.js\":\"8b4691454eca91cf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/filterProperty.js\":\"3080a1de425005a4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/index.js\":\"a6b1c75b53fe5304\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"810ee0b330c57e87\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/applies.js\":\"e33b874c8d576d3a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/countQuery.js\":\"e165839a2f4a48ba\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c65ce146cf1b1ba0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/index.js\":\"4e70859184659349\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"06562e412a0b56b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/presentationInvalidation.js\":\"e7d11ef3233a1ffd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyEditorOverride.js\":\"323454ad1a7dceb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/propertyFilter.js\":\"263205930c29ade0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/query.js\":\"a49ce5ff473afec2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/resolveFilter.js\":\"94b35ec6a206a6f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sourceBatch.js\":\"0a9547f5a93e92c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/sources.js\":\"b02f4b47b2cc10ab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useBacklinks.js\":\"930063a4a0740918\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6c1048e730980224\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayCelebration.js\":\"6c3db61ab6ed8d8f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/BirthdayOverlay.js\":\"b7855a4ca31a2dec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/gate.js\":\"12c486c7c4c76548\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/index.js\":\"2b92750e9d47ec5b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/birthday/wolfTheme.js\":\"fbf838950a6e9b1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/BlockDragLayer.js\":\"ccb4e5c5e3716cbb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dragController.js\":\"428beabe8711be76\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/dropTarget.js\":\"01230d1f7517b4a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/index.js\":\"ae9a0432e1353be2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-drag/projection.js\":\"337910189efa101e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/BlockMetaCard.js\":\"015abc6833cedc66\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-info/index.js\":\"cb4543d9c9c88845\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/AddTagDialog.js\":\"53c366bc1ff31104\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"bd1d1f9b13926d75\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/TagNameIssueHint.js\":\"e00de92585708b73\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/addTagAction.js\":\"018c8f270f3a467d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/appendTag.js\":\"a414cae049c24a49\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/config.js\":\"1a41f16b0dd894e6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/dataExtension.js\":\"bf65361b4a9e5275\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/index.js\":\"16dd748a63b858b8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/block-tagging/propertyEditorOverride.js\":\"616dee134cb7cc5f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbList.js\":\"bfc41fe476bc59c7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cb754efa026d1b8e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/Breadcrumbs.js\":\"392ede5e97bf9bf4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"554bc9077637b210\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c5d246c820068362\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/index.js\":\"ec0cd5f5042d09bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"202fb5a03c7c5cec\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/CharacterCountItem.js\":\"63a1ecf807a8945c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9be679c3d34522b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/actions.js\":\"efe31fdd9a0aee8d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/blockType.js\":\"8cd98e7591fb4eb4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/charCount.js\":\"7421ceea394278f5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/dataExtension.js\":\"76908ae3ab12ec66\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/index.js\":\"1f589595381edf81\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/profiles.js\":\"eb1615c43a2fb5de\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/properties.js\":\"bf1d074a45a94035\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/character-counter/textCounts.js\":\"625f224e4155be43\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/colemak-keybindings/index.js\":\"9a9fdbd35518f8a6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/CommandPalette.js\":\"bf45cd5af4337e88\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/HeaderItem.js\":\"eabed2409ca2255b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/context.js\":\"5bed44416b9a8f8d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/index.js\":\"d7aa2b214b9d84d4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/selection.js\":\"4e7ad6ccd62767c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/toggleStore.js\":\"2cbf2835c33dcfcb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/command-palette/useCommandPaletteActions.js\":\"60bac63ae443a484\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/ContributorBadges.js\":\"61fa5e9891220cb6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/author.js\":\"a9843111e5718059\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/codeMirrorExtensions.js\":\"0b39940bfe942ae4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/dataExtension.js\":\"57577ec235f31ddb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/index.js\":\"cb8fc88ce1e7ab77\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/mentionAutocomplete.js\":\"842132f32edc3697\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/processor.js\":\"28ea0e836b305451\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/profiles.js\":\"17c58d118f57c9dd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/queries.js\":\"ddaf9efaa6f3749e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/contributors/schema.js\":\"c54e27cecdd766ee\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fc1d3e80b3e94187\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ba604987cb71e1f0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/index.js\":\"af19c2b80a9cab95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"654ab916267a5b92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cf0205d4d6103224\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/CalendarGrid.js\":\"4e9a63faec067181\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DailyNotePicker.js\":\"5a1ad72a6b09b017\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"09a6fecb01e0d128\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateNavDecorator.js\":\"7f789e7b3ed27be9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/DateScrubOverlay.js\":\"02170baeb1b25bd3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/HeaderItem.js\":\"515f7821c4732dab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/ReschedulePicker.js\":\"8438ab8256dfc899\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cfb817d56342e9e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/actions.js\":\"346d4bdaedc82588\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/blockDateAdapter.js\":\"cb502bea5e0355df\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/calendar.js\":\"83f1d01a94fc2131\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dailyNotes.js\":\"cc56148cc417df90\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dataExtension.js\":\"0b59c39a18de0d99\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubActions.js\":\"4eaf25e95f35efd7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGesture.js\":\"a0d5867801a69b3d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a5507934a847bf5a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dateScrubRecognizer.js\":\"072236a51e6bbbaa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/deletionGuard.js\":\"455b418aece1a22b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/dueQuery.js\":\"3358e30827770746\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/index.js\":\"a6f4c9cc57c1ae36\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/landing.js\":\"9a0fa9580763957f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/localSchema.js\":\"00e4fb47b45b6106\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/referenceDateAdapter.js\":\"651b88d35e968681\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/rescheduleAction.js\":\"1988d2b89a3d51a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/schema.js\":\"504d70d10b15119c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadBlockDates.js\":\"ad49ca493c34e3b2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/spreadDatesAction.js\":\"5b01359c633757ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/today.js\":\"7ef4af5ac307b538\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"20bb5d0e8789d539\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d799942f07c60c36\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/audit.js\":\"af280fe69c2cae2d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditAction.js\":\"3eec10a9a6bd38ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/auditRanges.js\":\"213879e2d03dc703\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/diagnosticsSource.js\":\"e71a717c8e12ae2e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/divergenceScan.js\":\"7b9b26d4e9c0be3f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/index.js\":\"6441ace312185a3f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1e1b80253cb5653f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/referencesMirror.js\":\"7448cec96f3db723\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/rowJson.js\":\"b1712b43a3fbe681\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/schedule.js\":\"e027b72ce0de1c20\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/data-integrity/store.js\":\"7e534b64e9f21bbf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/action.js\":\"bc9f403bc1ad0082\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/index.js\":\"081e0bd5919ced9f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-maintenance/plugin.js\":\"4321d0207415f137\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1e886d59970d06a5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/actions.js\":\"767e92d5417388c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/changeMarker.js\":\"81d58febcb16c7d2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/diagnostics.js\":\"9ff976035a2f9076\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/fileSystemAccess.js\":\"7c4b31c7147d69a1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/filenames.js\":\"6230f1da8120eaf5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/index.js\":\"fbd811fb6425536b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/mirror.js\":\"cf6a770aca5c9cab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runLock.js\":\"44ed7db41a8df0dc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/runtimeHealth.js\":\"6321ddd7f6309c87\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/schedule.js\":\"13d92869ccb98c5e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/db-mirror/store.js\":\"89f6ce763dd81cd3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/index.js\":\"f19496216d44fb07\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/default-themes/themes.js\":\"cd0a5afb20a91fb7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/facet.js\":\"5e226d97457b7390\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/diagnostics/useDiagnostics.js\":\"e16d7bbc36a62884\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/dismissals.js\":\"ea172c117317a86f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/index.js\":\"59130e4bf6a27a62\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/status.js\":\"2c58239c30737362\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extension-prompts/store.js\":\"cd32cc0e84bfa80e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5d78d43b041865d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/ExtensionsSettings.js\":\"25d691fe00f3bf43\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/actions.js\":\"1e846110826f375e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/config.js\":\"192f953447513d95\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/dataExtension.js\":\"c60aac838e204139\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/effect.js\":\"bbdb5a19c5457256\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/index.js\":\"c83e0cbfa663cf0c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/propertyEditorOverride.js\":\"185d732fffa63616\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extensions-settings/useToggleTree.js\":\"cd9f4bcca8bbb1f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/ExtractTypeDialog.js\":\"28798af2c2321716\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f2db9051573ae3bb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/PropertyShapePicker.js\":\"6cef8d88142e3dae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/action.js\":\"1ae48bb20789b102\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/extract-type/index.js\":\"e88c85285d4ba342\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/FindReplaceDialog.js\":\"1d478a70f379dc19\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/HeaderItem.js\":\"6f741640efe67d14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/dataExtension.js\":\"7c0fff4b76811250\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/index.js\":\"82668162fe145903\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/search.js\":\"ae2632e05eade1ca\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/toggleStore.js\":\"c588515c1fe2b0f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/LocationPropertyEditor.js\":\"da2c45627ac78cd9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/MapView.js\":\"78fd69905c55de42\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/blockTypes.js\":\"908d5b1d95f7d856\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/codeMirrorExtensions.js\":\"84d8601d3441b113\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/createOrFindPlace.js\":\"9bcfdc7ea87e6313\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/currentLocation.js\":\"20fadf9433e07d2d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/dataExtension.js\":\"5c3edfe85a213976\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/geoContentDecorator.js\":\"7b6b8ab885c8ee35\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/googlePlacesClient.js\":\"abef08550c3a1f3d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/index.js\":\"22087327cb4a4bb8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/locationsPage.js\":\"9ba1ba8dbd225a5d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/mapViewport.js\":\"4ec318117734f3f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/pickCurrentLocation.js\":\"a5356519e39a1424\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeAutocomplete.js\":\"cb34e9dc2d42a315\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/placeNameCollision.js\":\"7ed344f902b3fa2e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/properties.js\":\"2e1d68de6328a252\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/propertyEditorOverrides.js\":\"22387f46eda3964d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/query.js\":\"46647200d5634863\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/geo/usePlaceSearch.js\":\"2a7f00c518428f89\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6e4973dab825114b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9ffb10cb4cbe2951\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"46b67f91bb98650c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/config.js\":\"a0719cfeb94e8542\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/dataExtension.js\":\"e3404617c5b78407\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/facet.js\":\"b86669da70c20057\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/grouping.js\":\"33afed9fca22a895\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/index.js\":\"81da1074470fdda5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4eefccb91e770762\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/query.js\":\"dd8ae3002c63a7fd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/resolveConfig.js\":\"1c5fe4952a74ced5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d3cf315fd45ed3cd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"26d50d2d1496f073\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlDocumentContent.js\":\"e54f4d56286d0851\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/HtmlFrame.js\":\"dff83b76c16e3e68\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/actions.js\":\"432f9886258aec1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/blockType.js\":\"b91a6359697c5173\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/confirmRunScripts.js\":\"0767a69b0e365f54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/dataExtension.js\":\"5e6052ef27371196\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameAnnotations.js\":\"a6c9f87c06d8e7e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameDocument.js\":\"46978ea071bc3404\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/frameTheme.js\":\"b1e427ae85cace47\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/index.js\":\"9c828d1a5ac11655\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/scriptConsent.js\":\"80905a1d1fb81221\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/sourceMap.js\":\"8c60b30d9f9dc67c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/html-document/useDocumentScripts.js\":\"51bbc53f11a4a1d9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/index.js\":\"476a6c8eb5cfc557\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/record.js\":\"5991368d0e4175d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/recordStore.js\":\"df3216fd487019bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/responsiveness.js\":\"b70fd7994e80a801\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/schedule.js\":\"4965fd8885536dc3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/interaction-metrics/sessionContext.js\":\"a51241378422a5ed\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"48b78716874a70a7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"752530b235bb717c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/actions.js\":\"d0f82fcb3cd0ae54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/config.js\":\"2bb6c40af0f00be8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/dataExtension.js\":\"753ca8bf737bfc27\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/effect.js\":\"01f2e4fd8c8ac830\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/index.js\":\"197a0e7070677ab3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/keyCapture.js\":\"981113ed4c2fe3e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/overrideStore.js\":\"09309a199a8460d5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"76bbd54a34dab456\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/HeaderItem.js\":\"98a858569a4e1e50\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/LeftSidebar.js\":\"4da0d6816c773f3a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/actions.js\":\"d982eea8d122d600\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/facet.js\":\"2c8ab083b178df61\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/index.js\":\"bf97f07393f57977\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/shortcuts.js\":\"32fe990caa059a6f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/left-sidebar/toggleStore.js\":\"34636fd7ec86137d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/MergePicker.js\":\"de5c5214549d7ff1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/index.js\":\"94b497a157bb52e5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/mergeAction.js\":\"d193cc311085d2c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/merge-blocks/strategy.js\":\"8a9c805ac016304a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/Button.js\":\"3534b695b95f71eb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6203083428ca0130\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1cf32fa4ec3d34d8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/facet.js\":\"b25a1a0d36de0164\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-bottom-nav/index.js\":\"7299503a3ce14e99\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0025332dfce31d93\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3a32739b6653c82c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3a40d9c208db31a3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/facet.js\":\"81322036286f5bcb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/mobile-keyboard-toolbar/index.js\":\"51130643e1b1c14e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f6ab838b7dea2dba\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8428e9e79fc4d3f7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/contextMenuItem.js\":\"056714136df02772\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/index.js\":\"b9e4c12126e4ff9d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveAction.js\":\"789b3f40b6d54a88\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/moveBlocks.js\":\"84716aa554b5dc7d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/move-blocks/selectionAfterMove.js\":\"386d824be8dc00fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/TutorialBanner.js\":\"aaf200065384220c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/action.js\":\"c096d88b0abaa5cf\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/bannerDismissal.js\":\"92216ea913863f03\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/documents/cheatSheet.js\":\"b85d23adb3af9459\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/index.js\":\"abd6e0391e06aaa9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/keys.js\":\"94558a20bd99db92\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/landing.js\":\"febced033c56c5d1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/outline.js\":\"bdba0bd113b8c975\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/onboarding/seed.js\":\"33b78879e6d447ac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cb6a688f4c7f6b9f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/analyze.js\":\"c30d91ad03740c7c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/diagnosticsSource.js\":\"49a611f3b77d35d7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/index.js\":\"e7037b426b6d72d2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/load.js\":\"481c04e1a01baaa6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/monitorRun.js\":\"a7ce50367662acb5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/schedule.js\":\"06c395e20de62f1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/series.js\":\"edcd4c1ef580c319\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/store.js\":\"c765d3e27d58b7bd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/trendAction.js\":\"5925d882632f9880\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/perf-monitor/verdict.js\":\"26e6216f4998bb42\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/clickToEditAction.js\":\"c780095bab6963f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/index.js\":\"6828ecaad96f73b2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/plain-outliner/interactions.js\":\"3f7c974154405aad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0b6c71abdce3019a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGate.js\":\"62d0177d474a2bfb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/MigrationGateDialog.js\":\"3ea16e88065f4819\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/action.js\":\"7f779560a279f440\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/index.js\":\"b4ae1fad237ee200\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/localRunMessage.js\":\"d956c15dc86f8e58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/plugin.js\":\"6d59de69e6d69147\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/progressReport.js\":\"9f0f4218259062ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/properties-migration/sweepProgress.js\":\"b81f557837991c1b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/FieldRowRenderer.js\":\"eb2625680f3ed8fc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/ValueRowRenderer.js\":\"f2fa50bfffe25259\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/actions.js\":\"50fd17e32fd2cf9d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/autocomplete.js\":\"d4513cc66616c5d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/fieldRow.js\":\"febeedb5429d8711\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/index.js\":\"0b55d18feeb927b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/referenceWarning.js\":\"87baebaddc3a8c74\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueAutocomplete.js\":\"0a5e9719f3a4c30c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/property-rows/valueSchema.js\":\"a262febe9f165bf4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/HeaderItem.js\":\"e78a699e349dd718\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/QuickFind.js\":\"306d2229a21fbbfa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/index.js\":\"c620f641c3bec36c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/recents.js\":\"3d8c6b614d8267ee\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/resultItems.js\":\"15610edc83ac7f48\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/selection.js\":\"9ec11223ee0b8fd4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/quick-find/toggleStore.js\":\"4b0913ef5d7ffdeb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/HeaderItem.js\":\"da66032f0247f775\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c1370a06d4d6cfcc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/grouping.js\":\"136a6438ba8563cb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/index.js\":\"291b42834a64c2fd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/recents/target.js\":\"b1e94d4272e15c38\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/codeMirrorExtensions.js\":\"3448713ad41b05f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/contentPrefill.js\":\"fa7ef17df6cd1cc8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/dataExtension.js\":\"9c211010ee7a9490\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/index.js\":\"eaf314af7cbb0c37\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"baec4a24ab4b5f31\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/invalidation.js\":\"5f49fc6e6b47e894\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/localSchema.js\":\"67e6bf054b7c82ea\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/index.js\":\"383ab0a3f9263f96\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"73d4f0fd4df0d0b5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/index.js\":\"9a4f447b23dbda6a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/referenceNode.js\":\"a1390bb9d7ca866b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5adec8ba3c544ea9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b24ada1ca8e4e51b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/index.js\":\"c45b5284c5f96259\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3ff6a5730f1c45ae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"564e64d1e9e85b54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/mergeRetargetProcessor.js\":\"7180deac14272482\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/parseFence.js\":\"723bc3ddb7167305\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceParser.js\":\"fe183c7344d2f7e8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referenceProjection.js\":\"302013920221f811\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/referencesProcessor.js\":\"55b48d4060dd6c91\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/renameProcessor.js\":\"e3db32c4840191ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/references/spanReplacement.js\":\"0933aaec49bd14a0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/htmlToOutline.js\":\"ab86556df23ada5d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/index.js\":\"a00d60c033db9be8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b452befb3c441719\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/rich-paste/pasteDecision.js\":\"9130649962438de6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/action.js\":\"b2b5ed64a3baaf2b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/blockIds.js\":\"88fdc45b6eaf67c3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/content.js\":\"a69fec6f969824ef\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/effect.js\":\"b66bc9c33d720333\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/ids.js\":\"ba0e368771fa000d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/import.js\":\"a74e9339e4c16c2d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/index.js\":\"97ac4e358d390d55\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plan.js\":\"057247f6e01bbf70\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/plugin.js\":\"43068d668b5f4323\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/promotion.js\":\"67ff8cf4963fdccb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/properties.js\":\"4a68a1a2ccfeafc0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/references.js\":\"7152148dc26c9534\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/report.js\":\"da7df9cbfa4beaf2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/roamMemo.js\":\"7ce7477539800b0d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/runtime.js\":\"d4ae066b2675444c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/schemaReconciliation.js\":\"7888114feaad3efe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/srsMarkers.js\":\"c4f613782c41a71c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/todo.js\":\"4597262e861958b1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/typeCandidates.js\":\"b9657612353d7e0e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/roam-import/types.js\":\"acd0175a51828a99\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/index.js\":\"2096b8e159866cf0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/search-health/store.js\":\"554bd19514a88af0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/HeaderItem.js\":\"5d8f1046fcd1a3ff\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"278d979413a4b4df\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/index.js\":\"daeb61798105f05c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/model.js\":\"bef16561fc2ba98c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/toggleStore.js\":\"a477ae4dc4aa5e30\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/shortcut-help/useKeyInspector.js\":\"dbf166a88c2a2da1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"29d7a5410d2d30af\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/ShellDecorator.js\":\"a68cbbc25687ae8e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/actions.js\":\"dc605e9ef690e8a8\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f536b03633afb796\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/index.js\":\"d2fa3f0676d3acb3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/shell.js\":\"f88b9f664723bb33\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/surface.js\":\"df51d2628c6ef642\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/spatial-navigation/walker.js\":\"38a8829d52290e1a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c6824c184cd9c4f6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/dataExtension.js\":\"5306c26a2d76392a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/index.js\":\"11bc2b08d2b0f246\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/indicator.js\":\"66de8f159b79b1d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/moveSrsState.js\":\"89226fbe6191a4ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7775719b1e63e206\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/scheduler.js\":\"237244dd4c713eb5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/schema.js\":\"5e865dc0ff20953b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f2af5c42848d09fb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/srsClipboard.js\":\"8bbbc72e7704bafa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ea7b1c7e3c1cb88c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e903a5b3cae0ad16\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/DeckPicker.js\":\"cad25b5ce47e7f14\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewControls.js\":\"42fd144eadcbaf26\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewDeckRenderer.js\":\"52b36823b193b4ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/ReviewSession.js\":\"86c9877f341e31ab\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/actions.js\":\"bf746cf5db157261\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/archive.js\":\"aafa1c94b7548412\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dataExtension.js\":\"d5e059964235c1aa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/deck.js\":\"da16380a76849d3a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/dueQuery.js\":\"78dd03eae6940fcb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/gradeDecision.js\":\"a0108885aad53c28\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/index.js\":\"52484fe78e089aae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/keyHints.js\":\"73f99e5d4020d612\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewCardLayout.js\":\"540c983a6c266dc4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/reviewProgress.js\":\"ce2d4703c9bb3dae\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/schema.js\":\"9a4590e28ed4e97e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/srs-review/useDueCards.js\":\"b50210b9edb45603\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/index.js\":\"c34b65078c17bad6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/startup-metrics/record.js\":\"753615598b17ebd4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/index.js\":\"4a61da3c78301b2d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/persistenceStatus.js\":\"76035c2f17a37b56\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/storage-persistence/requestAction.js\":\"ff1bfc20824fc9e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/TypeChipsDecorator.js\":\"57983c3761f0931e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/codeMirrorExtensions.js\":\"fec4828a7e6a32bc\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/index.js\":\"9ff7ee29b561ff2a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/supertags/typeAutocomplete.js\":\"2994c86140b33f86\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"feb5b90908df8fd0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/actions.js\":\"4b9d778d07f5d20a\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/anchor.js\":\"817c4d7501d50dc5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/events.js\":\"8f2eeae8262872be\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/gestureActions.js\":\"cc514a3858327d69\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/index.js\":\"d3eb3797ccdca68e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"46a4e76142a1a0c2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/collect.js\":\"b9850fad0a9eca88\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/index.js\":\"0754ec760d90b551\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/sync-metrics/record.js\":\"49cc0a84b5313375\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/RejectionDialog.js\":\"68f5eb4c3914a76d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/SystemStatusHeaderItem.js\":\"249334f0526832dd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/index.js\":\"b481f6df53bfbca4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/model.js\":\"aca9d5e239e57fcb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/queueCounts.js\":\"2f707bcca36e2021\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rejectedHelpers.js\":\"aceaf6c076aa8262\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/rematerializeAction.js\":\"5970fcfd67c8d60c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/system-status/useHysteresis.js\":\"00b250534c2a4a1e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/ColumnHeaders.js\":\"224343e7b98d52c0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/QueryUi.js\":\"ea7451b11f09f902\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/TableLayout.js\":\"b19f04e381686057\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/actions.js\":\"279219097fcfd6aa\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/cellEdits.js\":\"fc3c08e1ef14b3c6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/childrenViews.js\":\"cfbf60d270fe5c98\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/columns.js\":\"b679110a41d00d15\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/controller.js\":\"953cbee284e00ff4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/convert.js\":\"116d70248736773f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/dataExtension.js\":\"12db7c1dbc0b2df2\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/index.js\":\"7c4494b95b91107d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/keys.js\":\"e5c5c0d75d15ab75\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/model.js\":\"47833f6c9f7d8029\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/backfill.js\":\"e6c5bfb73e453317\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/completion.js\":\"64ee38cd125668ad\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/format.js\":\"e841331ba9ffe193\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/parse.js\":\"f5a05cc6b2d9df7b\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/queryValue.js\":\"e898140ab3add43e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/query/source.js\":\"1f24ec477209f9e7\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/registry.js\":\"ba02d10f42369487\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowGutter.js\":\"60bf29e1661bd1f4\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/rowVerbs.js\":\"d77eebef971ac1fe\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/schema.js\":\"746a85a5b2db53e9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/tables/sort.js\":\"3f0eaeb6a40dfbb6\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/effect.js\":\"45458774f326b1d0\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/index.js\":\"0f3069ebafae5b82\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/theme-toggle/theme.js\":\"05107366da61e968\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/actions.js\":\"f26d32c6f08461b3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/dataExtension.js\":\"0f973fc0278bbafd\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/index.js\":\"2578039be5cea8b9\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/todo/schema.js\":\"b639861a4066ea36\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a654708b18dcb06c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/actions.js\":\"7aee5bca10f7849e\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/defaultItems.js\":\"f7887ee612669a08\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/facet.js\":\"dd64b2760fe874d3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/holdRecognizer.js\":\"b2d96333f98ed257\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/touch-selection/index.js\":\"10456a0ed08c49ac\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/UpdateIndicator.js\":\"eeaa1b5436a98f51\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/index.js\":\"559f57b1a48a2ebb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/update-indicator/loadTimes.js\":\"93c6f4d5e89844a1\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoNotesRenderer.js\":\"e53fdd1deeb31b54\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoPlayerRenderer.js\":\"fef0c3055b035964\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/VideoTimeStamp.js\":\"a2f3b766ae9cafd5\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/actions.js\":\"221f945045f4484c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/index.js\":\"b0284a219401f238\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/markdown.js\":\"444fa3ee993d64f3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/notes.js\":\"92b4cf7e0be19f30\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/registry.js\":\"f24601c27670a96f\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/remark-timestamps.js\":\"dfbf5430db14adfb\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/video-player/view.js\":\"042241d01069b53d\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/LinkHints.js\":\"09503fbb1deacef3\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/index.js\":\"547aed5186ef9984\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/model.js\":\"69d2fc50de585b58\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-link-hints/settings.js\":\"0f800335c96ddc4c\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/actions.js\":\"fe1ffcd6726de172\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/index.js\":\"ef112cc1e2d23765\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/vim-normal-mode/interactions.js\":\"8ae1a5ad1331b784\",\"/knowledge-medium/pr-preview/pr-1871/src/plugins/workspace-header/index.js\":\"ef0d9edc683a322c\",\"/knowledge-medium/pr-preview/pr-1871/src/registerServiceWorker.js\":\"6a14c29763913d26\",\"/knowledge-medium/pr-preview/pr-1871/src/requestPersistentStorage.js\":\"e5bbbec4218f315c\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authRequestDeadline.js\":\"cad4ebde885c8383\",\"/knowledge-medium/pr-preview/pr-1871/src/services/authStorage.js\":\"69ce508010ac5558\",\"/knowledge-medium/pr-preview/pr-1871/src/services/powersync.js\":\"eff81296f5e57376\",\"/knowledge-medium/pr-preview/pr-1871/src/services/supabase.js\":\"af72c435d2b8612e\",\"/knowledge-medium/pr-preview/pr-1871/src/services/uploadErrorClassifier.js\":\"aa8064e808b53618\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/ActiveContexts.js\":\"27596e943afdc2ac\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/HotkeyReconciler.js\":\"6d2e5ad814227e12\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/WipeLocalDataDialog.js\":\"080c2448e06d6b92\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionDispatch.js\":\"2cd11615abf13e00\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/actionRefItems.js\":\"8a3c68a6db3b31d7\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/applyKeybindingOverrides.js\":\"14ecf1ffdc5a8821\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockActions.js\":\"ecaeb1fc5019588d\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/blockMergeGesture.js\":\"0fe4427836bc1c6b\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/canonicalizeChord.js\":\"776d667eed6e3219\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultContexts.js\":\"3d66c4cf2a57f18b\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/defaultShortcuts.js\":\"d0fe3d6955f60bef\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/effectiveActions.js\":\"d9759fbecd981936\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureAction.js\":\"720498ada5473adc\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/gestureBinding.js\":\"7a1fd0970a9735c6\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/holdRegistry.js\":\"cffd1d302d85e080\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingConflicts.js\":\"f914c02cd6ac0927\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/keybindingOverrides.js\":\"932f7b937e4df0cb\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/pointerAction.js\":\"64b914151a26c9e0\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/resolve.js\":\"0ca2182c6fef90b6\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/runAction.js\":\"94732f39c9a36155\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/sequenceMatcher.js\":\"866adc04db431153\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/types.js\":\"b013dc95eb47c367\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionContext.js\":\"66fa86c0a6ee8783\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/useActionDiscovery.js\":\"ac679da4147ce0a2\",\"/knowledge-medium/pr-preview/pr-1871/src/shortcuts/utils.js\":\"b7ee46f34359866a\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/bootStore.js\":\"072daaea8c73596b\",\"/knowledge-medium/pr-preview/pr-1871/src/sw/previewDatabases.js\":\"b50b3732834ef841\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/byteTransform.js\":\"49ec8c99e75c97f1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/attachmentCleaner.js\":\"1295fcfb7f9a695b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/attachmentParts.js\":\"6bae6707c7cbb06f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleParts.js\":\"0e208a894452897a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/bundleRecord.js\":\"0df3e8b27b80eb4e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/manifest.js\":\"ea5554279c90b018\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/takeBundle.js\":\"6fb2edf040fc6b2c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/bundle/verifyBundle.js\":\"ce337dfa73b0c21e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/cleaningStage.js\":\"90145716f428da15\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionKey.js\":\"2b5381273c3a26cc\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/conversionServer.js\":\"66850dbfb8114c5d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flip.js\":\"42ddf8bf35656881\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/flipAttempts.js\":\"4c3d8d3ed5f8dd7c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/pages.js\":\"91f76ac8097c2e0d\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/preflight.js\":\"615acf27328cf109\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/reseal.js\":\"d57cf257c74d2a6c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runConversion.js\":\"8113129715cd363a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/runLock.js\":\"029a9acbead4c5a7\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealing.js\":\"ab0e84f96408f115\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/sealingStage.js\":\"aa61f54cb5ddab6f\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/stage.js\":\"8b5c1ff49c7586f7\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/conversion/verifyReseal.js\":\"66e86ec4e841b4fa\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aad.js\":\"c9dbb2c046722f02\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/aead.js\":\"75b60b473c6260f9\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base32.js\":\"ec344e6302aac0ae\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/base64url.js\":\"e50f534cd6f01c5c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/binaryEnvelope.js\":\"1708689b0cb73cfb\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/byteAead.js\":\"d4ffd19421ec822e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/canary.js\":\"879dd3c861a99ad1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentHash.js\":\"ac9bbc538dc2ecc1\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/contentKey.js\":\"c24126d73872f3a2\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/derivedIdNamespace.js\":\"e7a5b16c2321268a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/envelope.js\":\"4c12de996560b650\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/hex.js\":\"d17c9d1186379122\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/sha256Hex.js\":\"15aae058fffd4f2b\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/crypto/workspaceKey.js\":\"9da3771b4ecd44c0\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/conversionState.js\":\"b3bc756397e0913a\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f3120fd4e85d9a70\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/pastedKey.js\":\"26409e2e509b64b8\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"deed7b6d456444c4\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/flows/upgradeWorkspacePin.js\":\"12d63bc74b422be7\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/keyStore.js\":\"a6cad4be62d7a25c\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/mintWorkspaceKey.js\":\"27d5da4b018c5b78\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/modePin.js\":\"fd1b4a175f3bcaf6\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/openWorkspaceKeys.js\":\"09e2df9b1c55ab5e\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolveWorkspaceEntry.js\":\"235f7f10aa0c7621\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/resolver.js\":\"85a88f7f6c070676\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/keys/workspaceAccess.js\":\"afeedd90c190f649\",\"/knowledge-medium/pr-preview/pr-1871/src/sync/transform.js\":\"e085e8be3ff76c4b\",\"/knowledge-medium/pr-preview/pr-1871/src/themeBootDefaults.js\":\"a0c31688245c45f2\",\"/knowledge-medium/pr-preview/pr-1871/src/types.js\":\"6926bac769831b47\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/ClientLocalSettings.js\":\"7a03d34360227490\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/abortableSleep.js\":\"56094415121f633a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/array.js\":\"8fb4a313b592442c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/backlinkAutocomplete.js\":\"eb05bdadfa69a2e9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockCrumbs.js\":\"e774cfa92f372449\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/blockrefAutocomplete.js\":\"a16a455fdfb6ccfc\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/cadencedIdleJob.js\":\"7af1103df1607460\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/callbackSet.js\":\"09bd93f4de41ad3d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/clientId.js\":\"7c54a45e8d924b1f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirror.js\":\"01f450d7b8b911c7\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/codemirrorCompletion.js\":\"c92916a4e4a280b5\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/copy.js\":\"c38004f222ebc05a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dailyPage.js\":\"f6cd591209639d66\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensics.js\":\"23a7ac03f9ae54bb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dbForensicsHooks.js\":\"7e19b6fa2d965e76\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/deleteBlockThroughUi.js\":\"170b0f13c6f445bd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dialogs.js\":\"f1a9859b2336aa63\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/dom.js\":\"9236f1afe69f3129\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/downloadBlob.js\":\"96d3bf39266a9ceb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/drawnWalk.js\":\"18ba7d19a25bfa80\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/exportSqliteDb.js\":\"d839d7b9312d1415\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fileSystemAccess.js\":\"8ca77172dd89e42e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/flipSlide.js\":\"ba9db507111cd3ba\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fnv1a.js\":\"69bd1eacccad289e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/formatBytes.js\":\"b969cc009992f10c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/fuzzyRank.js\":\"abad127f77cd7af1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idbKeyedStore.js\":\"443710a2c28f6c43\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/idleCallbackPolyfill.js\":\"a855d5cb9ec9737f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardAwareScroll.js\":\"06cd61050bf4d824\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/keyboardViewport.js\":\"41a461ba001ff984\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/lastWorkspace.js\":\"adeada7648cfbda6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutColumns.js\":\"9b86456f265b6e15\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionDom.js\":\"7877d9fe2f42e0d8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/layoutSessionId.js\":\"a5271dd4d9d2b9a9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkClickGestures.js\":\"927642cdd7eab2f2\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/linkTargetAutocomplete.js\":\"c3c300adafc6ee57\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbCorruption.js\":\"413aaa31712cf474\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/localDbRecovery.js\":\"4f2b6c58215b22bf\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/markdownParser.js\":\"0267e1e65f43fce0\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/memoize.js\":\"d49b43260f3698da\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameFieldCommit.js\":\"fcf8bca6b45b7ffc\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/nameList.js\":\"7798d59654048783\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/navigation.js\":\"3256f13005d1fe78\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/omnilinerNamespace.js\":\"d8adc5c9a811c5bd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/opfsPageScan.js\":\"c67c856e1e93683b\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelClearance.js\":\"ab9dfa548e0c4a7a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelHistory.js\":\"8fc2ba2255d94ead\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLanes.js\":\"b4f9d5bacfb4328e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelLayoutProjection.js\":\"dff4bd70f7083a82\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelScrollAnchor.js\":\"cbbab860cead2e31\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/panelUrlFlags.js\":\"d398b66ec294e5fd\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/platform.js\":\"3b810a6bc64aa0df\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/pluralize.js\":\"35551ea916e62b4d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyCreation.js\":\"d75943a07bb95365\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyNavigation.js\":\"20bcb3e50241785d\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/propertyValueContext.js\":\"4f1373e912699473\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/react.js\":\"d2388cdeb3999b60\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeDate.js\":\"d9d4705a92624d29\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/relativeTime.js\":\"59cafb10770d7d5a\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/renderScope.js\":\"3fa22f3ace4fb79e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/resolvedThenable.js\":\"027ecc3098e0fb6f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/routing.js\":\"18915b65612ae1cb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/safeMode.js\":\"b4567615aff9d2eb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/scheduleIdle.js\":\"d9edd8e04703fe5f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/screenWakeLock.js\":\"010ddde62ff3a74c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/selection.js\":\"5a603acdb16d1909\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/softKeyboardGrab.js\":\"50adae65218e3894\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/startupTimeline.js\":\"dd5e16002897280e\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/state.js\":\"80a3827c448f9473\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/string.js\":\"e63e38d89f1d91f8\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/surfaceZoom.js\":\"b620776416d3865f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/time.js\":\"211b0e2134934c6c\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toast.js\":\"b625635014d22c78\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/toggleStore.js\":\"97840b74c6921ceb\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/untilStopped.js\":\"5a080c87ff567034\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/userActivity.js\":\"c0dce29da4b711b9\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewTransition.js\":\"57714d2def67fe5f\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/viewport.js\":\"e8c5d19f8c1e05d1\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/webLock.js\":\"92f76398328f9157\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceRecovery.js\":\"7fb8ef90e141a639\",\"/knowledge-medium/pr-preview/pr-1871/src/utils/workspaceSnapshotStore.js\":\"4f45a930f4adec37\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-compiler-runtime.js\":\"363bf450d5ac21e0\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-client.js\":\"1f99cd84a911abd2\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server-edge.js\":\"c5771afca81831b3\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-server.js\":\"5d624680e31310b1\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static-edge.js\":\"06fa6c439b55fc1f\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-static.js\":\"da61cf5e420ee3a6\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom-test-utils.js\":\"7dd7f4fedcb77997\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-dom.js\":\"cf8581ea17e3a762\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react-jsx-runtime.js\":\"174fedf28e6dba52\",\"/knowledge-medium/pr-preview/pr-1871/src/vendor/react.js\":\"363410e9b3db0b93\",\"/knowledge-medium/pr-preview/pr-1871/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1871/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
