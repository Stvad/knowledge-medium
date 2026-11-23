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
		buildId: "c400428ae088-94874737",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/\":\"987f040e835883ff\",\"/knowledge-medium/pr-preview/pr-1872/index.html\":\"987f040e835883ff\",\"/knowledge-medium/pr-preview/pr-1872/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1872/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1872/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1872/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1872/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1872/assets/FacadeVFS-puZlWYde.js\":\"52bdcac4b35d909e\",\"/knowledge-medium/pr-preview/pr-1872/assets/OPFSCoopSyncVFS-v96zNdWA.js\":\"20276ebd0845c3e1\",\"/knowledge-medium/pr-preview/pr-1872/assets/OPFSWriteAheadVFS-28ODNTXz.js\":\"6e45fb4159c5bb8c\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-async-C28BZIcj.js\":\"2d37f059852d4308\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-d0Pi7Ywt.js\":\"5e020a2459f62922\",\"/knowledge-medium/pr-preview/pr-1872/assets/worker-B9qx4kxR.js\":\"b1a747ddd757dcc9\",\"/knowledge-medium/pr-preview/pr-1872/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1872/chunks/app-BrVTuSmk.js\":\"63e355a5c5e2d193\",\"/knowledge-medium/pr-preview/pr-1872/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1872/index.js\":\"a93b58e79c10f69d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1872/assets/AccessHandlePoolVFS-DqmgBvMr.js\":\"f71c8436c72596b7\",\"/knowledge-medium/pr-preview/pr-1872/assets/IDBBatchAtomicVFS-ByGLCDxD.js\":\"bd9a5908675a26d5\",\"/knowledge-medium/pr-preview/pr-1872/assets/MemoryVFS-Bm22rp-w.js\":\"9c6ea9cd3fc5d7db\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-D3derA7m.js\":\"850f4525551d5040\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-async-DM_fHM1v.js\":\"c297666e4dcb2e86\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1872/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1872/chunks/AccessHandlePoolVFS-k7A6rWH8.js\":\"caea2cb69ba65e10\",\"/knowledge-medium/pr-preview/pr-1872/chunks/FacadeVFS-BjXdHCJK.js\":\"88a28421178e459f\",\"/knowledge-medium/pr-preview/pr-1872/chunks/IDBBatchAtomicVFS-CQ0ssh1x.js\":\"62b34e6efeecb70c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/MemoryVFS-B6IN62YH.js\":\"fb5f5b7fb2f324a5\",\"/knowledge-medium/pr-preview/pr-1872/chunks/OPFSCoopSyncVFS-D5BnGjWf.js\":\"7b13d4c2047fc81c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/OPFSWriteAheadVFS-CbjEmin7.js\":\"71efd7d0c29d375b\",\"/knowledge-medium/pr-preview/pr-1872/chunks/Preview-Cqg-NAZP.js\":\"36850e217bf658f3\",\"/knowledge-medium/pr-preview/pr-1872/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/card-B9cnpq2x.js\":\"b2fab5d57af6c829\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-DRLW5VB9.js\":\"4dc2b0334de07b84\",\"/knowledge-medium/pr-preview/pr-1872/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1872/chunks/mc-wa-sqlite-DJjmPd8c.js\":\"607290a36b24bb0d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/mc-wa-sqlite-async-CEpgnNIl.js\":\"0d574e4f52d184dd\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-B-pYtrdk.js\":\"87b3b2bfb4d4b09d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-BYsZC-6f.js\":\"2d0cc741aac3a64f\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-C7hLjky7.js\":\"00d192b10ca389f5\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-CJawtvn2.js\":\"5e4ef4b40e790f2f\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-CvVVmtIZ.js\":\"1b64187b40c56064\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-DA2Fo7VT.js\":\"59086374502fee65\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-J2rEXF0m.js\":\"137d8ebd74bddc00\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-OwMKMY-Q.js\":\"34f27df5b85c9b3a\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server-legacy.browser.production-DNS5pP-j.js\":\"711b947736f48c0c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server.browser.production-BmTie3JD.js\":\"04369fd456f4444b\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server.edge.production-8hpi97m1.js\":\"158a8b2cf7e14a44\",\"/knowledge-medium/pr-preview/pr-1872/chunks/server.browser-CdQuJrdl.js\":\"6783f8927814c1f5\",\"/knowledge-medium/pr-preview/pr-1872/chunks/textarea-CFh8Dn77.js\":\"341915da230e0655\",\"/knowledge-medium/pr-preview/pr-1872/chunks/ui-CC35D-uv.js\":\"5e8fc5863448f316\",\"/knowledge-medium/pr-preview/pr-1872/chunks/wa-sqlite-DWd738-m.js\":\"b70d570dcbbfa879\",\"/knowledge-medium/pr-preview/pr-1872/chunks/wa-sqlite-async-D3kXuqUS.js\":\"bbc670f1f3cc5131\",\"/knowledge-medium/pr-preview/pr-1872/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1872/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1872/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1872/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1872/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1872/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1872/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1872/src/App.js\":\"1019ab6201dfcbb4\",\"/knowledge-medium/pr-preview/pr-1872/src/appUpdate.js\":\"29c02aaec28624f3\",\"/knowledge-medium/pr-preview/pr-1872/src/appVersion.js\":\"025eb624d699a06f\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/initialLayout.js\":\"4ad8cd0f04666111\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/openWorkspaceData.js\":\"753874f3f6b41a67\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/resolveWorkspace.js\":\"fc445cbbb3c4b9de\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/workspaceBootstrap.js\":\"27686f7d3ab9b2a1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockComponent.js\":\"f1f6ee06a841d9ba\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockCrumbs.js\":\"2af0763f660ce615\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockEditor.js\":\"cb61b74a0245543f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockLoadingPlaceholder.js\":\"224b5d03bb13410c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockProperties.js\":\"5ed38d64abffbae4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockSearchPicker.js\":\"777aeb8aea92595a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ConfirmBulkDeleteDialog.js\":\"b4015278ba931bc4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/DividerHandle.js\":\"3b89b810671df73e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/DraftEditor.js\":\"bd66b88860accb2f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/GutterPill.js\":\"2226e107b7d85243\",\"/knowledge-medium/pr-preview/pr-1872/src/components/Header.js\":\"7b5ad37038f5bd17\",\"/knowledge-medium/pr-preview/pr-1872/src/components/LazyBlockComponent.js\":\"79642f06245f1b0a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/Login.js\":\"9717f8cd70ee6889\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ZoomableSurface.js\":\"880a8f218d117486\",\"/knowledge-medium/pr-preview/pr-1872/src/components/editModeKeepalive.js\":\"34d6c71607da6a94\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b87053a0a247f752\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f6fd57bb31a87294\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/RefPropertyEditor.js\":\"e954e853034b53cf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/RefTargetTypePicker.js\":\"1787ef184f830aef\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/SelectPropertyEditor.js\":\"0fdadfb062a044aa\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/TypesPropertyEditor.js\":\"eaf01e7d734e07ff\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/defaults.js\":\"c1e98ea69d09b8bb\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/kernelValuePresets.js\":\"4b2b3b93fd3ae126\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/selectablePresets.js\":\"5dffddabf8cb648a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/typesPropertyUi.js\":\"55f6b729191edf73\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/AddPropertyForm.js\":\"30055f9203133adc\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/PropertyPicker.js\":\"0444c30758255dab\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/PropertyRow.js\":\"a0f996ac5f3ee799\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/Rows.js\":\"6fe4133ed6b94ff3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/actions.js\":\"ebd36fe6decf86fe\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/declarationOnly.js\":\"fac58c169c4d166c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/layout.js\":\"20fbc46ed6ccd2ad\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/model.js\":\"7ad5745fdb84acc4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/shapeUi.js\":\"6afc3f2b8a53abaf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/shapes.js\":\"c32bb694ef9e9a70\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1dd4b8aed84b8d9a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/visibility.js\":\"450f5a998fde3349\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanelSections.js\":\"c84a1c0cf689b826\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockEmbed.js\":\"e45f791adfa0716f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockLink.js\":\"778c53de2b7484a9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockRef.js\":\"3d8781e5d7cc9a64\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/ReferenceLink.js\":\"665507cc5147a605\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/cycleGuard.js\":\"fd7baa0b681f75a7\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/cycleGuardContext.js\":\"2c2eda23aee602b2\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/linkInteraction.js\":\"76275f6324e43031\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/referenceLayout.js\":\"9ce98c7b7e997e3e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/useBlockRefAncestors.js\":\"87769a2093eeed97\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockGutter.js\":\"7c8a6fa0f4eeb5d1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockInfoDialog.js\":\"150878ab771cb797\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockTypeBlockRenderer.js\":\"7d9aef750ff6937a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BulletHoverCard.js\":\"517055408b22a48c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/CodeMirrorContentRenderer.js\":\"f4105c397eb7da7d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d1e88d63c7df6bb4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/ColumnResizeHandles.js\":\"d68c47bd1d8adcbe\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b61f3bb4c0d85310\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/DefaultBlockRenderer.js\":\"0dcd4621e5c6812e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/LayoutRenderer.js\":\"e6ee4252fcbbd52e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/MarkdownContentRenderer.js\":\"d394b852890eb45e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/MissingDataRenderer.js\":\"475e4acaabc8d073\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/PanelRenderer.js\":\"6fb3273604e58278\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/PropertySchemaBlockRenderer.js\":\"66c2509780a58a34\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/TopLevelRenderer.js\":\"28de8621b24a632a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/blockGutterMode.js\":\"053c513e9bc6a7b7\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/blockTitleText.js\":\"3deec10854d73b3f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/fieldCreationKeydown.js\":\"b80b17f6def1a5d0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/layoutRootContext.js\":\"fc63749597ecb0b1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/typeChip/TypeChip.js\":\"a216449bee8dfee6\",\"/knowledge-medium/pr-preview/pr-1872/src/components/typeChip/chipStyle.js\":\"15ee96ca219069b1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/anchored-floating.js\":\"214e4231d112ad25\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/button.js\":\"c44bd2d708a08677\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/card.js\":\"b5f383631a00b9c9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/checkbox.js\":\"5924d1eed9e7d6cb\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/collapsible.js\":\"624cf2798e14d371\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/command.js\":\"78d53d43d6a60133\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/context-menu.js\":\"83f469127a1b6004\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/dialog.js\":\"9a2d4257378eb34c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/dropdown-menu.js\":\"ee97ea852235bb20\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/floating-listbox.js\":\"ff1624250796458f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/index.js\":\"9d936523894de3df\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/input.js\":\"f8e8c4b3bc28451d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/kbd.js\":\"eaf1ecc9143fe279\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/label.js\":\"6606ed1914bc0b4c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/textarea.js\":\"69d58ef567e553f7\",\"/knowledge-medium/pr-preview/pr-1872/src/components/useEditModeYieldKeepalive.js\":\"c33a0f30282848b4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/BootFallback.js\":\"37445942dac48e4a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/FocusedRowLazyMount.js\":\"5b371aa333a3e13f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/LazyViewportMount.js\":\"3c00c2fc9a9ff0d9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/LocalDbCorruptionFallback.js\":\"61a0c77780d826c1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/error.js\":\"5ea2f09033d15f18\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/lazyMountRegistry.js\":\"9ff449b34fc8739a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/suspense.js\":\"6d02221457bdebb0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/CreateWorkspaceDialog.js\":\"653c54ad29a7275c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/PendingInvitations.js\":\"d9d6df4d45ef7e38\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/SyncProgress.js\":\"91bdf70bd449ec5a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/UnlockProgress.js\":\"254865a93ff888e4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceKeyGate.js\":\"104ddbdec4b5be43\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSettingsDialog.js\":\"b42ae53dc1305af1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSwitcher.js\":\"21b538b702a69236\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSyncGate.js\":\"0626dc166461febe\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/ConversionFlow.js\":\"74aa2340a267c9fc\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/ConversionFlowHost.js\":\"1a6ad35b616ef25f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/EncryptionSection.js\":\"d61f1aacb8f20bbc\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/attachmentPrompts.js\":\"f4415b008db042a1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d7d28cdd91185733\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/conversionFlowDeps.js\":\"73be51519bb9f72e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/conversionFlowStore.js\":\"f49e4d5b43d9f8bb\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/flowUi.js\":\"bd3a5c5a267a6404\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/useConversionRun.js\":\"89bdf65309e42939\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/keyUi.js\":\"4096d4322e823d91\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/useCloseOnKeyLoss.js\":\"9093efb498369edf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/useCloseOnServerE2ee.js\":\"2b2a2308f2e17254\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/workspaceUnlocked.js\":\"2d97c0833d0f401e\",\"/knowledge-medium/pr-preview/pr-1872/src/context/backgroundSubtree.js\":\"bc5d4ec660ab303f\",\"/knowledge-medium/pr-preview/pr-1872/src/context/block.js\":\"1d6180322bd98ece\",\"/knowledge-medium/pr-preview/pr-1872/src/context/layoutWsContext.js\":\"1ac38eec886086b1\",\"/knowledge-medium/pr-preview/pr-1872/src/context/propertyDisplay.js\":\"5f4d365fddba633e\",\"/knowledge-medium/pr-preview/pr-1872/src/context/repo.js\":\"2a926cebb2653273\",\"/knowledge-medium/pr-preview/pr-1872/src/data/aliasClaim.js\":\"82cbb5d90971f4d8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/aliasSeatNamespace.js\":\"fb2b2e67da2822ac\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/blockData.js\":\"2d76dcbb3d562fa6\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/blockType.js\":\"9a35aa2ec47ba134\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/changeScope.js\":\"59bfb49cae63e00d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/codecs.js\":\"d270835bb904a155\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/derivedData.js\":\"b2fbeaa3960f09db\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/errors.js\":\"4f0a93c66fd34918\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/events.js\":\"bb7ee453e56522cb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/handle.js\":\"8d7c438088c5368a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/index.js\":\"49dc891ae4a3774d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/mutator.js\":\"4f29e1a1a1616e4c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/processor.js\":\"b03b23c911b21bbd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/propertySchema.js\":\"0c7bf4f76104f94d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/query.js\":\"dbf51e232d674f4f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/sameTxProcessor.js\":\"2beae86710053a53\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/schema.js\":\"8d7c438088c5368a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/tx.js\":\"8d7c438088c5368a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/typedBlockQuery.js\":\"35723de05a42b4ad\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/user.js\":\"83d4f61b167163d1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/valuePresetCore.js\":\"5fef21e9e0f91035\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/valuePresets.js\":\"566b35ab1bcb15ad\",\"/knowledge-medium/pr-preview/pr-1872/src/data/attachmentCleanerIOVerb.js\":\"b69673ba27679e7b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/block.js\":\"99c9433fd92f2123\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockCache.js\":\"5e4b7526a1e64930\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockId.js\":\"34da9e4b10b88907\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockLiveness.js\":\"21168088f9770ecc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockMerge.js\":\"5d47204a1d9837f1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockSchema.js\":\"0f9fd0d153d47559\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockTypeLookup.js\":\"8efbe4898388cb93\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockTypes.js\":\"dca71c31eb02f638\",\"/knowledge-medium/pr-preview/pr-1872/src/data/childrenView.js\":\"60c5f54ec1a85897\",\"/knowledge-medium/pr-preview/pr-1872/src/data/clientContext.js\":\"8f9d0d0aba1d0c40\",\"/knowledge-medium/pr-preview/pr-1872/src/data/dbFileSiblings.js\":\"7cd75fc8f1b0ad72\",\"/knowledge-medium/pr-preview/pr-1872/src/data/definitionSeeds.js\":\"f4a588e534c4c6a4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/derivedIds.js\":\"863da3e1461134cc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/drawnSubtree.js\":\"97d84a02538e51bd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/facetBridge.js\":\"5d46246bcee7039d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/facets.js\":\"ff3d08c202f87186\",\"/knowledge-medium/pr-preview/pr-1872/src/data/globalState.js\":\"9fd4bba17371c88c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/aliasClaimRederiveProcessor.js\":\"3cec87134b108257\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/ancestorBatch.js\":\"febacf9144bea6e3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/blockTypeTypeifyProcessor.js\":\"f1549345276eda27\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/clientSchema.js\":\"9b4e640673cb4d87\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/commitPipeline.js\":\"c196dee7d2bddb6b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/devAssertions.js\":\"d838f0f5267c8ce3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/firstSync.js\":\"a45437036cd4f79d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/freshInitialLoad.js\":\"0c70d6f290f170fc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/graphBackfillClaim.js\":\"4f2b62baa831d4c2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/handleStore.js\":\"5e0793248f0f328e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/idleMarkerJobs.js\":\"1caaacd2be832127\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/initialDownload.js\":\"be0ee2dae5a9dbda\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/initializeClientDatabase.js\":\"b7106e47ba57b8fb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/jsonCanonical.js\":\"9c147185c22143f8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelInvalidation.js\":\"567cd092565e81a1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelProcessors.js\":\"7573320e143fd6a3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelQueries.js\":\"241a5856f185d604\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/mergeTypeMembershipProcessor.js\":\"ad8c9cbadd86ba98\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/normalizeReferencesProcessor.js\":\"30e2a43e232bbff9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/poolInstrumentation.js\":\"313ed8a9fe65d485\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/processorRunner.js\":\"9728440f520bb641\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyCellBackfill.js\":\"b31ec8634f9b54a3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyChildMint.js\":\"8d527a9bff6a71bc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyChildrenProcessor.js\":\"9491a84cd4108add\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8026414f674e360e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyDefinitionSynthesis.js\":\"690a550efb17c92c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyKeyScan.js\":\"f2d4bc264bcd7215\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertySchemaResolution.js\":\"8f7dd4960e53ca43\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyValueEdits.js\":\"370a70979b402f8c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/raiseProtocol.js\":\"713df715324e32d1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/readBatch.js\":\"02d837caac8a18b4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/refProjection.js\":\"63e4cdbb51a20be7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/referenceTargetLookups.js\":\"c88b4fd090ad2c3f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/referenceTargetProcessor.js\":\"bb1b5fdcfd09438f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/replayMerge.js\":\"130cafcdc512c642\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/sqlBinds.js\":\"72b53a7920453d6d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"bbf03a358c89d3d9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/arrivalProcessors.js\":\"02dd2a5409645c6c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/invalidate.js\":\"2b308ef407cfabda\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/materialize.js\":\"8ccf15f4b5197883\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/observer.js\":\"c4261c5ab58372bf\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/reconcile.js\":\"6413519e2e0bfd97\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/timingMetrics.js\":\"505b35eeb1c9f7af\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/treeQueries.js\":\"af3c6ba40f171e4e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/txEngine.js\":\"0e948858748cf2c9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/txSnapshots.js\":\"1893ab6ff19429ae\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/typedBlockQuery.js\":\"0a4921baa0d76635\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/undoManager.js\":\"b39e3d28e82f40ab\",\"/knowledge-medium/pr-preview/pr-1872/src/data/invalidation.js\":\"e09f49f2098ba448\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelDataExtension.js\":\"63cd51d15a9399dd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelPage.js\":\"640b3b1da041f8f3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelValuePresetCores.js\":\"3378fd41cc433d41\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbCorruptionSignal.js\":\"79e3828cb720d3ff\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbStorage.js\":\"ae4c9d776278f781\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbVfs.js\":\"d04d62ce50232622\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localSchema.js\":\"db3893e06005d1b3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/maintenance.js\":\"fd5ac7fbeb51390e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/mergeProperties.js\":\"55d021624d0f1fa4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/metricsConsoleHook.js\":\"6a0c13f4902d18b8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/migrationsPage.js\":\"4230f0573784a825\",\"/knowledge-medium/pr-preview/pr-1872/src/data/mutators.js\":\"a67a871ea25d1f82\",\"/knowledge-medium/pr-preview/pr-1872/src/data/orderKey.js\":\"0eb026dca3649c1c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/orderKeyPlacement.js\":\"dc792b5d99e08ed4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/outlineSurface.js\":\"0b21cfd043e89e47\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pendingEditorContent.js\":\"b9fb0d7112da32f3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pendingUploadsSql.js\":\"23e0284e8d8a2447\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pluginStateExtensions.js\":\"0d7889d97ee74d4c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/powerSyncLogger.js\":\"788b6534679e8fdd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/projectorRuntime.js\":\"f097bc9af60264a4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/properties.js\":\"225b2bddd31c9193\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertiesPage.js\":\"468a2660680739d5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyChildren.js\":\"32169dba12af2242\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionFanout.js\":\"14b64e0070144e3a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionMetadata.js\":\"396af504af799c3d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionRegistry.js\":\"94e9d821e0380ca8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDisplayMode.js\":\"d7661c2d5f9d7dbd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyRowCreation.js\":\"496a7946b83f2dba\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertySchemaCreation.js\":\"e3e5ebf25082b771\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertySeeds.js\":\"33f9a1ed802618c3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/recentsPage.js\":\"8d1568d6aceaf85e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/referenceBlock.js\":\"dd4674146e2286f8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/rejectedUploads.js\":\"b3e1dd68e41b5698\",\"/knowledge-medium/pr-preview/pr-1872/src/data/releasePowerSyncConnection.js\":\"3a064cf96763e5ec\",\"/knowledge-medium/pr-preview/pr-1872/src/data/repo.js\":\"e27eefab89915ef6\",\"/knowledge-medium/pr-preview/pr-1872/src/data/repoProvider.js\":\"12b89fc33e8ec9d0\",\"/knowledge-medium/pr-preview/pr-1872/src/data/rowProperty.js\":\"cc87d17816afc652\",\"/knowledge-medium/pr-preview/pr-1872/src/data/searchFilter.js\":\"a78159c6145d8913\",\"/knowledge-medium/pr-preview/pr-1872/src/data/seedIdentityLedger.js\":\"b7992281870fc30d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/stateBlocks.js\":\"7d010807c7b0b21f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/structuralEditPolicy.js\":\"d1a2286f3eeac0c0\",\"/knowledge-medium/pr-preview/pr-1872/src/data/structuralInsert.js\":\"9cdcf50c45ae9364\",\"/knowledge-medium/pr-preview/pr-1872/src/data/subtreeDelete.js\":\"3ae9773f401e5c1e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncStreamLock.js\":\"6d0050690c1edbc9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncedTableSqlRecognizer.js\":\"27668991a690b1b2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncedTableWriteGuard.js\":\"f401d2732d2725da\",\"/knowledge-medium/pr-preview/pr-1872/src/data/targets.js\":\"7568d59fa75b2505\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeColors.js\":\"394e0243b4831ec1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeDefinitionMetadata.js\":\"4f2c4b2ac084fff3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeDefinitionRegistry.js\":\"925bb3fa68bfab75\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeExtraction.js\":\"96b16fc2ad04c38b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeInitialValues.js\":\"c466cf000093e050\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typePropertyGroups.js\":\"24cf96a60d284471\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeSeeds.js\":\"3f84d81fd5caf488\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeTagger.js\":\"b1b01dcb530b951c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typedRecords.js\":\"38679e1d49a2a057\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typesPage.js\":\"b0bb1b88c97c8fe4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userPrefs.js\":\"9c43434d78c9cb1a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userSchemasService.js\":\"d92d66556b3e7b1b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userTypesService.js\":\"b063b61102e76ddc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/valuePresetRegistry.js\":\"caf9b12b15d987f5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/visibleChildren.js\":\"1a2f5aadfc5cf272\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceConversion.js\":\"aea462e60bba627c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceFirstSync.js\":\"06a270178727300b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceIdNamespace.js\":\"ac1a834fd85f0675\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceSchema.js\":\"5dd13a76ae2fddbb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaces.js\":\"9a4d15db19afd204\",\"/knowledge-medium/pr-preview/pr-1872/src/data/writeAheadLog.js\":\"6db3c5e61f4165c1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/BlockPasteShellDecorator.js\":\"03fd8a4deaf3ea33\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/atTrigger.js\":\"fe22e07dfef59078\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/autocomplete.js\":\"603b9fc2b83bb1d9\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/codeMirrorExtensions.js\":\"60ddeff0bd2ddeed\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/contentFlush.js\":\"38bebe1deba190bb\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/defaultInteractions.js\":\"9e3c1f44eb7e081c\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/editSettleSignal.js\":\"e06da29bb12a5efa\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/insertImage.js\":\"e573620187ce1507\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/referenceCompletionRange.js\":\"214d00f672584375\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/referenceTargetTypes.js\":\"12ffb5f72b85a5da\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/syntaxContext.js\":\"9e51d870d84c925b\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/triggerMatch.js\":\"47b1b3d229f9fc53\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/AppRuntimeProvider.js\":\"a319058f3e72f53c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/BlockFocusShellDecorator.js\":\"35eb734548dfb9d8\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/ExtensionRenderBoundary.js\":\"4d54bb187516cf00\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/PanelContentRecovery.js\":\"18c2e38243651b1c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/apiCatalog.js\":\"e8c59136c73b6970\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/approveExtensionHere.js\":\"ef717c48b8ec6e1d\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/armedCutAppMount.js\":\"89410cd1d0c8944b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/batchableKeyedStore.js\":\"5bd988a18dc30ef0\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/blockInteraction.js\":\"70bf7a91fe7c0925\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/blockSelectionAction.js\":\"6800dd7a6b9fa09a\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/compileExtensionModule.js\":\"56a7a5aada93146b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/compiledModuleCache.js\":\"12c3f47351481c57\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/continuousGestures.js\":\"6aa358a5433ef928\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/core.js\":\"8ae60fd2a0dc4705\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/defaultRenderers.js\":\"75b17b84f7b01ecf\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/definitionFanoutAppMount.js\":\"c03fe9612ad5aeb5\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dialogAppMount.js\":\"2c57a092357b86aa\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dynamicExtensionSeeds.js\":\"419afae666abc686\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dynamicExtensions.js\":\"cbabfdb5a1769496\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/exampleExtensions.js\":\"c608582728bfa38c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionApprovalStatus.js\":\"6fa9e4b58afa4272\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLoadErrorToast.js\":\"edbb857b7f989ce0\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLoadErrors.js\":\"609a516a8f983327\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLookup.js\":\"d01fa4e25bb3758c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionToggles.js\":\"6f8b12cb390c98f8\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionUtilitiesCss.js\":\"8b1c04167d92a559\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/kernelPageDeletionGuard.js\":\"cdb7e736eceb2391\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/liveRuntime.js\":\"178ab3e8c974b71f\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/openExtensionsSettings.js\":\"10d833d63201423d\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/overridesCache.js\":\"f9983085c8458a5b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/pluginIds.js\":\"8af89370731c04e7\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/processorRejectionToast.js\":\"e0c3ea57e5938e36\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/runtimeActions.js\":\"b8a6d17e876ee07c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/runtimeContext.js\":\"bd7aa6dcfb10d63f\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/staticAppExtensions.js\":\"04e6e177ac25e22c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/staticDataExtensions.js\":\"1456894c9b907f94\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/toastAppMount.js\":\"b208de5d9e388abc\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/useOverrides.js\":\"992fd9e8d9248aac\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/useShortcutSurfaceActivations.js\":\"ee557f1f9357f949\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/discoverToggleTree.js\":\"36309bc0d0e739c2\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/facet.js\":\"321a14222c8c6d80\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/resolveAppRuntime.js\":\"5f1ed46c0fc1e274\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/runtimeEvents.js\":\"1bbc1b5754512eb5\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/togglable.js\":\"e62f5b40536e53d6\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/variantFacet.js\":\"7294975fcb7a39ab\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/verbFacet.js\":\"c81d167fd2957b39\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/block.js\":\"80aa8b6e5459547a\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/focusedChild.js\":\"6d8d6ac335c8b047\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/propertySchemas.js\":\"c7629b731e83f50d\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/typeRegistry.js\":\"7a19443f41bc790a\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useAncestorCrumbs.js\":\"229ec32529b2276c\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useAutocompleteListbox.js\":\"c2fbd7c3d26f4bd4\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useDebouncedSearch.js\":\"ac7e80cd32d733c0\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useDebouncedValue.js\":\"52716972b464048c\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useIsFocalRender.js\":\"7bae9bcad9af7117\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useIsReadOnly.js\":\"3237203635e6eae4\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useMaterializeBacklog.js\":\"2fc9ab417c34559e\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useMinuteClock.js\":\"963c6b21b6ad42d1\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/usePanelLayoutProjection.js\":\"8d462ea68e7a1851\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/usePendingInvitations.js\":\"307d3dbf6e4c9b79\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useRendererRegistry.js\":\"62f376c4d63bf23f\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useRetainedFieldRows.js\":\"89acd8d6c20ec233\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useWorkspaces.js\":\"0c5de066baae7e28\",\"/knowledge-medium/pr-preview/pr-1872/src/lib/utils.js\":\"b2254f803938dfc7\",\"/knowledge-medium/pr-preview/pr-1872/src/main.js\":\"e8a5bf38e22f600a\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/MarkdownImage.js\":\"46a7b9cc807e7ba6\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/blockSeparators.js\":\"9004eb02ec864508\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/context.js\":\"3dbac55d28ce1299\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/defaultMarkdownExtension.js\":\"9d5ee774bc69e673\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/extensions.js\":\"2dff83c9efbee799\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/renderMarkdownHtml.js\":\"ad2a76f8c3c29fb6\",\"/knowledge-medium/pr-preview/pr-1872/src/minimal-editor.js\":\"922b5c08a98af755\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/armedCut.js\":\"41d82b09867525bc\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/captureMediaVerb.js\":\"46ca454dd9da0c6f\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/clipboard.js\":\"9c653c620e9e8cf0\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/decision.js\":\"a1291eba2b33d9d5\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/operations.js\":\"2d5cc403d34145fa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/account-header/AccountHeaderItem.js\":\"4d1197864b4dd8c4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/account-header/index.js\":\"e6c0e2ebaffbb17d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"01cbbcf26587874d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/askAgent.js\":\"d55e9408803abc2a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/askedStore.js\":\"6277deeb02684a36\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b9cee4c5a9950e27\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/chipState.js\":\"1e08b4ad86e99137\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1da1f9d43ba99869\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/index.js\":\"136f4f2928f72cfe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7dc35e8614bc17ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/schema.js\":\"4bf8fbdfb94aa4cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f19d9a54ace84aea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2b3f8ae4d049fa19\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/addMedia.js\":\"90d16039ace8c74c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f7db621216fa9b49\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/block.js\":\"d3389c6ed36477e4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/context.js\":\"b2217b448da30b28\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/displayIds.js\":\"267ce4bdd29ec8d9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/index.js\":\"72e8b334c7246f4e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/outline.js\":\"108414b4b7c5e8ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/properties.js\":\"ed8e8e0ce08ff841\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/refs.js\":\"0c8a208385f44e18\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c9843f8c79a1e83d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/search.js\":\"4bbab6d13e372122\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/shared.js\":\"273d8b2214d39d66\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6245a2a983155c7b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/text.js\":\"6dca29fa42dbc2a5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentWrites.js\":\"ba31488ceccf1291\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/authoringCatalog.js\":\"c94a0a0971cee677\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/blockRefTargets.js\":\"d6b8bdf4f01f0f7f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/bridge.js\":\"f649d19fb9a95523\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/bridgeLoop.js\":\"27fb744cfafd9240\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/changeHistory.js\":\"0c15555a9f7c3dfe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/commands.js\":\"48c22a6092cd1608\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/commentsCommands.js\":\"c6b3ea6651d41aba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/dataExtension.js\":\"1c630d91d5d18e23\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/dataModelGuide.js\":\"463bb7451b912171\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/describeRuntime.js\":\"4c22cf943c5e2bc7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/extensionLint.js\":\"324b1321b94b1ea1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/grainAudit.js\":\"3c2620b31dee0f5f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/healthCommand.js\":\"198fca2f7f031cfa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/index.js\":\"ed5839c97cd5fe9f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/presetIdentity.js\":\"628704045f0e965e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a32a5f2e64697fdc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/readMedia.js\":\"fa945ee5c6eedb58\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/schema.js\":\"b5518d4fa8a5a874\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/serialization.js\":\"8b0b45f4f0ad9083\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/targets.js\":\"99a72081fc3ea0b1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/tokens.js\":\"be24834b4bde8063\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/watchEvents.js\":\"0ba4461adaea029e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/workspaceGuard.js\":\"3e9d22c6701cbded\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/writeCommands.js\":\"f5a19854968b381d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/AliasCollisionToast.js\":\"3a997f154bce8e45\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/DuplicateNameBanner.js\":\"517378045f2bc8aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/collisionMerge.js\":\"7f4da8b2f5dff096\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/dataExtension.js\":\"f32a79f97183ac2c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/index.js\":\"077ebde9794f87f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/mergeCollisionAction.js\":\"19c931e647b0edf0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/pageStyling.js\":\"0ed05c74712009f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/rejectionToast.js\":\"7e4b863986ec65c6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/syncProcessor.js\":\"8c58fa3e342805ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/actions.js\":\"20497f90ab7704db\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/addComment.js\":\"98738ee81544aa14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/anchor.js\":\"fe4905c92f7d89b9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/anchorState.js\":\"74594bdc4eb0a785\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/commentLinks.js\":\"22bb6250bb35dc1e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/confirmThreadDeletion.js\":\"655091530243acda\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/container.js\":\"10db1311cfce9321\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/dataExtension.js\":\"edbaf081c3df2852\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/deleteComment.js\":\"64cbaa22932e0a86\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/highlights.js\":\"68245a5c8e953e04\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/index.js\":\"6d67775ab535bed7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/linkedCommentsPill.js\":\"15dca9b225d11edd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/margin.js\":\"9bea186f3c786434\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/marginSchema.js\":\"d8f6266d498040ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/newComment.js\":\"4e806a514a40baff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/ownThreadPicker.js\":\"2f0907d732d85438\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/placement.js\":\"a088698ab2b19f6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/queries.js\":\"41a4382d0698afb5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotePosition.js\":\"fa3a3b8783f61469\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotedIn.js\":\"85dfc7c4d3e1fb8a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotedRange.js\":\"9a8e6cd103174e13\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/rangeRefs.js\":\"808f020368ec28dd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readHighlights.js\":\"30ae1a2a442b1550\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readSelection.js\":\"c4a8b0cb289d66dd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readSelectionUi.js\":\"7cf7cb4ff2adf468\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/reanchor.js\":\"8ae78a9c2047f520\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/schema.js\":\"655d1395f8aa1f3b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/scope.js\":\"19a9308042a7cece\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/scopeThreads.js\":\"8f9fe93c35c6574b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/splitRetarget.js\":\"bce81003aceb40c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/suggestionCard.js\":\"bedf371c269c2977\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/suggestions.js\":\"2cef2b9b0ebbbff1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/summaries.js\":\"c0533a83f1261b8e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/summaryBatch.js\":\"66287311d451dcd9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/surface.js\":\"ef12b808b52d27c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/threadNavigation.js\":\"1c47fbe24dc0f5dd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/threads.js\":\"c0877ffe95e90d99\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/ui.js\":\"775733dc8e526058\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/uiStore.js\":\"02850f921977dab5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-intents/appIntents.js\":\"370f5f81a9036ceb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-intents/index.js\":\"da51d9e9b92e64db\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-update-prompt/index.js\":\"ab24180df5f1dbbb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-update-prompt/status.js\":\"e4e8bd6c5f4d9cb7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a8786eb520c63c71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaBlockRenderer.js\":\"a1e04b16bec373c9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d0161b412db41b9e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaUploadReconciler.js\":\"99f26bc34d978705\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetDownLane.js\":\"84f3d65ff8eba0d5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetResolver.js\":\"ee16904b62cf84f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetUpload.js\":\"8515f66ac70dd490\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/attachmentCleanerIO.js\":\"501bff146df0a011\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c18c69882dea0900\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/blobStore.js\":\"610f8fbc71075de3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/browserMedia.js\":\"aebfbe69ca965c44\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/byteStore.js\":\"2f781052f0ee7bd3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/cleanerIO.js\":\"38bf7009f19bbfa4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/cleanupAttachments.js\":\"c4ad1870c82aaf45\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/dataExtension.js\":\"6d52608e23268035\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/downLane.js\":\"dadfa34abcaa3632\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/index.js\":\"b1ac83cd81214133\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/insertImageContribution.js\":\"6384b2e185ade359\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/laneArming.js\":\"9d888570e665aa0b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/laneLock.js\":\"d9bff5a8d6c06afc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaBlock.js\":\"36f50c4f48072d45\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaCapture.js\":\"dcf8715476f32ec1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaLanes.js\":\"90525075b9b85019\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaViewers.js\":\"6cb5503e8de44956\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaViewersFacet.js\":\"32556b4420a26596\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/pasteCapture.js\":\"1df6a8ccfded0860\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/resolver.js\":\"d5518dc2a27ec20c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/retryUploadsAction.js\":\"d28bac130fc5ffe6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/storagePaths.js\":\"5f1c070d0c996f9f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadDrain.js\":\"1fd1c6b6e9680391\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadLaneStatus.js\":\"a834448fdfd9fe47\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadReconcile.js\":\"ee2aa346c92411f5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadRecovery.js\":\"87e370d6dddc13a2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadStore.js\":\"17791b700f0483da\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/useAssetObjectUrl.js\":\"4c1c40077dd3919a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a30d16d415cffabc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ed7668cc55ab84f1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/facet.js\":\"5ef8c2c8061a1c7e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/index.js\":\"9876ef6f9ecceae5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/prop.js\":\"640f5e4d1914e35b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BacklinkFilters.js\":\"a6aed8e40a8aa483\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d27c0526065bc984\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BlockEntry.js\":\"b18d8ffcc82ff203\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/LinkedReferences.js\":\"058ef092c026e235\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"30ea069281b17a8f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/dailyNoteDefaults.js\":\"21cc0fdea90db052\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/dataExtension.js\":\"697345d080f5a794\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/edgeExclusions.js\":\"25c70f3db0b345c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/filterProperty.js\":\"2eb0a8ae431a7ab4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/index.js\":\"9878994fe4ac5879\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"019c1274a468c753\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/applies.js\":\"57d8d73803f4c5ef\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/countQuery.js\":\"a9e51cbd5d848efb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a29224887f59d584\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/index.js\":\"8b8c9233a9f65c9e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1be7c2713f16b9be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/presentationInvalidation.js\":\"600124e59b08f28c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/propertyEditorOverride.js\":\"dde70734e2d57d6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/propertyFilter.js\":\"a308fb5ea364f166\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/query.js\":\"668a7ad78b099f6a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/resolveFilter.js\":\"8188763ad2a7112b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/sourceBatch.js\":\"d18d6c41934638d8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/sources.js\":\"2e1c8af748278e33\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/useBacklinks.js\":\"e0298b68fe738f38\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"23f2250db60d9075\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/BirthdayCelebration.js\":\"d3388640ecadf3f1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/BirthdayOverlay.js\":\"10a6c04be13844b3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/gate.js\":\"eb68f6130a86ebe3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/index.js\":\"f36eb9dadaba9593\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/wolfTheme.js\":\"04fdab77db91c42d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/BlockDragLayer.js\":\"95509df0e6f4af34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/dragController.js\":\"846bc7e3d4fd4434\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/dropTarget.js\":\"33262405b793aeaa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/index.js\":\"43aed90e8db5d2c8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/projection.js\":\"6eadacf7984311da\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-info/BlockMetaCard.js\":\"ec6c2d8cc278328e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-info/index.js\":\"f4d3b792a81b58e0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/AddTagDialog.js\":\"6c6a0b81e92f5463\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6786699fd270eb4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/TagNameIssueHint.js\":\"b67cecc747610d6d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/addTagAction.js\":\"88b18d4197f904d1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/appendTag.js\":\"e7d670673674d406\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/config.js\":\"97dfedc2022396ce\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/dataExtension.js\":\"e3c7715eb1499a82\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/index.js\":\"1d0d5e7172bdfe3d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/propertyEditorOverride.js\":\"c84959a8180619f1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b9f1a6bb279385c6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a93c88ac33e2f221\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/Breadcrumbs.js\":\"41ac950205f90310\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8be59ea10dc4ff71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"46694b1523d077c6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/index.js\":\"381db3083a5d59c3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e76f9fbcfdd059c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/CharacterCountItem.js\":\"3c5d6fb0cf187563\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/ProfilePropertyEditor.js\":\"491c96bca965591c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/actions.js\":\"9905a27f8762e141\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/blockType.js\":\"c82853eb746f3a35\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/charCount.js\":\"b7951e1972370ad5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/dataExtension.js\":\"550697c2e0277aa3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/index.js\":\"ead944baf5e3717e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/profiles.js\":\"1c7772329e314d50\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/properties.js\":\"a82a07783a62481b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/textCounts.js\":\"42e4b62432a8182f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/colemak-keybindings/index.js\":\"adf992b49e61d1b5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/CommandPalette.js\":\"7b90236347ae2b4e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/HeaderItem.js\":\"b84fd9d22827c789\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/context.js\":\"bbefd9c3a9af66ff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/index.js\":\"59f83883350b6fcf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/selection.js\":\"d866313386070b83\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/toggleStore.js\":\"b8c776f3db746095\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/useCommandPaletteActions.js\":\"c90e0c4077595b23\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/ContributorBadges.js\":\"3fea9e874f4bf597\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/author.js\":\"0b6b27ab5f1e9f11\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/codeMirrorExtensions.js\":\"e973a4e6f0d1e699\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/dataExtension.js\":\"ede02f9d10291b36\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/index.js\":\"45ea5c5c0d88c1b0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/mentionAutocomplete.js\":\"b8a5e5ebebc01c07\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/processor.js\":\"0ab87e5e1f58a08c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/profiles.js\":\"b2d39a2dfeaf03b7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/queries.js\":\"165b6e9471aaadc1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/schema.js\":\"e7afd9b245af0ac3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"416e5179e4b0d062\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/followOrigin.js\":\"968f110ba2fabf59\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/index.js\":\"1ecab7c282cf9a26\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ce0fffc2387b1dfc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"851670ca2efb3cd7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/CalendarGrid.js\":\"80cdb62d2c0783f4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DailyNotePicker.js\":\"e2a98f637fb29541\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e7486ec75116e75f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateNavDecorator.js\":\"30c2d29021206ece\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateScrubOverlay.js\":\"fd80ecaae21cf3d2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/HeaderItem.js\":\"00ac5aeb043a494c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/ReschedulePicker.js\":\"7d1056b596bdefae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b6be360352f5a4fd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/actions.js\":\"4c9951b5acda72d1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/blockDateAdapter.js\":\"24ab5abfe50e6199\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/calendar.js\":\"09277c6f2fb1507f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dailyNotes.js\":\"ec8c733a93e17ac8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dataExtension.js\":\"a779befd1e4a4446\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubActions.js\":\"ab16671d93f4f9f9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubGesture.js\":\"00ddbea7674982f9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0bc31d34d4796f59\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2180a38231d77acb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/deletionGuard.js\":\"8ff0280ede9bcc03\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dueQuery.js\":\"9a321d92c15fc803\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/index.js\":\"5a1d3ac38c93168f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/landing.js\":\"3aa77a313ea8fcdd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/localSchema.js\":\"93c416d6b6cb1090\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/referenceDateAdapter.js\":\"9c735eb5dfcfe234\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/rescheduleAction.js\":\"e22bdc184f7795d9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/schema.js\":\"6bf5c085d8c76e89\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/spreadBlockDates.js\":\"16865447d5e25cfa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/spreadDatesAction.js\":\"e5fb002373a48f5b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/today.js\":\"53728debd7144944\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b1ecad71bb71a96d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"af8d78ac0ecd7a54\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/audit.js\":\"49797f87e4c142af\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/auditAction.js\":\"d248cda0f7a65aa2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/auditRanges.js\":\"bf9d4c71892bc0b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/diagnosticsSource.js\":\"61f1b705ef994a2f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/divergenceScan.js\":\"a24e1115451844d1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/index.js\":\"2d3af0e8a710ea7a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c1d1c24e4ef37fa6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/referencesMirror.js\":\"4d4f54af1451bd21\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/rowJson.js\":\"c2dd66446eecb8e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/schedule.js\":\"b4a9ae98ee3ebfbb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/store.js\":\"43d96f0f0ffe9fa9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/action.js\":\"dd7a3a0c2929f0b3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/index.js\":\"4c9bbdb151788c35\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/plugin.js\":\"cb1c7ed8af686f63\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6142049c776ff8f9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/actions.js\":\"9ab10dd08d5691ac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/changeMarker.js\":\"40b854d6f7d6e1e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/diagnostics.js\":\"809979c4dfbb0cb5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/fileSystemAccess.js\":\"0fdba3194bf23b3a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/filenames.js\":\"ed57f402d1ec2b46\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/index.js\":\"e24d4b6ffd40175b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/mirror.js\":\"1b11399ed03896ff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/runLock.js\":\"cde42005254f4a1e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/runtimeHealth.js\":\"ecdc7f7ff1f3c68f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/schedule.js\":\"95147f4f47c83005\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/store.js\":\"e83a394fcfea9e84\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/default-themes/index.js\":\"7e48cc0d1b9f0286\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/default-themes/themes.js\":\"69bfdfa28d95761b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/diagnostics/facet.js\":\"a1f35abd413cdf46\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/diagnostics/useDiagnostics.js\":\"ab807c661e916756\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/dismissals.js\":\"be448072a97ffa04\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/index.js\":\"3d31c5475af50cee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/status.js\":\"930f47c9a055b595\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/store.js\":\"c20be87f21020193\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c12b1ed51eaa39d0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e345af9c8a87ab6e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/actions.js\":\"7aafdf8eb566b8b9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/config.js\":\"6ab2433164081437\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/dataExtension.js\":\"63669afc9cdf9c62\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/effect.js\":\"2f72633b5e4e2a52\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/index.js\":\"71c4ca513eac65ba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0bcbf5c5a7a5b846\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/useToggleTree.js\":\"fec794f856a943a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/ExtractTypeDialog.js\":\"735e6340a7aca09c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f8e7f15f96b9ad83\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/PropertyShapePicker.js\":\"5641f1f845debc74\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/action.js\":\"501d2cc95ca689e5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/index.js\":\"15ccad9de168d75c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/FindReplaceDialog.js\":\"e8aced312b668433\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/HeaderItem.js\":\"fe1ad833ac73161b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/dataExtension.js\":\"372d58b4cb6c527f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/index.js\":\"5c152e42f2a5be24\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/search.js\":\"2c3a8f2e52401e05\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/toggleStore.js\":\"5c4509bcd2b9f2c9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/LocationPropertyEditor.js\":\"8bf62e74453c4b68\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/MapView.js\":\"7b3cdc12bc399199\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/blockTypes.js\":\"e7ddb55ce2bf9d32\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/codeMirrorExtensions.js\":\"862daa9c20f6defe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/createOrFindPlace.js\":\"6329270dcf9e119c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/currentLocation.js\":\"c6dfb49c21ea8564\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/dataExtension.js\":\"3e31e746a688d6d2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/geoContentDecorator.js\":\"047f73fb44a560c0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/googlePlacesClient.js\":\"fa21e2eb5c6709a6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/index.js\":\"45a5e6a5317a67c5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/locationsPage.js\":\"ed107e76ac95fa8f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/mapViewport.js\":\"8036e628367cb025\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/pickCurrentLocation.js\":\"88891f143ca49c8b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/placeAutocomplete.js\":\"5a8f765de254c9ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/placeNameCollision.js\":\"68bc17850bcb4c7b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/properties.js\":\"7bfd21e459e71d8c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/propertyEditorOverrides.js\":\"e4d898db064d2b5c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/query.js\":\"9d2021c8ab775e21\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/usePlaceSearch.js\":\"696ccc2a390a39c0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a837bab87ba703e0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1980d2a96fd9896a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"34e637481821a832\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/config.js\":\"519261cd4ba4fb56\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/dataExtension.js\":\"e1f345daf5055667\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/facet.js\":\"dd1920f9e9734cb8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/grouping.js\":\"71985bb6973f49a5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/index.js\":\"4252c09e04d80c08\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d8b146bd86607f9c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/query.js\":\"1cfa24cf44816918\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/resolveConfig.js\":\"5532ed1da4862a40\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8d3fa9330bce42d4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"73fac9f5f263c133\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/HtmlDocumentContent.js\":\"e4558d60693f759b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/HtmlFrame.js\":\"f5ccc94a86c4a865\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/actions.js\":\"ee6f3aed550dd50d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/blockType.js\":\"81aabf339a414534\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/confirmRunScripts.js\":\"5ae7c6fd1ececfe7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/dataExtension.js\":\"d877c5c055020969\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameAnnotations.js\":\"db3be04d182f3afd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameDocument.js\":\"56b7d78504ed7610\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameTheme.js\":\"98f572ef1ea4e52b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/index.js\":\"b6e22235965562ed\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/scriptConsent.js\":\"d703e0016efc700e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/sourceMap.js\":\"f46b60d197c11cb7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/useDocumentScripts.js\":\"71e4b92ea1ad9d6d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/index.js\":\"e8adfa75dd496d25\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/record.js\":\"6583591c62c9d6e4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/recordStore.js\":\"15745f8b92be07cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/responsiveness.js\":\"60bc0b5785a18e77\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/schedule.js\":\"3782751aea8c7de9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/sessionContext.js\":\"2f5feb70d6eff79a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"455b307b31c4ef35\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"896a308ed838ce5b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/actions.js\":\"2dc544b0bc6ce8b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/config.js\":\"936bc7011ef9ce82\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/dataExtension.js\":\"7ede28597210e12e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/effect.js\":\"3d59675c81343170\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/index.js\":\"881ed4c1cac49304\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/keyCapture.js\":\"ca54dab98374ea3a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/overrideStore.js\":\"e6091dc1affd89da\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"98f87361b8035181\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/HeaderItem.js\":\"387ab5a597b92b25\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/LeftSidebar.js\":\"dcb298dcbbddb20f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/actions.js\":\"3d85505f6fae94f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/facet.js\":\"96fbcba1b88e5a0b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/index.js\":\"c8b7049e0f840285\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/shortcuts.js\":\"f5fb770ef31f4c65\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/toggleStore.js\":\"4d20ede9a4853217\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/MergePicker.js\":\"acab5c4465405aa8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/index.js\":\"232e39dada04c63e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/mergeAction.js\":\"b5a1dc3f182db2c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/strategy.js\":\"30c07ada307fecb2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/Button.js\":\"5e11bfac8b355bd4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2c12936490ab4b3f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/defaultItems.js\":\"579768836f957ea2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/facet.js\":\"a36d63c60eb4056c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/index.js\":\"da2cc621fde191aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f0a7b8852e20598e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e844a99858439adc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3eefb43ff13a2361\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/facet.js\":\"230bd273d3af11c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/index.js\":\"f531014f7efb2d0e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/MoveDestinationPicker.js\":\"607b49e5d4d82954\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ea69f146cb1c8707\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/contextMenuItem.js\":\"130a22b721e728bc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/index.js\":\"11c0840f5322da6d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/moveAction.js\":\"705178b2f6c550e5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/moveBlocks.js\":\"7d99f3bde61e2216\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/selectionAfterMove.js\":\"713d9ec264551414\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/TutorialBanner.js\":\"56ebda344dc61502\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/action.js\":\"a6719fdaf1b9871e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/bannerDismissal.js\":\"c0dc33ec6622ad37\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/documents/cheatSheet.js\":\"9008f283bbe336c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/index.js\":\"b5a7838b53aa5fd9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/keys.js\":\"dccfb97efce45914\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/landing.js\":\"e814f376343d0e6d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/outline.js\":\"205b1560df41dd64\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/seed.js\":\"1a7cf9398f1857e2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/PerfTrendDialog.js\":\"593c73866556fd1a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/analyze.js\":\"9600b2621289f056\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/diagnosticsSource.js\":\"faf11dc11c5c5c95\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/index.js\":\"49828b1b65c1a9fa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/load.js\":\"b6cbfd6264e731ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/monitorRun.js\":\"a82c14546192475d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/schedule.js\":\"a2b4cd134601de9d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/series.js\":\"a2f8ed4d24d5e180\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/store.js\":\"544208e9f24cd6e1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/trendAction.js\":\"7c729e64800b11e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/verdict.js\":\"9a80707f80ad872d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/clickToEditAction.js\":\"cf33e7c892ad7bca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/index.js\":\"eaf3236c30c86e7d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/interactions.js\":\"713cafb60d794fc3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"06607e2717ef1f5a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/MigrationGate.js\":\"c4479a553b0daba4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/MigrationGateDialog.js\":\"54eee92c04436a74\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/action.js\":\"ecb9ddbf15a5d03e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/index.js\":\"55cb169c8fd64a3e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/localRunMessage.js\":\"fd8fb77bc8ad5135\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/plugin.js\":\"e1f90efe15e2a8b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/progressReport.js\":\"ed7b5cdc383b2714\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/sweepProgress.js\":\"469bb2d408e6e681\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/FieldRowRenderer.js\":\"af502fa79c4f3cc5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/ValueRowRenderer.js\":\"cb44b3facc2bc19a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/actions.js\":\"0020dba9b9912f84\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/autocomplete.js\":\"cfa2caa0becd893d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/fieldRow.js\":\"165aa04f5f74c44b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/index.js\":\"e9a2f0655a3aae27\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/referenceWarning.js\":\"1352e96088c19a71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/valueAutocomplete.js\":\"ce415cb6189738c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/valueSchema.js\":\"e95d866d1e710a0e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/HeaderItem.js\":\"e3c00f39e6a93200\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/QuickFind.js\":\"c623ea6b1086ea0a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/index.js\":\"6bf9033a3b895906\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/recents.js\":\"45bf8526d3343614\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/resultItems.js\":\"8b5a742da8997a1e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/selection.js\":\"119c7cad3fc394cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/toggleStore.js\":\"6bd0477be0400f82\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/HeaderItem.js\":\"1d6e03441ea943cf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cb3e28d5fae0502b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/grouping.js\":\"a9120fe054b32e08\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/index.js\":\"16fb9af7e99d48db\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/target.js\":\"2aed2f3112087397\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/codeMirrorExtensions.js\":\"ec479653555d5ab7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/contentPrefill.js\":\"5a5cad7f2e928b37\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/dataExtension.js\":\"4d26149767c981d3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/index.js\":\"b21eff4337feb9b9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"97ee9a7df1287ae0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/invalidation.js\":\"04b5f9ce5f1d1210\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/localSchema.js\":\"84240f694d8c7a96\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/blockrefs/index.js\":\"f705335371c1389e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7b3a4432a171b922\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/index.js\":\"646209f44150ec75\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/referenceNode.js\":\"8366aa60d15a089b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b5ed447d62006142\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"176f1691492f78d4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/index.js\":\"e3a73bff297225df\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"eb39b79cc2c9908a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a3ff998a42ad2660\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/mergeRetargetProcessor.js\":\"f4e72351b0cf119b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/parseFence.js\":\"16c8ed04fb891c62\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referenceParser.js\":\"16478710ae1a925e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referenceProjection.js\":\"4d2cc225dbe6f55a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referencesProcessor.js\":\"60eb1bc7252b85c3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/renameProcessor.js\":\"99ea4b83985b7b77\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/spanReplacement.js\":\"0f0af9fc45a25f20\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/htmlToOutline.js\":\"d0264c37e8af901e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/index.js\":\"c497e8d359c53492\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/normalizeClipboardDom.js\":\"564403d144cf5d66\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/pasteDecision.js\":\"7342d8f74387a917\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/action.js\":\"ae9d10abf5cd2743\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/blockIds.js\":\"3ea32122a4da2ee6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/content.js\":\"5546a09565e795f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/effect.js\":\"782ad71d532d0315\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/ids.js\":\"0d1262ca6aae6d9c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/import.js\":\"2558ef6fe1d38e40\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/index.js\":\"997f2f0f3105b8c8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/plan.js\":\"69f217fe37f0e429\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/plugin.js\":\"620bc06aa40939e4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/promotion.js\":\"fbb41ec993e9c93e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/properties.js\":\"4d909b80e956e3af\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/references.js\":\"9d4eef15e87c3216\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/report.js\":\"c9871286fd429756\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/roamMemo.js\":\"184d1aba65a99c0a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/runtime.js\":\"fcf9991be497f706\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/schemaReconciliation.js\":\"4f4f4030a1b9f2c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/srsMarkers.js\":\"bb9f2c0e35427a01\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/todo.js\":\"f43e74aab162b589\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/typeCandidates.js\":\"5dd056996d7b3116\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/types.js\":\"fc1c4e67bff2e4f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/search-health/index.js\":\"3733673716d30c09\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/search-health/store.js\":\"f6f73c6157f4fcb9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/HeaderItem.js\":\"bdada03bc2978c21\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"75dbcafd8764f0ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/index.js\":\"affce8894770f6ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/model.js\":\"f93b80d3a8078be1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/toggleStore.js\":\"f2da569b8650fd84\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/useKeyInspector.js\":\"3d4d3e16f1f6521c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cf5b5b0344ba7bc3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/ShellDecorator.js\":\"94672e04b455c476\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/actions.js\":\"6d3996b96e8c19a2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/exclusionsFacet.js\":\"24a5d44401f53a96\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/index.js\":\"326dbfafefc1d39d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/shell.js\":\"f588a9749b46bc67\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/surface.js\":\"f1c6012d20bb68e1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/walker.js\":\"4e3ebdc38b49d7b9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6e9316bbca88bdc6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/dataExtension.js\":\"f2171392f600d521\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/index.js\":\"f553373999066875\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/indicator.js\":\"01f5bf82d08432d7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/moveSrsState.js\":\"c61e701e1eaa0a91\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4d65ddbd287197a3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/scheduler.js\":\"cbd58f9760341eb8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/schema.js\":\"8c2b00e63e7c6359\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3f3f50430a3a4c1d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/srsClipboard.js\":\"47624becf006059c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4fd21598f1e9514d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d85f74ab93bbdee3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/DeckPicker.js\":\"270834a0e99dd911\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewControls.js\":\"4287462c3b2150c4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3ddbf7f221ce16df\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewSession.js\":\"8da2b8c3e1747342\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/actions.js\":\"4fc9f369a6eaf06b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/archive.js\":\"8f195ecd483b31ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/dataExtension.js\":\"45fa58dc663b9f6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/deck.js\":\"a8f1c86067ba5d3c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/dueQuery.js\":\"1ec41aa0efaf51dc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/gradeDecision.js\":\"11e773a49bf3bb55\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/index.js\":\"8e654a5027fc98d3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/keyHints.js\":\"92cb56c278554760\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/reviewCardLayout.js\":\"510c367c324fdd19\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/reviewProgress.js\":\"1cb49eed47482c07\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/schema.js\":\"4de54058fb53a420\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/useDueCards.js\":\"062a6e4ca6837c2c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/startup-metrics/index.js\":\"c71ae0871a744348\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/startup-metrics/record.js\":\"b5aab6a367ab61ff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/index.js\":\"ec77780d207b5251\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/persistenceStatus.js\":\"1e3e5d5d0c3c329d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/requestAction.js\":\"51eb769d22aed4cc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/TypeChipsDecorator.js\":\"9e7a2fecff4d4473\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/codeMirrorExtensions.js\":\"39636ba9238757bd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/index.js\":\"fb7d97e3012ba737\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/typeAutocomplete.js\":\"a23cd663983b14c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"431eb9db7939ca71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/actions.js\":\"f4749f7d9e82758d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/anchor.js\":\"6ef63ddc334009cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/events.js\":\"5f69d82604ba75ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/gestureActions.js\":\"b01064279370772b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/index.js\":\"afe740a17470f798\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2576a1a54ed39ddf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/collect.js\":\"6ff51b567d7dc827\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/index.js\":\"7df235af4ee27735\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/record.js\":\"5d81633322e9a38c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/RejectionDialog.js\":\"563a87a0e91adf49\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1919636a286340b7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/index.js\":\"40ae2836c24860c6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/model.js\":\"a53a31dea8f67e2d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/queueCounts.js\":\"504f38c6d12ce98b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/rejectedHelpers.js\":\"8e4206de190a9e35\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/rematerializeAction.js\":\"f556d74a677a3e30\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/useHysteresis.js\":\"0b75820315b46d31\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/ColumnHeaders.js\":\"cf811606983c1e97\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/QueryUi.js\":\"e2eefa1215a0f7a6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/TableLayout.js\":\"504cfe0e954a26b1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/actions.js\":\"2a0a301d57e2c117\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/cellEdits.js\":\"34f069f727a18985\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/childrenViews.js\":\"869c9010336683e7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/columns.js\":\"89e275f27ce7f1a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/controller.js\":\"49c167b3ed7dc6c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/convert.js\":\"41e847e01bc8c72c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/dataExtension.js\":\"99432f5d5ebe6444\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/index.js\":\"4f30b9b4937ed36d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/keys.js\":\"b4f072c841781ca4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/model.js\":\"3be2993a5de96a8d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/backfill.js\":\"f2b36c50464f0193\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/completion.js\":\"ca87b6da3017bf7c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/format.js\":\"8ca33d526a038073\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/parse.js\":\"e6692b0961a378bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/queryValue.js\":\"d2e3bd26c65af98c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/source.js\":\"4650b2c3ebfdc1c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/registry.js\":\"b5df9cb6aa38f684\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/rowGutter.js\":\"351c78780939b562\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/rowVerbs.js\":\"ed2db7ca7c95855b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/schema.js\":\"ed84feed6c01561d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/sort.js\":\"f7c9fe94742298a1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/effect.js\":\"1de973546b790ed5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/index.js\":\"c02c3457058c9811\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/theme.js\":\"b927fc82455cea98\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/actions.js\":\"734d6ffad8bc0cce\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/dataExtension.js\":\"3929df99c0a4457b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/index.js\":\"c16b988b9590e327\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/schema.js\":\"6dd46173689b1ce8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d3f49c68d8669dc5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/actions.js\":\"fc00ab936efe66a3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/defaultItems.js\":\"1e89af03eb310998\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/facet.js\":\"a1c52f8b2c4ab77f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/holdRecognizer.js\":\"a77a40a4fda23a87\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/index.js\":\"49e54d6608af92a3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/UpdateIndicator.js\":\"2649bece2faf3b0b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/index.js\":\"9842fbd121b6cc01\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/loadTimes.js\":\"0b60d8912ff632a8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoNotesRenderer.js\":\"e942f0f17ea994ab\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoPlayerRenderer.js\":\"b30a5981674381ed\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoTimeStamp.js\":\"b58f77eaf869aa70\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/actions.js\":\"0ac5815229fb61d7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/index.js\":\"2c688a6626401087\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/markdown.js\":\"0e5df4b33a34a938\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/notes.js\":\"499e292a162f3dc9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/registry.js\":\"ede3a48cf66524e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/remark-timestamps.js\":\"7f2d84ff96cd9e34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/view.js\":\"03f2802c9e1c6806\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/LinkHints.js\":\"428daef27eddab88\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/index.js\":\"1e847c01831e2c36\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/model.js\":\"9317925782f74e63\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/settings.js\":\"75737833565926ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/actions.js\":\"d59ff8b34a58356d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/index.js\":\"7d1899984475044a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/interactions.js\":\"1dbd1d4ee06e33f8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/workspace-header/index.js\":\"925586c7c690a391\",\"/knowledge-medium/pr-preview/pr-1872/src/registerServiceWorker.js\":\"014ae40f73b72c4a\",\"/knowledge-medium/pr-preview/pr-1872/src/requestPersistentStorage.js\":\"bfc21d1b00a9bd3a\",\"/knowledge-medium/pr-preview/pr-1872/src/services/authRequestDeadline.js\":\"9c575b39bff71f18\",\"/knowledge-medium/pr-preview/pr-1872/src/services/authStorage.js\":\"3bc79d28c4ee662b\",\"/knowledge-medium/pr-preview/pr-1872/src/services/powersync.js\":\"827d7b92608d7c47\",\"/knowledge-medium/pr-preview/pr-1872/src/services/supabase.js\":\"c13b627f078f2008\",\"/knowledge-medium/pr-preview/pr-1872/src/services/uploadErrorClassifier.js\":\"20ecc0bf3069c2cf\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/ActiveContexts.js\":\"f02c9ac2eec67d37\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/HotkeyReconciler.js\":\"2c6bde2fd73d9221\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/WipeLocalDataDialog.js\":\"762846dae7161d3f\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/actionDispatch.js\":\"d0ad07ede5b59282\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/actionRefItems.js\":\"87fdb2be8d34544c\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/applyKeybindingOverrides.js\":\"2d2145da342ba184\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/blockActions.js\":\"f2afd258d87522bc\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/blockMergeGesture.js\":\"15c8fb48ca2557dc\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/canonicalizeChord.js\":\"2bd75427066099b8\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/defaultContexts.js\":\"8bbb46e9656a0aea\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/defaultShortcuts.js\":\"946f909a56e38588\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/effectiveActions.js\":\"73f835dad8ac1626\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/gestureAction.js\":\"5914c87e22310c92\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/gestureBinding.js\":\"69a5824a0600aa77\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/holdRegistry.js\":\"59c3b11c2ae6e1a4\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/keybindingConflicts.js\":\"9b5bf153d26f10cf\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/keybindingOverrides.js\":\"c7ee45c773840a09\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/pointerAction.js\":\"2d29d0c7e71415f2\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/resolve.js\":\"69878acf8104eb56\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/runAction.js\":\"8cac6ab28bcc8d4e\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/sequenceMatcher.js\":\"2de152d0ae0405ca\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/types.js\":\"a8be84a78f9eae76\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/useActionContext.js\":\"77d305b4ca7e244c\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/useActionDiscovery.js\":\"f4f569729a3b7887\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/utils.js\":\"e3d1376f3efc8abb\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/bootStore.js\":\"7a881de9e62c8fd3\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/previewDatabases.js\":\"e38948e93ab9b1e9\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/byteTransform.js\":\"41ede77586042968\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/attachmentCleaner.js\":\"07b4f376956057ca\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/attachmentParts.js\":\"7a185a8b2592950a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/bundleParts.js\":\"a5f29bc0f9af00ba\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/bundleRecord.js\":\"dc03da0d5f44b972\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/manifest.js\":\"1f5e4c0f75d083f9\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/takeBundle.js\":\"b31c4876ec49078e\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/verifyBundle.js\":\"e7e758c09b7495ca\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/cleaningStage.js\":\"8c756e2959a0b20a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionKey.js\":\"42a65e263b217fcd\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionServer.js\":\"5a918d17d7f59b22\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/flip.js\":\"796925b4e880de27\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/flipAttempts.js\":\"633160f58ed39ea2\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/pages.js\":\"4e6d42b0273d967f\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/preflight.js\":\"8bd513130738ff07\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/reseal.js\":\"d66cf14a1211b78e\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/runConversion.js\":\"d45ae2f530192f4a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/runLock.js\":\"db8c65ca14fe5969\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/sealing.js\":\"5e2ad4373e8671f5\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/sealingStage.js\":\"40502551ae18791d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/stage.js\":\"c1a5bda31fa89dd9\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/verifyReseal.js\":\"539e7094b97b98d2\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/aad.js\":\"4a405f89060777ba\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/aead.js\":\"236a2e7116b52503\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/base32.js\":\"e809d91e82321255\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/base64url.js\":\"e431ea0618975b7d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/binaryEnvelope.js\":\"444eee9a00b7c25b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/byteAead.js\":\"76ad51200e07af4c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/canary.js\":\"ce6c5b0a238931db\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/contentHash.js\":\"83bc617839e20904\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/contentKey.js\":\"adc752378e7e18e7\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/derivedIdNamespace.js\":\"4fa4053bffabce6e\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/envelope.js\":\"1513d6dafc63da18\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/hex.js\":\"0463c2e150ec3e79\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/sha256Hex.js\":\"4ea22ca6c8638313\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/workspaceKey.js\":\"33376e54715e77de\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/conversionState.js\":\"0f187ac0938732ce\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/createEncryptedWorkspace.js\":\"eb70da18c3d1925a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/pastedKey.js\":\"6945201ea6429470\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"aabee003803f837b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6341aaed2706ae19\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/keyStore.js\":\"02f3132a6a70050d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/mintWorkspaceKey.js\":\"01983241b7c07a6a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/modePin.js\":\"f1cb2378af8eb6b5\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/openWorkspaceKeys.js\":\"8bad11e769a040a6\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/resolveWorkspaceEntry.js\":\"a245941e84ef8134\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/resolver.js\":\"611e6a60d7088d8b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/workspaceAccess.js\":\"14f0d72934d6709c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/transform.js\":\"936f40c28e63135d\",\"/knowledge-medium/pr-preview/pr-1872/src/themeBootDefaults.js\":\"6fc3329d6aa522f0\",\"/knowledge-medium/pr-preview/pr-1872/src/types.js\":\"0d706952545a628d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/ClientLocalSettings.js\":\"54e3411941cfd9bb\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/abortableSleep.js\":\"6243056e3889c6a6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/array.js\":\"a1c75655f79877b8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/backlinkAutocomplete.js\":\"4344d54eaa709ed2\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/blockCrumbs.js\":\"87ff9cc81141d4cd\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/blockrefAutocomplete.js\":\"29fd89a626f75b4e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/cadencedIdleJob.js\":\"a5921b8fae939f3b\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/callbackSet.js\":\"2627321338e7a16d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/clientId.js\":\"7dde64fa24b41e39\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/codemirror.js\":\"efa8c3d9e581d2da\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/codemirrorCompletion.js\":\"f2ff78af3985e480\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/copy.js\":\"118d29e597a1c481\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dailyPage.js\":\"b1eebdc3aeff32ac\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dbForensics.js\":\"43cdd37f4388bf47\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dbForensicsHooks.js\":\"5ad3253cf2b2dc29\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/deleteBlockThroughUi.js\":\"6aa03db6f0a16686\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dialogs.js\":\"f69186672e9d66e3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dom.js\":\"25a0719a1aa642e2\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/downloadBlob.js\":\"5332d6a5baae7e58\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/drawnWalk.js\":\"61d4efbb09dd81ac\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/exportSqliteDb.js\":\"85e8172598d9e17d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fileSystemAccess.js\":\"c25859e446ee2709\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/flipSlide.js\":\"c199b00b87ff6ace\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fnv1a.js\":\"5ae8ce1ad255cf3f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/formatBytes.js\":\"9aa283a42993cd48\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fuzzyRank.js\":\"e87f6d7097ef7d77\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/idbKeyedStore.js\":\"9af571cb2e3ab99d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/idleCallbackPolyfill.js\":\"3acc8a7d8f2e201f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/keyboardAwareScroll.js\":\"a076ee518a670ec1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/keyboardViewport.js\":\"9a24315697af4e05\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/lastWorkspace.js\":\"d10c59cb3fd7da69\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutColumns.js\":\"8bb69615e469100f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutSessionDom.js\":\"e0c09ba640c42c5e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutSessionId.js\":\"280f452c0532cad1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/linkClickGestures.js\":\"96f60ad0b389a89e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/linkTargetAutocomplete.js\":\"d8e534ac8e80b0db\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/localDbCorruption.js\":\"e0ec407d20559632\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/localDbRecovery.js\":\"55326db548c50e66\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/markdownParser.js\":\"2887751f382428a2\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/memoize.js\":\"c8c06cc1b0020416\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/nameFieldCommit.js\":\"ecd9a64c57424213\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/nameList.js\":\"9cf2af57c91f465d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/navigation.js\":\"7796d78be8ce0b31\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/omnilinerNamespace.js\":\"282b7108b915730e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/opfsPageScan.js\":\"fb1d3f2eaa4dca61\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelClearance.js\":\"0a76feb269e5ec28\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelHistory.js\":\"2ba98273ee0d9c08\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelLanes.js\":\"758e1e82ae89aee5\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelLayoutProjection.js\":\"233791d9cd50aa53\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelScrollAnchor.js\":\"d9f70ab891959010\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelUrlFlags.js\":\"33e5286350c7838e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/platform.js\":\"266b94d4532b83a0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/pluralize.js\":\"603d8b748450df1f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyCreation.js\":\"0c4a94fb250b0e8d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyNavigation.js\":\"c46e7a3ca1cb2357\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyValueContext.js\":\"eacdbb9568d21582\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/react.js\":\"c10c7497c81bb433\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/relativeDate.js\":\"1ad5ba251eacca16\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/relativeTime.js\":\"de02b3e43fd51188\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/renderScope.js\":\"224c18cfe7539221\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/resolvedThenable.js\":\"858952799286e684\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/routing.js\":\"5c8fa7039c9e99ee\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/safeMode.js\":\"fb2a71fac839706a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/scheduleIdle.js\":\"fdab18a64c89c313\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/screenWakeLock.js\":\"5441816fdd27477f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/selection.js\":\"dc07d5520ad79c14\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/softKeyboardGrab.js\":\"3be94a0f7ce027f8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/startupTimeline.js\":\"aaca27504b331e92\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/state.js\":\"2334dfd6016551f5\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/string.js\":\"0d58f7984e2ed070\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/surfaceZoom.js\":\"c1f3e685ab457c1c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/time.js\":\"7c568b570b60f3cd\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/toast.js\":\"5fb8776dbb1bffef\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/toggleStore.js\":\"3ade22e70c21e5e3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/untilStopped.js\":\"cb907cf79d6142d6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/userActivity.js\":\"2aa3f95896ac6b96\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/viewTransition.js\":\"1de5235d3d74c0d1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/viewport.js\":\"7feb59030e401803\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/webLock.js\":\"5f3ecae83bb7e91a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/workspaceRecovery.js\":\"50474ce9bf7da523\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/workspaceSnapshotStore.js\":\"4b0426bc2e0f887f\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-compiler-runtime.js\":\"dae22407f2b23c69\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-client.js\":\"56c1d5411e0af566\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-server-edge.js\":\"bafc81fb5e41a41b\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-server.js\":\"78282c47c07551eb\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-static-edge.js\":\"d0c12e2e14695bf0\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-static.js\":\"e4fc58bbf052bd16\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-test-utils.js\":\"fa8d39200e73d411\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom.js\":\"23af9de48613d046\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-jsx-runtime.js\":\"66ab237a66914231\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react.js\":\"5b134128b1305761\",\"/knowledge-medium/pr-preview/pr-1872/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1872/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1872/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
