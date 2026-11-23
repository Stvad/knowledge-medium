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
		buildId: "aa19771ea702-28f2eb3b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/\":\"bb75d8d8de684e3d\",\"/knowledge-medium/pr-preview/pr-1872/index.html\":\"bb75d8d8de684e3d\",\"/knowledge-medium/pr-preview/pr-1872/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1872/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1872/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1872/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1872/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1872/assets/FacadeVFS-puZlWYde.js\":\"52bdcac4b35d909e\",\"/knowledge-medium/pr-preview/pr-1872/assets/OPFSCoopSyncVFS-v96zNdWA.js\":\"20276ebd0845c3e1\",\"/knowledge-medium/pr-preview/pr-1872/assets/OPFSWriteAheadVFS-28ODNTXz.js\":\"6e45fb4159c5bb8c\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-async-C28BZIcj.js\":\"2d37f059852d4308\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-d0Pi7Ywt.js\":\"5e020a2459f62922\",\"/knowledge-medium/pr-preview/pr-1872/assets/worker-B9qx4kxR.js\":\"b1a747ddd757dcc9\",\"/knowledge-medium/pr-preview/pr-1872/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1872/chunks/app-dSNNBz7H.js\":\"e272320e58a1d5d5\",\"/knowledge-medium/pr-preview/pr-1872/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1872/index.js\":\"4f6731409bfc4290\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1872/assets/AccessHandlePoolVFS-DqmgBvMr.js\":\"f71c8436c72596b7\",\"/knowledge-medium/pr-preview/pr-1872/assets/IDBBatchAtomicVFS-ByGLCDxD.js\":\"bd9a5908675a26d5\",\"/knowledge-medium/pr-preview/pr-1872/assets/MemoryVFS-Bm22rp-w.js\":\"9c6ea9cd3fc5d7db\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-D3derA7m.js\":\"850f4525551d5040\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-async-DM_fHM1v.js\":\"c297666e4dcb2e86\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1872/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1872/chunks/AccessHandlePoolVFS-DPFkddqa.js\":\"9796b01ac8753cb5\",\"/knowledge-medium/pr-preview/pr-1872/chunks/FacadeVFS-D_Kz-MjH.js\":\"4780ad8e8ae3129d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/IDBBatchAtomicVFS-D1ADiAIj.js\":\"0095d6d9efc64385\",\"/knowledge-medium/pr-preview/pr-1872/chunks/MemoryVFS-BiyV-v_f.js\":\"fa737fa21a4d4629\",\"/knowledge-medium/pr-preview/pr-1872/chunks/OPFSCoopSyncVFS-BH1bMXgg.js\":\"1fed366177db3077\",\"/knowledge-medium/pr-preview/pr-1872/chunks/OPFSWriteAheadVFS-FXVh2qy6.js\":\"2ab96a7c3c2a7ec4\",\"/knowledge-medium/pr-preview/pr-1872/chunks/Preview-BQ6Z7kMd.js\":\"d0e06ba0c201420d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/card-CqVhmN45.js\":\"53685a7ee9d71ef3\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-BHL-bxOf.js\":\"91e34fcc328bdd84\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1872/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1872/chunks/mc-wa-sqlite-DJjmPd8c.js\":\"607290a36b24bb0d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/mc-wa-sqlite-async-CEpgnNIl.js\":\"0d574e4f52d184dd\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-6fx3LRTZ.js\":\"e83031419a4e8b77\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-BbbcWTjK.js\":\"e7e736f4edae77df\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-C6vIVQ_o.js\":\"5b39a660001f8f0f\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-DI-VuyL7.js\":\"74a97c95987ee099\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-DU5ktybT.js\":\"5b524404aae7793a\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-Dw0XG-l1.js\":\"8cd041b58b7b6525\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-GVnkwUVL.js\":\"47584795eeacef67\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-MIlWJ2YO.js\":\"d552225e6bdb3f89\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server-legacy.browser.production-i13UK7l2.js\":\"1ca7942b2693716c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server.browser.production-CpQ4h1wG.js\":\"38708ce66f8ed49e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server.edge.production-BVlIGGwU.js\":\"659526751e43c2dd\",\"/knowledge-medium/pr-preview/pr-1872/chunks/server.browser-fINAghQV.js\":\"de93f0f3cb56237c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/textarea-D8_oMGya.js\":\"c5dadf68db0298d7\",\"/knowledge-medium/pr-preview/pr-1872/chunks/ui-C9NHQfke.js\":\"829024481d5d47bf\",\"/knowledge-medium/pr-preview/pr-1872/chunks/wa-sqlite-DWd738-m.js\":\"b70d570dcbbfa879\",\"/knowledge-medium/pr-preview/pr-1872/chunks/wa-sqlite-async-D3kXuqUS.js\":\"bbc670f1f3cc5131\",\"/knowledge-medium/pr-preview/pr-1872/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1872/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1872/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1872/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1872/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1872/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1872/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1872/src/App.js\":\"ddbd68510cdfc0e8\",\"/knowledge-medium/pr-preview/pr-1872/src/appUpdate.js\":\"afc14b30d52f66d3\",\"/knowledge-medium/pr-preview/pr-1872/src/appVersion.js\":\"c90a7fbfde42f85e\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/initialLayout.js\":\"ede0f11a4c4a519a\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/openWorkspaceData.js\":\"b1a7d519211c717f\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/resolveWorkspace.js\":\"83cc00d4558033f7\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/workspaceBootstrap.js\":\"03779588cde933b3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockComponent.js\":\"d269c25b2e87330a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockCrumbs.js\":\"5d6adcd9c92d1858\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockEditor.js\":\"9066536739787622\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockLoadingPlaceholder.js\":\"9fc3984922e431bf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockProperties.js\":\"0104afa49c4d26a0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockSearchPicker.js\":\"8a827f61ec5bf24f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ConfirmBulkDeleteDialog.js\":\"11ed28194b8f85b9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/DividerHandle.js\":\"3178d0109aa6c495\",\"/knowledge-medium/pr-preview/pr-1872/src/components/DraftEditor.js\":\"b723b2f0e0f37ea9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/GutterPill.js\":\"a5fbb240fee2253f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/Header.js\":\"2e6843dfaf969185\",\"/knowledge-medium/pr-preview/pr-1872/src/components/LazyBlockComponent.js\":\"3bf94d17dfa4abe3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/Login.js\":\"151900d83a235401\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ZoomableSurface.js\":\"946ec63475803052\",\"/knowledge-medium/pr-preview/pr-1872/src/components/editModeKeepalive.js\":\"1c023e9ec863f82f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6f7068dbbbde269e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3e13f7b369bc8a2e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/RefPropertyEditor.js\":\"d287f8bbfa202305\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/RefTargetTypePicker.js\":\"c50ab0e5902ca9b2\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/SelectPropertyEditor.js\":\"0c9f5d013ee473ef\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/TypesPropertyEditor.js\":\"156bd8a6519a005d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/defaults.js\":\"acf6c0ee01dacbdb\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/kernelValuePresets.js\":\"85f5001380b4853d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/selectablePresets.js\":\"593c6bd515c8780a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/typesPropertyUi.js\":\"b7e8f3d1d94c3389\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/AddPropertyForm.js\":\"85c9f4ebe7be2424\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/PropertyPicker.js\":\"2b6105596c70621f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/PropertyRow.js\":\"d37a2c91bcfeccfd\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/Rows.js\":\"53fe160e4f42b0c0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/actions.js\":\"4431beb86f060b7f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/declarationOnly.js\":\"36f1bd3ac058b0a3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/layout.js\":\"72f0b1999196064f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/model.js\":\"7559726046275f73\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/shapeUi.js\":\"9254c725046438d9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/shapes.js\":\"2fea6afdec29a0cd\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b810201e59b972ee\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/visibility.js\":\"1bbefb791f1ee5fe\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanelSections.js\":\"f07ad2d11b5a3e01\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockEmbed.js\":\"85af8f28ff377464\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockLink.js\":\"1541b964d64b9ee0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockRef.js\":\"95df7f19ae90c602\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/ReferenceLink.js\":\"a2f6fbb149470235\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/cycleGuard.js\":\"14d61c950f21045c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/cycleGuardContext.js\":\"2b65914006bbf811\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/linkInteraction.js\":\"736639f04377b975\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/referenceLayout.js\":\"853bf630c008c264\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/useBlockRefAncestors.js\":\"6eed2b8097116a19\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockGutter.js\":\"ab108946471b8845\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockInfoDialog.js\":\"f73e3896622ae381\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockTypeBlockRenderer.js\":\"01e1a564b388a65a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BulletHoverCard.js\":\"fa48df1a139cf361\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/CodeMirrorContentRenderer.js\":\"c0af369e86f2753a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2afe08955e3dce5c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/ColumnResizeHandles.js\":\"a3d3d096ec38846a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b62cd27e5ac9cc0a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/DefaultBlockRenderer.js\":\"7a8138574d505b25\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/LayoutRenderer.js\":\"fda06ebee23f5449\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/MarkdownContentRenderer.js\":\"9d6729c42363bc14\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/MissingDataRenderer.js\":\"5fb331fbd7f92835\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/PanelRenderer.js\":\"79e7303c188a83e1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/PropertySchemaBlockRenderer.js\":\"63e5d37709cf515f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/TopLevelRenderer.js\":\"caa621aa6eb8d3fc\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/blockGutterMode.js\":\"58342bbfdd7b4c6f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/blockTitleText.js\":\"73cb442c43dcd549\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/fieldCreationKeydown.js\":\"e547618e7f475c1f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/layoutRootContext.js\":\"9620f02a8de3fe52\",\"/knowledge-medium/pr-preview/pr-1872/src/components/typeChip/TypeChip.js\":\"deaf3b29117dd8e8\",\"/knowledge-medium/pr-preview/pr-1872/src/components/typeChip/chipStyle.js\":\"fa7b78133a473dcd\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/anchored-floating.js\":\"90c1507f5b68ea88\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/button.js\":\"048ef2f64822627f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/card.js\":\"ef918b4ae571baee\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/checkbox.js\":\"479912b51332875c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/collapsible.js\":\"796d73233830f0b3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/command.js\":\"6cac69bb2744d016\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/context-menu.js\":\"30b3aa33d58c4904\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/dialog.js\":\"f20bc100e39fc8c3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/dropdown-menu.js\":\"885f6eeab97ff432\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/floating-listbox.js\":\"8176441bc20c06f2\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/index.js\":\"9fbe80d337eae068\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/input.js\":\"8060adc6201460af\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/kbd.js\":\"e4ca568b69cbdeb8\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/label.js\":\"7a8ba0aec3269eb3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/textarea.js\":\"2bd2260146feda05\",\"/knowledge-medium/pr-preview/pr-1872/src/components/useEditModeYieldKeepalive.js\":\"8eefef73060515a5\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/BootFallback.js\":\"4c1fecba7eef30c0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/FocusedRowLazyMount.js\":\"ad6f6f00aec39be6\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/LazyViewportMount.js\":\"771093ab74d550ba\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/LocalDbCorruptionFallback.js\":\"c3c3f1fe1eadc0c7\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/error.js\":\"1f8bd65accc2ab9e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/lazyMountRegistry.js\":\"479ef2443270f611\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/suspense.js\":\"8a215768cbabf248\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/CreateWorkspaceDialog.js\":\"4f92fdb2a09b3b3b\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/PendingInvitations.js\":\"d6772d842aa95806\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/SyncProgress.js\":\"5a6f3c289c73713b\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/UnlockProgress.js\":\"dd40ebb3f0c550ac\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceKeyGate.js\":\"b68d3808686b96a3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSettingsDialog.js\":\"8594b30ff9d750b7\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSwitcher.js\":\"57ae163d0448a3c0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSyncGate.js\":\"e042359752905260\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/ConversionFlow.js\":\"4c5938e6655a1e4c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/ConversionFlowHost.js\":\"1887a91e9c069a30\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/EncryptionSection.js\":\"1ac15e2dc6d3d0de\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/attachmentPrompts.js\":\"bc52b0f7a26cc98e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9954e2374605690f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/conversionFlowDeps.js\":\"1882fec87f390d0e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/conversionFlowStore.js\":\"a64e308e37b3bd43\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/flowUi.js\":\"1fcbf939df24dfbc\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/useConversionRun.js\":\"7fa1c81f58ba9706\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/keyUi.js\":\"b7aabedb5a2c5f27\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/useCloseOnKeyLoss.js\":\"a308e6f691081479\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/useCloseOnServerE2ee.js\":\"5de12f63c2cd2ba5\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/workspaceUnlocked.js\":\"9803cbb3819ee8be\",\"/knowledge-medium/pr-preview/pr-1872/src/context/backgroundSubtree.js\":\"599998942709c829\",\"/knowledge-medium/pr-preview/pr-1872/src/context/block.js\":\"74a0cf7a61c28a90\",\"/knowledge-medium/pr-preview/pr-1872/src/context/layoutWsContext.js\":\"617eed27255d0341\",\"/knowledge-medium/pr-preview/pr-1872/src/context/propertyDisplay.js\":\"adf91ed351f26a0b\",\"/knowledge-medium/pr-preview/pr-1872/src/context/repo.js\":\"e9e66bf638b5248d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/aliasClaim.js\":\"ae147347d852b7cc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/aliasSeatNamespace.js\":\"dea96937a090ac5c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/blockData.js\":\"34c4d698c00c32f2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/blockType.js\":\"e96d9b1720f1bb92\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/changeScope.js\":\"940109bcabc67a45\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/codecs.js\":\"92a059dd03fef7c0\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/derivedData.js\":\"558e532b4f7502c4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/errors.js\":\"063b2ca762cf0aea\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/events.js\":\"8527a4e315d1ba87\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/handle.js\":\"5b529b7795623a76\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/index.js\":\"a34ce5c388ccf38d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/mutator.js\":\"3ddf9e8e90313024\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/processor.js\":\"e25aae99b3ea28af\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/propertySchema.js\":\"6b1034fce9ab7641\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/query.js\":\"a8690218f60a4838\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/sameTxProcessor.js\":\"8cffd2f43d04f563\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/schema.js\":\"5b529b7795623a76\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/tx.js\":\"5b529b7795623a76\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/typedBlockQuery.js\":\"55546613092e2adc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/user.js\":\"5806e79a233ec5a3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/valuePresetCore.js\":\"daadba477615e573\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/valuePresets.js\":\"232551d93ca353a0\",\"/knowledge-medium/pr-preview/pr-1872/src/data/attachmentCleanerIOVerb.js\":\"b609195cee7ea304\",\"/knowledge-medium/pr-preview/pr-1872/src/data/block.js\":\"fa297048ffe70770\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockCache.js\":\"31b3093b63414de2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockId.js\":\"d51dbd833c8a94b4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockLiveness.js\":\"6beaad09f84cf48b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockMerge.js\":\"dad540bc9b64796c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockSchema.js\":\"3310cecff8f44b31\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockTypeLookup.js\":\"b5e0408dc8738868\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockTypes.js\":\"05a0b780111ac9db\",\"/knowledge-medium/pr-preview/pr-1872/src/data/childrenView.js\":\"034a6e23379bddae\",\"/knowledge-medium/pr-preview/pr-1872/src/data/clientContext.js\":\"fcc0e7275655c43b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/dbFileSiblings.js\":\"4d408f0880fb95fa\",\"/knowledge-medium/pr-preview/pr-1872/src/data/definitionSeeds.js\":\"f1023bb53aa610cb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/derivedIds.js\":\"30a75973a2ca41fe\",\"/knowledge-medium/pr-preview/pr-1872/src/data/drawnSubtree.js\":\"2c0c6e0cf87d575f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/facetBridge.js\":\"12729033a82f8acd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/facets.js\":\"ad5744552b32ce7d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/globalState.js\":\"c6b6215539d36634\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/aliasClaimRederiveProcessor.js\":\"af17f3d8f5dcc2e9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/ancestorBatch.js\":\"c2942e92868b2b3d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/blockTypeTypeifyProcessor.js\":\"1bb45f8371f39139\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/clientSchema.js\":\"05241a0e94187b9d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/commitPipeline.js\":\"65f1fd78f5426a6f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/devAssertions.js\":\"cdac33e3dabee805\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/firstSync.js\":\"5342219cb38968ee\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/freshInitialLoad.js\":\"82171b8e3ecb977e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/graphBackfillClaim.js\":\"b7e05a09e4e45172\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/handleStore.js\":\"a6ad03efb9499bc4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/idleMarkerJobs.js\":\"464680cb5763a983\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/initialDownload.js\":\"990b21894af44f5c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/initializeClientDatabase.js\":\"5794382beaf174bb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/jsonCanonical.js\":\"f80315081848099e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelInvalidation.js\":\"9453a9bbca0ec472\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelProcessors.js\":\"f32f780ed2289476\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelQueries.js\":\"50aa0442bc71bcf5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/mergeTypeMembershipProcessor.js\":\"07521bf2b3f0e5b5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/normalizeReferencesProcessor.js\":\"b36d3760eb89baf4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/poolInstrumentation.js\":\"537d2bd526dcd2ad\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/processorRunner.js\":\"0f484c384e3f1ea2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyCellBackfill.js\":\"6a93f8e5dc894d2f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyChildMint.js\":\"c4ce67ed1b369f05\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyChildrenProcessor.js\":\"d3d88c82f54904a3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e4996f937165e882\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyDefinitionSynthesis.js\":\"fd4abc7edac3209d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyKeyScan.js\":\"68739c6df2954932\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertySchemaResolution.js\":\"8d8eb464a73e2554\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyValueEdits.js\":\"90319d6c079ffb39\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/raiseProtocol.js\":\"e5ab3300d99cc4a4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/readBatch.js\":\"5f6a0351b00e884e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/refProjection.js\":\"66c0e51b5e458e2a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/referenceTargetLookups.js\":\"7a4fc432e1cec19f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/referenceTargetProcessor.js\":\"3a6ed0a774b1d9bb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/replayMerge.js\":\"25c64b9e599d7cf4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/sqlBinds.js\":\"18dbccaedd62931e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e330c3cfe6483172\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/arrivalProcessors.js\":\"791d493a74e17571\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/invalidate.js\":\"1562f637325b61ae\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/materialize.js\":\"96e3544f795e4768\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/observer.js\":\"7f20c2fd53b14438\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/reconcile.js\":\"13af2b1da2e37de6\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/timingMetrics.js\":\"98094ad935672430\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/treeQueries.js\":\"8b090738a27c65db\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/txEngine.js\":\"5ec2d125ddd451c3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/txSnapshots.js\":\"39c8a1844e65c1a9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/typedBlockQuery.js\":\"5d0941bc87d4f9f4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/undoManager.js\":\"665901a57a436f32\",\"/knowledge-medium/pr-preview/pr-1872/src/data/invalidation.js\":\"36a81aaaacfead91\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelDataExtension.js\":\"b1760a5194d48216\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelPage.js\":\"659a4cde4690e190\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelValuePresetCores.js\":\"8d78940cff950441\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbCorruptionSignal.js\":\"81e705e100d00461\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbStorage.js\":\"d3898275e5e8cb4d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbVfs.js\":\"7f8a01b76709bdb9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localSchema.js\":\"6ee33cd4807adbf4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/maintenance.js\":\"d32912e60938f584\",\"/knowledge-medium/pr-preview/pr-1872/src/data/mergeProperties.js\":\"5e2334eb51875650\",\"/knowledge-medium/pr-preview/pr-1872/src/data/metricsConsoleHook.js\":\"70c6799659254104\",\"/knowledge-medium/pr-preview/pr-1872/src/data/migrationsPage.js\":\"93b19cf3f0a05101\",\"/knowledge-medium/pr-preview/pr-1872/src/data/mutators.js\":\"1ae2bd63d5a5e059\",\"/knowledge-medium/pr-preview/pr-1872/src/data/orderKey.js\":\"f04ee63a18e00dd8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/orderKeyPlacement.js\":\"b25ddb612e90cca2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/outlineSurface.js\":\"e5b97dc013120a6c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pendingEditorContent.js\":\"c6fd59bac281da11\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pendingUploadsSql.js\":\"1cfe5fd2b6290004\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pluginStateExtensions.js\":\"f16617335889c78f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/powerSyncLogger.js\":\"d546acca6120b6f1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/projectorRuntime.js\":\"2c968f0a0e9466e3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/properties.js\":\"d3f6f098f7249b36\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertiesPage.js\":\"bf1f0b46f9a6eed3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyChildren.js\":\"8e5b1b6e89c4df1f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionFanout.js\":\"de42523cf641cb6c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionMetadata.js\":\"30c95c695c84b94d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionRegistry.js\":\"909705af7821b1ce\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDisplayMode.js\":\"b37da891d777a63d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyRowCreation.js\":\"facc261cac0c10fc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertySchemaCreation.js\":\"f689115fcaa2b810\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertySeeds.js\":\"d30e43bac4cf5045\",\"/knowledge-medium/pr-preview/pr-1872/src/data/recentsPage.js\":\"dd4e052c0914abc3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/referenceBlock.js\":\"1946ada2043dca9a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/rejectedUploads.js\":\"77dc95a05e3885c1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/releasePowerSyncConnection.js\":\"b7ad530a0b6bb23b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/repo.js\":\"33b78e75c3455408\",\"/knowledge-medium/pr-preview/pr-1872/src/data/repoProvider.js\":\"f9edf0338aeacee7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/rowProperty.js\":\"499c8c9ad899d35a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/searchFilter.js\":\"8a83e56139a6cc6e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/seedIdentityLedger.js\":\"585a4c23780004e0\",\"/knowledge-medium/pr-preview/pr-1872/src/data/stateBlocks.js\":\"c3c42e8b76b86e71\",\"/knowledge-medium/pr-preview/pr-1872/src/data/structuralEditPolicy.js\":\"05f7d777c1491167\",\"/knowledge-medium/pr-preview/pr-1872/src/data/subtreeDelete.js\":\"d67af2649c71caa8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncStreamLock.js\":\"78d273a91d36d510\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncedTableSqlRecognizer.js\":\"ce46a6e21cd2e967\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncedTableWriteGuard.js\":\"dc66f50d2383e2d9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/targets.js\":\"6912ac1fa01dfc3f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeColors.js\":\"566b93fffccde6b3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeDefinitionMetadata.js\":\"033eb45eb7ad5509\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeDefinitionRegistry.js\":\"99614c72f4848bb7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeExtraction.js\":\"c11204e0037a1cf8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeInitialValues.js\":\"e39c25d261384320\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typePropertyGroups.js\":\"71903524270ea3db\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeSeeds.js\":\"96552ef2afddadf2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeTagger.js\":\"c58ae48ec0bec987\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typedRecords.js\":\"84e885de9240b2ea\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typesPage.js\":\"dc905a577173a8f8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userPrefs.js\":\"481234b80820d7eb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userSchemasService.js\":\"bdf839427916972b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userTypesService.js\":\"c4063a25084566b8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/valuePresetRegistry.js\":\"481bdf061fe3183e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/visibleChildren.js\":\"ffb7662adf2ffc3c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceConversion.js\":\"366ddc03c84437b5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceFirstSync.js\":\"589215c535ec30fd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceIdNamespace.js\":\"0d2a63b25cf8b47f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceSchema.js\":\"5853c8c22298880b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaces.js\":\"bdb0ff8f09b73e2c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/writeAheadLog.js\":\"ce5f3115a3220297\",\"/knowledge-medium/pr-preview/pr-1872/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/BlockPasteShellDecorator.js\":\"990ba831ba928fb7\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/atTrigger.js\":\"f2d9348d62ced5a0\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/autocomplete.js\":\"8c5930bf91c34f9e\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/codeMirrorExtensions.js\":\"7cfa614ca74839d7\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/contentFlush.js\":\"42c34801ced090ca\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/defaultInteractions.js\":\"658b8f959ab6e6f5\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/editSettleSignal.js\":\"3905bb96db964fe1\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/insertImage.js\":\"1684853e323156b9\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/referenceCompletionRange.js\":\"7a76d23e880e3a84\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/referenceTargetTypes.js\":\"be108054c392f4dc\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/syntaxContext.js\":\"1f1865fd99cf8816\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/triggerMatch.js\":\"a1d18382a58157db\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/AppRuntimeProvider.js\":\"10faa164fa450210\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/BlockFocusShellDecorator.js\":\"8cc73e021de06623\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/ExtensionRenderBoundary.js\":\"e92fbe28f7287ccd\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/PanelContentRecovery.js\":\"10edc111eb9f8377\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/apiCatalog.js\":\"170db059cc6aae05\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/approveExtensionHere.js\":\"faa9cdf7c4d0f02d\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/armedCutAppMount.js\":\"91775056e8c61ea4\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/batchableKeyedStore.js\":\"e7769c95e8199e38\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/blockInteraction.js\":\"3a06b589e584ed47\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/blockSelectionAction.js\":\"3d09404477d92f6e\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/compileExtensionModule.js\":\"8a2c4f0df3259e95\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/compiledModuleCache.js\":\"cde37b77a4309c17\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/continuousGestures.js\":\"71b8312e11a9c6d8\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/core.js\":\"115d81b76bb0f620\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/defaultRenderers.js\":\"887135ba3103f6ed\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/definitionFanoutAppMount.js\":\"6029459980ee121b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dialogAppMount.js\":\"a4a2d1798ca183ae\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dynamicExtensionSeeds.js\":\"d7cccbf0714e3c74\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dynamicExtensions.js\":\"09f185b0a1f4ad0c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/exampleExtensions.js\":\"402859f7f6b90a16\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionApprovalStatus.js\":\"8f4d54f2ecb4c0df\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLoadErrorToast.js\":\"1595bb5d3ee9f3dd\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLoadErrors.js\":\"35732deab15a88e0\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLookup.js\":\"d5e156535a6af958\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionToggles.js\":\"0743c909d096ff4c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionUtilitiesCss.js\":\"b280963909f59ce9\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/kernelPageDeletionGuard.js\":\"d69c174988928af5\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/liveRuntime.js\":\"e9771d86d552dcaf\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/openExtensionsSettings.js\":\"38ebbdbb8fad5ded\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/overridesCache.js\":\"dc7c74aad101627f\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/pluginIds.js\":\"2290870f72357275\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/processorRejectionToast.js\":\"695b6d4e1a65f0c2\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/runtimeActions.js\":\"647e7e64b6d2b17e\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/runtimeContext.js\":\"6bb58b7f4830d75a\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/staticAppExtensions.js\":\"d6b7066c2e930132\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/staticDataExtensions.js\":\"b77a4e25f618440b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/toastAppMount.js\":\"ffd34ea2929b1853\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/useOverrides.js\":\"87c1cdf9506ac577\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/useShortcutSurfaceActivations.js\":\"6022b25d9a5d4045\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/discoverToggleTree.js\":\"f16a41c59537d981\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/facet.js\":\"a796781104518e2d\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/resolveAppRuntime.js\":\"3b9b6c1e06cda743\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/runtimeEvents.js\":\"cc4fb7bf9321b4d8\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/togglable.js\":\"45ef2a208d4b3b79\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/variantFacet.js\":\"d269c0c29c56b220\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/verbFacet.js\":\"3754356b1032445a\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/block.js\":\"902fd065f083fc78\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/focusedChild.js\":\"2d80cf02eb48134c\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/propertySchemas.js\":\"362abace0433102d\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/typeRegistry.js\":\"f6972b6c09f4c62a\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useAncestorCrumbs.js\":\"8851dcc98f532b16\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useAutocompleteListbox.js\":\"8b54445b5a133d6c\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useDebouncedSearch.js\":\"2d4ad090fd879d03\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useDebouncedValue.js\":\"6780942025a2607f\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useIsFocalRender.js\":\"a025a4875939bbc5\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useIsReadOnly.js\":\"e161bab5d6303dbe\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useMaterializeBacklog.js\":\"3a66ee4191277bb8\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useMinuteClock.js\":\"9a2a9be0dfdeeee3\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/usePanelLayoutProjection.js\":\"5e11503378f2627e\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/usePendingInvitations.js\":\"ef20f617b5a54b2d\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useRendererRegistry.js\":\"7f69f86f8f22130a\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useRetainedFieldRows.js\":\"f86f07dd590e595f\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useWorkspaces.js\":\"e8377f1832615517\",\"/knowledge-medium/pr-preview/pr-1872/src/lib/utils.js\":\"956ac1dffffa489e\",\"/knowledge-medium/pr-preview/pr-1872/src/main.js\":\"c29ce560fcc07527\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/MarkdownImage.js\":\"3ec1e8935d2e18bd\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/blockSeparators.js\":\"464e32ff212bf261\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/context.js\":\"7b597982c6049eba\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/defaultMarkdownExtension.js\":\"7651eaae9f23232f\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/extensions.js\":\"b6bc1e456143bc77\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/renderMarkdownHtml.js\":\"5e2918b84e2290b5\",\"/knowledge-medium/pr-preview/pr-1872/src/minimal-editor.js\":\"e46a0d0e9dd99860\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/armedCut.js\":\"48a4d5fcf21c0448\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/captureMediaVerb.js\":\"04bbb7b5f4bbdada\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/clipboard.js\":\"bfa4ce333d29e9bf\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/decision.js\":\"f6f694e8e02e901c\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/operations.js\":\"2b0739e570fd9fbc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/account-header/AccountHeaderItem.js\":\"398e277a1d983c7e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/account-header/index.js\":\"728c05c75b99b2c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"3a7fede1deb1efe4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/askAgent.js\":\"1a0db3fc0d29f9ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/askedStore.js\":\"18133f421463ecb7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"50baca332747cbdf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/chipState.js\":\"b07b868538410633\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/dataExtension.js\":\"48ac47e74e14d6da\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/index.js\":\"f099e415099b4be9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"dd5f5f3b0d1ca9da\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/schema.js\":\"d0b2d43f0ecc68b1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/AgentTokensDialog.js\":\"980a4c0f57e4e661\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/BridgePairingDialog.js\":\"97b5d3274937716a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/addMedia.js\":\"05916d0cb86c4bcb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/backlinks.js\":\"84e4c8c93f368b34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/block.js\":\"406b760975820a03\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/context.js\":\"6fd7168bb9099120\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b0d798d0e22d0b8c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/index.js\":\"7198e92cc7100091\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/outline.js\":\"a8bd286602880956\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/properties.js\":\"579ce96d1ae8b703\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/refs.js\":\"6bcab07eee3e6d1c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"82551308dff523f2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/search.js\":\"e7b142a0caecf069\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/shared.js\":\"dcf8bbd8544af477\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"43fbf48e75e66059\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/text.js\":\"82bc0675ee08d4f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentWrites.js\":\"ab1256fe654c47cf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/authoringCatalog.js\":\"f0177617c21d8cbf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/blockRefTargets.js\":\"dd7209ee22053dca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/bridge.js\":\"34ccd8d5d0393837\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/bridgeLoop.js\":\"0a8eca2fbcf855b0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/changeHistory.js\":\"3705d2fd3d75b37a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/commands.js\":\"9a790f29d1ffc2ac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/commentsCommands.js\":\"b57a415bae0079bd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/dataExtension.js\":\"a6ff7a55b58bd23a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/dataModelGuide.js\":\"e585af05294f0236\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/describeRuntime.js\":\"725498c54fd2a43c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/extensionLint.js\":\"dd9ddd6439f964c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/grainAudit.js\":\"548d9980657727a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/healthCommand.js\":\"1b8984a740178587\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/index.js\":\"5c373af93c86d1d7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/presetIdentity.js\":\"3837ea1b2d11d5ae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"647a21f1d86e125f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/readMedia.js\":\"248a2e9fb6bd027a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/schema.js\":\"7ac8ea09b38cb700\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/serialization.js\":\"49344c193e92de50\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/targets.js\":\"10a8008b89592428\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/tokens.js\":\"1f57d6b30316507f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/watchEvents.js\":\"02f49b66df106adf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/workspaceGuard.js\":\"275b7705b4fe91e7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/writeCommands.js\":\"5098960175432799\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/AliasCollisionToast.js\":\"753ed4f134717f4a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/DuplicateNameBanner.js\":\"56507dbb80d92271\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/collisionMerge.js\":\"c83a8cbdadc872d9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/dataExtension.js\":\"32828f5f62510eb6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/index.js\":\"27986d6aef763e87\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/mergeCollisionAction.js\":\"f321958bd988083b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/pageStyling.js\":\"41bd41acd3b5d42a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/rejectionToast.js\":\"b2b7e2b5c165c373\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/syncProcessor.js\":\"457decdc4f3a3889\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/actions.js\":\"01ad450fad7e6b57\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/addComment.js\":\"730ce68c6c84adc0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/anchor.js\":\"0c5588a3d034b3c5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/anchorState.js\":\"1e5bdfb04b371138\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/commentLinks.js\":\"b766edfb66e251c9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/confirmThreadDeletion.js\":\"e19250d2a2f451c3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/container.js\":\"5e4217ee58399f9a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/dataExtension.js\":\"b17c72698b0f6252\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/deleteComment.js\":\"f8a48f6b18ab1fbd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/highlights.js\":\"ee8693470a8f0386\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/index.js\":\"3edcc91ab1ace993\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/linkedCommentsPill.js\":\"e4c4656d25312f62\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/margin.js\":\"1299e5e1fec08e45\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/marginSchema.js\":\"d69114cb71632972\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/newComment.js\":\"b2d2f718f760c754\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/ownThreadPicker.js\":\"7979c65da075a993\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/placement.js\":\"5d373ab1ceb00193\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/queries.js\":\"f0605fdc4777ec96\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotePosition.js\":\"00b397427ec2545d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotedIn.js\":\"1780849c78059c95\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotedRange.js\":\"58b6f73f9dd1de0d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/rangeRefs.js\":\"ebd8af900acd6c30\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readHighlights.js\":\"fe14178108758568\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readSelection.js\":\"9dfc1eec362a8dde\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readSelectionUi.js\":\"bc627e18bb499e41\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/reanchor.js\":\"f830bf95e496bdfb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/schema.js\":\"2f84e3115168f69a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/scope.js\":\"3c7974021dd45db5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/scopeThreads.js\":\"8c8dc101a70da2f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/splitRetarget.js\":\"52b28d22166abb71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/suggestionCard.js\":\"f8ac9c8bf743230a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/suggestions.js\":\"5072bdd668c29d7e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/summaries.js\":\"38b624dc54292b88\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/summaryBatch.js\":\"43134837fc364fbb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/surface.js\":\"25e260a24b1d2cc4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/threadNavigation.js\":\"3ab5c5f9be5520a8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/threads.js\":\"60ac9101bf81f5d7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/ui.js\":\"1014a312e7b65da5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/uiStore.js\":\"cbf7fcf87a2062f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-intents/appIntents.js\":\"05d7c04acf4d54fe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-intents/index.js\":\"0134179216275bf2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-update-prompt/index.js\":\"d4b65b5ff6085ec4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-update-prompt/status.js\":\"3491ddb07d90af9f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b6fcaa6cd0f81b98\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaBlockRenderer.js\":\"390608e0fb4a0653\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8c0f2b231a102763\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaUploadReconciler.js\":\"0b198bafca838f48\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetDownLane.js\":\"d599e08d7a17cd76\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetResolver.js\":\"eefb981fd2f4b1a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetUpload.js\":\"7a18c2bdf3ef6a64\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/attachmentCleanerIO.js\":\"e5b15d2bb5ced669\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/supabaseAuditIO.js\":\"797a19b48981aab7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/blobStore.js\":\"c59e8575b84bf807\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/browserMedia.js\":\"b3513a032ce8ef49\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/byteStore.js\":\"ac2def1215d7d39a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/cleanerIO.js\":\"6925aeeb88becfb3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/cleanupAttachments.js\":\"5d9ba9fdf34282d5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/dataExtension.js\":\"6855f1e0dcfc609d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/downLane.js\":\"a780ce5e4eab35a2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/index.js\":\"e1407177004d03c0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/insertImageContribution.js\":\"3e6d4ad7e72df423\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/laneArming.js\":\"449ef2b2268caf3e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/laneLock.js\":\"8e0706873a551ebc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaBlock.js\":\"36e956f5aaaa08be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaCapture.js\":\"2388badb95ec5b70\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaLanes.js\":\"a0283802e153d906\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaViewers.js\":\"4a1cdd6a9d9c861e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaViewersFacet.js\":\"c559ff27bb2a0c81\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/pasteCapture.js\":\"d8df45db56de5887\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/resolver.js\":\"642a5e520c279b39\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/retryUploadsAction.js\":\"f38caf17f4af8a59\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/storagePaths.js\":\"047aba7fba3381ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadDrain.js\":\"8ba860d59f4286cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadLaneStatus.js\":\"12554bd02d4ddf84\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadReconcile.js\":\"a1a195c2068364fc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadRecovery.js\":\"e613193ac164c598\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadStore.js\":\"b356c615c50f54bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/useAssetObjectUrl.js\":\"a004b5bae41af36d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"732231befcb2b525\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/BacklinksViewSection.js\":\"48206a478792e2ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/facet.js\":\"1ac3e63ecd4a3740\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/index.js\":\"86e312f617b870c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/prop.js\":\"70a318742d0ef4f2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BacklinkFilters.js\":\"84580994d3056add\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"970120cad40eb54d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BlockEntry.js\":\"f83ef5a5f5ba5818\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/LinkedReferences.js\":\"aebe04636e256d03\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"426c7289b59ef146\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/dailyNoteDefaults.js\":\"dbda415f09306152\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/dataExtension.js\":\"b42a562723b6eab0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/edgeExclusions.js\":\"639d54aea3befb88\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/filterProperty.js\":\"ad4d25b0c89e6452\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/index.js\":\"1e754236fbc653e1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a9203015014e1d3c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/applies.js\":\"1907377bd2f5a061\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/countQuery.js\":\"76fd5dd96b25685a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4d8cc7763cbc04a5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/index.js\":\"f3c4a2bab36c825e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"228e54952c90db87\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/presentationInvalidation.js\":\"c4983177defa7630\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/propertyEditorOverride.js\":\"77687254f325da8e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/propertyFilter.js\":\"e59b948772a296c5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/query.js\":\"011cd3fe5f347922\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/resolveFilter.js\":\"f8ff68383e2b24a2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/sourceBatch.js\":\"ac72665a4aac837e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/sources.js\":\"ee9f4286c156576d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/useBacklinks.js\":\"ef85ca692f59bab8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"14a80a2dfd6af6f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/BirthdayCelebration.js\":\"b21748251391e7a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/BirthdayOverlay.js\":\"47a42e360a6e7cf7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/gate.js\":\"494034c8bb7e3652\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/index.js\":\"f203d06eaf2eb316\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/wolfTheme.js\":\"8091c205685da005\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/BlockDragLayer.js\":\"559b99d12338e173\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/dragController.js\":\"fff02ffeb93e7b82\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/dropTarget.js\":\"578c6da78fe7a721\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/index.js\":\"9870f3b598d40e47\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/projection.js\":\"8de310eeeb7916e9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-info/BlockMetaCard.js\":\"978dd8c502241a87\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-info/index.js\":\"5276645bd1e68728\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/AddTagDialog.js\":\"e83272070e402212\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c3eeb79faa077977\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/TagNameIssueHint.js\":\"b1c0be8ddda771bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/addTagAction.js\":\"af95e474d2ae9a6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/appendTag.js\":\"e7dc1eac53afbaba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/config.js\":\"11c58855044553d6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/dataExtension.js\":\"95a1912e7680ca7b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/index.js\":\"97bfb2629b04a27a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/propertyEditorOverride.js\":\"0682096a827edfb8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f269449107ce4625\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"96d5815be9493dc9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/Breadcrumbs.js\":\"70ee9833ea4afe24\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"15f00d0898a17aca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"234bd586d965dfe9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/index.js\":\"185da1a25a869a1d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"47bd305b85c6d4f3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/CharacterCountItem.js\":\"a1c4d03b3c5c5938\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/ProfilePropertyEditor.js\":\"690ca9ab5860d5d1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/actions.js\":\"32adf465632da728\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/blockType.js\":\"fb627331ab13725c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/charCount.js\":\"abda1b5a09d75a10\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/dataExtension.js\":\"30225d80a2bddf95\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/index.js\":\"b7c5c2c8a20a6925\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/profiles.js\":\"b6831aa810240212\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/properties.js\":\"bbcb44f3a7e2512d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/textCounts.js\":\"45f28c6d941cae8e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/colemak-keybindings/index.js\":\"d5a99a1a9187232f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/CommandPalette.js\":\"fe031da10d0ea766\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/HeaderItem.js\":\"4cae3bd365b94db3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/context.js\":\"456fa8a60367bea6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/index.js\":\"16add82e7fb2530e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/selection.js\":\"85d65174251fd504\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/toggleStore.js\":\"9240b46f573d4cc9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/useCommandPaletteActions.js\":\"d95a5548833b1f43\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/ContributorBadges.js\":\"15ac5ee5b22b6b13\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/author.js\":\"e643e205f9824f77\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/codeMirrorExtensions.js\":\"421208d79bf85406\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/dataExtension.js\":\"0835e3b1604dc71a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/index.js\":\"0b7411cbc8bde439\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/mentionAutocomplete.js\":\"9d351f0ea03ee401\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/processor.js\":\"0841dc989ce832c9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/profiles.js\":\"fd7d381228a8fbda\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/queries.js\":\"ba4efd95263f19c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/schema.js\":\"3b66a7eb7228a8c7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7cd9b0ca6f879ceb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/followOrigin.js\":\"438efd5a3f5b53a5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/index.js\":\"c6a39c051646c350\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"895b12b290542bb9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c18f80bbfbd6f749\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/CalendarGrid.js\":\"87e366592c7094ef\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DailyNotePicker.js\":\"6c4f7fb49c7b095b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f02bababcaa1281c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateNavDecorator.js\":\"08dd38b851214446\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateScrubOverlay.js\":\"3c03907515759d66\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/HeaderItem.js\":\"32cc0588bea2eb72\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/ReschedulePicker.js\":\"448e14bf3f4ece38\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/SpreadDatesDialog.js\":\"177ee112d8df94ed\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/actions.js\":\"d5fd7cf9bad09196\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/blockDateAdapter.js\":\"535893b7f3c03717\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/calendar.js\":\"78a1d0180281bddb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dailyNotes.js\":\"e1d32e451b515a52\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dataExtension.js\":\"17bf9dfe75216cdb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubActions.js\":\"253b4d7f5f728f6c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubGesture.js\":\"16a4a51836b6959f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3efba8f36d3183f9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3fda0ed98bc36e25\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/deletionGuard.js\":\"30046081a8fb01be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dueQuery.js\":\"771498b688c8da78\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/index.js\":\"aea519b2d26a38ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/landing.js\":\"b0d98afbbcd247b7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/localSchema.js\":\"aed5c6f75bdd3365\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/referenceDateAdapter.js\":\"c5c05ca7fcf307a4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/rescheduleAction.js\":\"c8405ced73a7fe4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/schema.js\":\"3dab1a10ff8c98af\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/spreadBlockDates.js\":\"ee9cf8e45a17ea4a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/spreadDatesAction.js\":\"c7b8e54f5d2494d4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/today.js\":\"c35e61c5981eafd8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7c01ab4bb2e4be4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8de3a61334543871\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/audit.js\":\"9dff59be1505511c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/auditAction.js\":\"c101b224150d9dc1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/auditRanges.js\":\"7577b9e0bcecad3b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/diagnosticsSource.js\":\"5d012166f2d83be0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/divergenceScan.js\":\"b6f6a149d9df982a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/index.js\":\"9703f32c9e0eb1e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a8af70804f245744\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/referencesMirror.js\":\"0e139bef8726897a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/rowJson.js\":\"63f6b4a0c9d33718\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/schedule.js\":\"a7a9367d8171f575\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/store.js\":\"7a5c1ffde3049a2f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/action.js\":\"7caa3d4849b93ec9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/index.js\":\"872d91a7bb085218\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/plugin.js\":\"053c66b0f6db0c23\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"393b2d0636ac0a7a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/actions.js\":\"50cf3aad40b82654\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/changeMarker.js\":\"0e7374141b318a52\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/diagnostics.js\":\"4959236fa25c280a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/fileSystemAccess.js\":\"26080b5f33e22415\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/filenames.js\":\"01c3933e2a735e7f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/index.js\":\"08d4b6a2d2d4eab8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/mirror.js\":\"13831b91aae3a93e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/runLock.js\":\"8b554d2f2152c2cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/runtimeHealth.js\":\"9e9ffc27ded1dd06\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/schedule.js\":\"ec1a1d23ade0beb7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/store.js\":\"d393dd845808d7c5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/default-themes/index.js\":\"25b48ada5f448559\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/default-themes/themes.js\":\"4805ec30c12c6cf6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/diagnostics/facet.js\":\"938857315972fe71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/diagnostics/useDiagnostics.js\":\"b210f59b302c6732\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/dismissals.js\":\"e9df099508738e88\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/index.js\":\"879787dd27f143ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/status.js\":\"f8a6943bc0d04c34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/store.js\":\"43f7414c5ffe221c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4173959ef3d3e975\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/ExtensionsSettings.js\":\"df98444aa6990599\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/actions.js\":\"778f428d2ef84590\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/config.js\":\"e5785cc24c9a6539\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/dataExtension.js\":\"39e9bff40e8133bd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/effect.js\":\"d3ef1d90b59a92c3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/index.js\":\"321d5fddbd04a295\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/propertyEditorOverride.js\":\"308e13d71bd42fd3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/useToggleTree.js\":\"035616cadb223618\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/ExtractTypeDialog.js\":\"d1895ee323efc03b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"662509395e4f27df\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/PropertyShapePicker.js\":\"2d12742c158587e0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/action.js\":\"c0cb200adafcfee9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/index.js\":\"cb4cc5e2714126df\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/FindReplaceDialog.js\":\"ccbf30cc5ccc0e3e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/HeaderItem.js\":\"1e3f4d5cd611939a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/dataExtension.js\":\"162527aa7068060b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/index.js\":\"2dbe68abc1bf28b2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/search.js\":\"4bd3935ddeeca94d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/toggleStore.js\":\"62323b1025b3c657\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/LocationPropertyEditor.js\":\"0da8459a176dd576\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/MapView.js\":\"4dc51eeb7a636dc8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/blockTypes.js\":\"34b309b167f8cd1d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/codeMirrorExtensions.js\":\"c4ff2ca4e754344f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/createOrFindPlace.js\":\"842f561540bbf2cc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/currentLocation.js\":\"3219679aad83cf4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/dataExtension.js\":\"a1f5252b2033c165\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/geoContentDecorator.js\":\"485a4dfbcfcac27a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/googlePlacesClient.js\":\"4371aa6d0267f561\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/index.js\":\"9f73b8e5c4187867\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/locationsPage.js\":\"8fc7b60c4c3dfa47\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/mapViewport.js\":\"83c8b8c62172c085\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/pickCurrentLocation.js\":\"e076aff442bfcbfe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/placeAutocomplete.js\":\"c3a4316a1255a761\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/placeNameCollision.js\":\"4357307b04e904db\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/properties.js\":\"09a4611210783dff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/propertyEditorOverrides.js\":\"c23f5fe7b5cfd92a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/query.js\":\"8ce6f5db4384e09f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/usePlaceSearch.js\":\"3a89acf9ee65f6c0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"950ea00a87ab1c8b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1da09421be37e054\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8f43ad8084c9ba80\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/config.js\":\"957a26cb4533f88d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/dataExtension.js\":\"79e2dff518d3cdd3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/facet.js\":\"f62ae0a4912f8b4b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/grouping.js\":\"915749ba20555564\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/index.js\":\"510cb77af20b273a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0930e9c2f0ef5b9e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/query.js\":\"75db1907d4a0eeb4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/resolveConfig.js\":\"9fcb103dc3cfb58d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e89706f8571dc843\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5a9fb10b7dd4b2fe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/HtmlDocumentContent.js\":\"b88df3970f040053\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/HtmlFrame.js\":\"ca4d9d6115554b84\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/actions.js\":\"aad8fd7e156a5e52\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/blockType.js\":\"7c6c3570517f0c52\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/confirmRunScripts.js\":\"1450d896dd608c92\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/dataExtension.js\":\"606e533ce08e711d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameAnnotations.js\":\"669d3d24ec8a4037\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameDocument.js\":\"8afdd00a21af20b9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameTheme.js\":\"011e742ef504b412\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/index.js\":\"0cbad6dc6b84cfcb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/scriptConsent.js\":\"1fb94e1ed447cf14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/sourceMap.js\":\"12e2e80737b0b682\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/useDocumentScripts.js\":\"a062f4b3057a1702\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/index.js\":\"b2b1efe785ca0f22\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/record.js\":\"2767449a0327ce88\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/recordStore.js\":\"de16d37d570fd2e2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/responsiveness.js\":\"bcc629a2e4ea6974\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/schedule.js\":\"ea17bb94ec8cf569\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/sessionContext.js\":\"b96f9d7b5d3addac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"95ffac593f7384af\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b3cafcbaffaaa1ba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/actions.js\":\"3973cbbdd4a7feef\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/config.js\":\"11fe74447ef37a59\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/dataExtension.js\":\"c9d6b51ece9d88b6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/effect.js\":\"2c9a9161c96d7e9f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/index.js\":\"22f52fda29b0592c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/keyCapture.js\":\"1edb8dce9af99b5d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/overrideStore.js\":\"8e4ce36569482b70\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"46c77dc549fe7a09\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/HeaderItem.js\":\"0d21cca18527c976\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/LeftSidebar.js\":\"61904ffc8bd9d686\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/actions.js\":\"806faa750a4c3d54\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/facet.js\":\"e6684c2554bc0dc7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/index.js\":\"a267488113f79a0c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/shortcuts.js\":\"344e0a3efa0cda0c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/toggleStore.js\":\"e6f4614f2b45152a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/MergePicker.js\":\"a1cbd5f3923e33e9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/index.js\":\"d742455a4ba1693b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/mergeAction.js\":\"1f2f8e32ae631181\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/strategy.js\":\"b33f2d9ddfe52bd9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/Button.js\":\"40cae0e2db54088a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0852769c8d4e1cd7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5bfd4e1a1c01063f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/facet.js\":\"9788ce39811de889\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/index.js\":\"741992f5d4d3a20b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5516ab49bf2e76ae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e72ca1421b193fff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0796f80aa266ba48\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8e75d2a951abe142\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/index.js\":\"335def07f4488b9b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/MoveDestinationPicker.js\":\"29718cd1e604d7ac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d362af6da6943a4b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/contextMenuItem.js\":\"3be32ff6a4bdff94\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/index.js\":\"7978ab6c97f9cab2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/moveAction.js\":\"d2d83495480fd3dc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/moveBlocks.js\":\"83bfedb1202a7e94\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/selectionAfterMove.js\":\"6066749adf9e17d1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/TutorialBanner.js\":\"96ee017893d4af5d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/action.js\":\"75df99eceac1906c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/bannerDismissal.js\":\"0c3b8cc8125c6f16\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/documents/cheatSheet.js\":\"6fcdc8e08bfcb8a5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/index.js\":\"a40aa45211b5a9d7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/keys.js\":\"92c91c1c50e73ac8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/landing.js\":\"b106d3e9e01dd493\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/outline.js\":\"e0a5635710178396\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/seed.js\":\"fdad059f20c38328\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/PerfTrendDialog.js\":\"9bc540ede177921a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/analyze.js\":\"5459f100b61ca9c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/diagnosticsSource.js\":\"47fd42a6b42ccb6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/index.js\":\"bc131d5589251856\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/load.js\":\"86ce99ddbba09f90\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/monitorRun.js\":\"5ba91de9e27eb345\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/schedule.js\":\"0ce59621425622be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/series.js\":\"0b76d71e2690cb86\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/store.js\":\"616c9f9bd854ffb0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/trendAction.js\":\"87c94b845f9e9556\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/verdict.js\":\"aff910b0e2a3deb3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/clickToEditAction.js\":\"2a88ad19898678cf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/index.js\":\"fa1eaee1b20d4baf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/interactions.js\":\"7886421fa87dda54\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"35d8fb8ee3051d87\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/MigrationGate.js\":\"e20bb9677b88cc97\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/MigrationGateDialog.js\":\"b2c3fe34014170c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/action.js\":\"9920770743c77355\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/index.js\":\"5db9748bda2f3099\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/localRunMessage.js\":\"5404c4a086de2a67\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/plugin.js\":\"bb7b2e445d9067aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/progressReport.js\":\"74b63104afbe8687\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/sweepProgress.js\":\"d0f339f3bd23548c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/FieldRowRenderer.js\":\"7c0b9337864067fe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/ValueRowRenderer.js\":\"6411d54a956fe890\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/actions.js\":\"bd6a0c3ca76c2917\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/autocomplete.js\":\"67a4bbfc9bf15197\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/fieldRow.js\":\"81e1330237291b26\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/index.js\":\"97c43a0c5e6750e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/referenceWarning.js\":\"a66b60d9ffacac11\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/valueAutocomplete.js\":\"7c613c226fd5bffe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/valueSchema.js\":\"4e6cfb113ac8ca0f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/HeaderItem.js\":\"e1760ccad6c3ddcd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/QuickFind.js\":\"d04993aded105f56\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/index.js\":\"99fd136240c32b59\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/recents.js\":\"267967817b2644a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/resultItems.js\":\"e74c6fdf850cac8b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/selection.js\":\"8bb9c196578215b2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/toggleStore.js\":\"9002608c44a0a9ff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/HeaderItem.js\":\"71782338013bb93f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/RecentsPageBlockRenderer.js\":\"46247a5ba0559ab4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/grouping.js\":\"e86011bbe8218bbe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/index.js\":\"32d2d746e1604d21\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/target.js\":\"3e1383e83bb51d8c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/codeMirrorExtensions.js\":\"34a3128063795b87\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/contentPrefill.js\":\"9266ac2f915e0b99\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/dataExtension.js\":\"a97fd3579e66329e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/index.js\":\"3b703c876ee91fc4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a5d5a91cbdb82e4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/invalidation.js\":\"bafcc8da45c27c4d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/localSchema.js\":\"b5c593598959afb8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/blockrefs/index.js\":\"a812fd7ebcc8beff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e04b35f9f0b0c4aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/index.js\":\"75f8ebdd7d3dc934\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/referenceNode.js\":\"a3fa2043705f653f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c0e1877008565526\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b72d51e5d848198a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/index.js\":\"d0ee310a30a0621b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c33520e8458519c0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9f8ee2b916fbb33f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/mergeRetargetProcessor.js\":\"dd59be0dc7d0d9bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/parseFence.js\":\"7cb8c606263bd89e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referenceParser.js\":\"3348a4a17070bba5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referenceProjection.js\":\"1592de67216c6064\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referencesProcessor.js\":\"d6fde774fdab9f4e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/renameProcessor.js\":\"f8a676feb8c611a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/spanReplacement.js\":\"8cc73a79a1bc5c89\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/htmlToOutline.js\":\"1ba1b2aa5a154b22\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/index.js\":\"1ce99ed5711da8d3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/normalizeClipboardDom.js\":\"15560db32c5645b5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/pasteDecision.js\":\"ddd4f956d1df7bba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/action.js\":\"0fb0437de8927a58\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/blockIds.js\":\"5f567176fa7c5702\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/content.js\":\"66e0bc8621c82441\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/effect.js\":\"601e415ced352f3e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/ids.js\":\"0f9876fbd455fe58\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/import.js\":\"b45235d2fb7b3b9f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/index.js\":\"b75e49257303b667\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/plan.js\":\"fc8c03aca0351284\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/plugin.js\":\"81aaa6a23877b5ac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/promotion.js\":\"d3d4278fb6b8100d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/properties.js\":\"c4004ed279ba2b19\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/references.js\":\"1f7a6fd440efef95\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/report.js\":\"fb071f9ea1bb8eb4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/roamMemo.js\":\"e52c20ba37f3c96a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/runtime.js\":\"fa2cf6595b0f98ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/schemaReconciliation.js\":\"5f00387a0ec11134\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/srsMarkers.js\":\"86fe6d3ccae92095\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/todo.js\":\"14c442c28114b762\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/typeCandidates.js\":\"967399622c80a043\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/types.js\":\"b522b526e5a66eb1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/search-health/index.js\":\"bbf119c1f7eb5121\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/search-health/store.js\":\"71e9ad55bf3d9e9b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/HeaderItem.js\":\"4a3edcac441e37bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"90c63aaaf27f4001\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/index.js\":\"b8c715c9e68f4858\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/model.js\":\"b1841167767162f4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/toggleStore.js\":\"ac811b0e6f84f43f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/useKeyInspector.js\":\"ec78d2078bcfa1ce\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"556b13cb559d9a9c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/ShellDecorator.js\":\"0928be809efe3569\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/actions.js\":\"8a51c6ebb4055239\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/exclusionsFacet.js\":\"da441ef2853fb212\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/index.js\":\"e928ecc1c419ff5e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/shell.js\":\"cd84610e57c8492a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/surface.js\":\"62e81cc675cf7bde\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/walker.js\":\"9f07252371f6ae6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/RescheduleToast.js\":\"96196a8ac3a2f1ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/dataExtension.js\":\"886c9041c635dce6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/index.js\":\"9e42616ff6bc7ac7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/indicator.js\":\"341752bcd8ebc6ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/moveSrsState.js\":\"385ade142c007c8a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5e410d33ceaff871\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/scheduler.js\":\"27f01d7cea3dd557\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/schema.js\":\"16d81bdc2f821ffd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ef49af6cc748282a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/srsClipboard.js\":\"7783953f79b936cc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6ef8ef53346ac117\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9df284cd7538ee43\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/DeckPicker.js\":\"51a550b58816a6cb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewControls.js\":\"ac2237332d6231f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5c1b7d60c4fc89fd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewSession.js\":\"ede3bc61f9b79b78\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/actions.js\":\"2007347d677a0e23\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/archive.js\":\"6909c57926ef2ce2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/dataExtension.js\":\"bd1a35021193eaaf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/deck.js\":\"7b9074eb3cd7902f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/dueQuery.js\":\"6e42f997f2de5320\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/gradeDecision.js\":\"0922d2e37b84d4f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/index.js\":\"d92e5a7a53f0029f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/keyHints.js\":\"aba33d7b04bd0362\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/reviewCardLayout.js\":\"952ae13b8c5edb78\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/reviewProgress.js\":\"0964fbc38861c4ef\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/schema.js\":\"f15af98bdde560d5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/useDueCards.js\":\"87928d1cbf3a54a5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/startup-metrics/index.js\":\"9fd966fc56c01628\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/startup-metrics/record.js\":\"f6f6fe5f7c78ac29\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/index.js\":\"2d5f5f652fd0da6f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/persistenceStatus.js\":\"da1bd403455a0684\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/requestAction.js\":\"69630031822a60c0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/TypeChipsDecorator.js\":\"ce3cce1d0ac20064\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/codeMirrorExtensions.js\":\"69257cc6582e6455\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/index.js\":\"6a12e811474be2a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/typeAutocomplete.js\":\"a27f300ce6cc551f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a3e6a059ff20e4bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/actions.js\":\"ac71b0a3d9dae5c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/anchor.js\":\"c5b16fd4032bbb27\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/events.js\":\"224add291a3d4eaf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/gestureActions.js\":\"869f2212115fcee3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/index.js\":\"d9b601b46c70e299\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8e4542191e0732c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/collect.js\":\"0743fcb6f283530e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/index.js\":\"f2cd4703b226eb0d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/record.js\":\"91714fb0e0327a7f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/RejectionDialog.js\":\"5d1a43abf9e2902d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/SystemStatusHeaderItem.js\":\"487bca2b52f72bea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/index.js\":\"2b0f4408aeb9722d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/model.js\":\"28e68bab767f2513\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/queueCounts.js\":\"02f398eab62b3d95\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/rejectedHelpers.js\":\"417d7255d99a4321\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/rematerializeAction.js\":\"e76f5bdd2dcd1023\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/useHysteresis.js\":\"1eb6009a6b684d3a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/ColumnHeaders.js\":\"54088581e3960472\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/QueryUi.js\":\"4d7b0e5311254f0d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/TableLayout.js\":\"57744edd5b3f7a03\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/actions.js\":\"03794311cd7664dc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/cellEdits.js\":\"c788788035585360\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/childrenViews.js\":\"31d3b679965db232\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/columns.js\":\"7a2d26cfcaf105f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/controller.js\":\"1155247f72cb675c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/convert.js\":\"66c3fb6f97a2811c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/dataExtension.js\":\"9c0ce975aeffa67c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/index.js\":\"59296db87701cb73\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/keys.js\":\"9925779a55036be2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/model.js\":\"fa631cbf62d7b7a6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/backfill.js\":\"4c93b68df8ca593b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/completion.js\":\"28df46a69f811294\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/format.js\":\"245ff94b1a177643\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/parse.js\":\"78f6196dcbe06409\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/queryValue.js\":\"4888248d94eaf72a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/source.js\":\"3a684443031a7bcb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/registry.js\":\"9a0e06c5df962127\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/rowGutter.js\":\"d4ccc3e74f3a05c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/rowVerbs.js\":\"4bc992c07a4f1d4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/schema.js\":\"a23aa692c4027764\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/sort.js\":\"6641db8781a1ce48\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/effect.js\":\"bf9727685494ebc1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/index.js\":\"4979c2974ad34a62\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/theme.js\":\"db8490108d2bd4a4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/actions.js\":\"75995730d4864dca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/dataExtension.js\":\"b667d968468577a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/index.js\":\"22679111c63e7b34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/schema.js\":\"c7ed953778b5a943\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c8f90309969e40bd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/actions.js\":\"420803f963ea0b83\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/defaultItems.js\":\"7be304582afdc757\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/facet.js\":\"95c3a1fa81cab510\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/holdRecognizer.js\":\"8081d92c745b4334\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/index.js\":\"93b0008b220024a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/UpdateIndicator.js\":\"063c2155d621c7be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/index.js\":\"b82ac55dbb4a4ffe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/loadTimes.js\":\"419e1d2e2b7f2a18\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoNotesRenderer.js\":\"e32d2abe3d3dbabe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoPlayerRenderer.js\":\"59295d90a3468b9b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoTimeStamp.js\":\"6443e7467e8d9fc8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/actions.js\":\"7170a957ad85a09a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/index.js\":\"6704454f8f25414f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/markdown.js\":\"1d7513d28b1a229c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/notes.js\":\"95e5d095efd40664\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/registry.js\":\"381cadc199f14cd6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/remark-timestamps.js\":\"0093983aa71612cf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/view.js\":\"38b33e170686bd72\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/LinkHints.js\":\"2eaed941f6e1b407\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/index.js\":\"d4f87bce3105c638\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/model.js\":\"d1a45d8b1d39fdff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/settings.js\":\"742b3750df5df64f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/actions.js\":\"a4ce54e518b472d9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/index.js\":\"6023dc75ca6f5668\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/interactions.js\":\"0deb1984f323e30a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/workspace-header/index.js\":\"a133fa4af28c1cba\",\"/knowledge-medium/pr-preview/pr-1872/src/registerServiceWorker.js\":\"4e7198633af08fcc\",\"/knowledge-medium/pr-preview/pr-1872/src/requestPersistentStorage.js\":\"8c0df14d5d07e858\",\"/knowledge-medium/pr-preview/pr-1872/src/services/authRequestDeadline.js\":\"4e696eeb219e8a67\",\"/knowledge-medium/pr-preview/pr-1872/src/services/authStorage.js\":\"e524206d30728a77\",\"/knowledge-medium/pr-preview/pr-1872/src/services/powersync.js\":\"2c2314687828e8ac\",\"/knowledge-medium/pr-preview/pr-1872/src/services/supabase.js\":\"60558bb2f25539b3\",\"/knowledge-medium/pr-preview/pr-1872/src/services/uploadErrorClassifier.js\":\"2d901f7941676480\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/ActiveContexts.js\":\"7b9ba09daf61c607\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/HotkeyReconciler.js\":\"b5afcb15d4574ba9\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/WipeLocalDataDialog.js\":\"990d4c0bb0dd06e3\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/actionDispatch.js\":\"e9e810c6de641eb2\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/actionRefItems.js\":\"ad58615309e0d901\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/applyKeybindingOverrides.js\":\"869669004f30e597\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/blockActions.js\":\"18bbf4741d2c15a1\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/blockMergeGesture.js\":\"ab4fba73034030d3\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/canonicalizeChord.js\":\"9c381198562db561\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/defaultContexts.js\":\"3f04f7e6d8e880ac\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/defaultShortcuts.js\":\"0f6fd369cd455d29\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/effectiveActions.js\":\"75240b0c32bcf267\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/gestureAction.js\":\"cdcaa6e2f5f104fa\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/gestureBinding.js\":\"1b20d1e7a3e63234\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/holdRegistry.js\":\"c796c5cfb11d71c8\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/keybindingConflicts.js\":\"323ce99769c68120\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/keybindingOverrides.js\":\"b56cb2af8dc27494\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/pointerAction.js\":\"451c48283c96ba67\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/resolve.js\":\"a5b1a8cc40a11a0c\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/runAction.js\":\"17acbc32f1481ac9\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/sequenceMatcher.js\":\"f93ca0d27e4be77c\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/types.js\":\"1a80ce8fea5390d5\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/useActionContext.js\":\"0b0af32ed5d74851\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/useActionDiscovery.js\":\"2e621d84fd34fb3d\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/utils.js\":\"c3506f1718cb1bea\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/bootStore.js\":\"7d28866e89561118\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/previewDatabases.js\":\"04989a2efd273012\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/byteTransform.js\":\"6721056bf3c157ab\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/attachmentCleaner.js\":\"13159840ce686a4a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/attachmentParts.js\":\"b207ce41fb52e6b7\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/bundleParts.js\":\"40f1dc8cad1730dd\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/bundleRecord.js\":\"fc695ae22b857f28\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/manifest.js\":\"14ecacfef7bc5d40\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/takeBundle.js\":\"8953f449a19f8463\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/verifyBundle.js\":\"3650a7bffc72fe6c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/cleaningStage.js\":\"803a942f92221680\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionKey.js\":\"aa701b4ed2cc96ae\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionServer.js\":\"ae569de906c6c1ad\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/flip.js\":\"2b613a78b1e8ea5f\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/flipAttempts.js\":\"cd814d207e345c8c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/pages.js\":\"b3c743a12170dbef\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/preflight.js\":\"334db0f14f51dbd6\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/reseal.js\":\"8b1dd863866afc26\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/runConversion.js\":\"d83f1d5482bb482b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/runLock.js\":\"c4380c24acffc03c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/sealing.js\":\"9361a0e1518e4a5b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/sealingStage.js\":\"9dc15fe6ca88bf6d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/stage.js\":\"a3a667ec46a0e79b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/verifyReseal.js\":\"e572013161fe3746\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/aad.js\":\"749e3490e0e50802\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/aead.js\":\"09174b3f748d0a9c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/base32.js\":\"f1db234fc10c7d2c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/base64url.js\":\"ed3261f57051db5a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/binaryEnvelope.js\":\"6225d040fb76ebe6\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/byteAead.js\":\"e699c52b5e3a0697\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/canary.js\":\"b22d27139d0da28c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/contentHash.js\":\"87f7a7c8ae15020e\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/contentKey.js\":\"40a97ad4bfce71eb\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/derivedIdNamespace.js\":\"2e7fadbead8a3932\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/envelope.js\":\"8f3e511c663b6498\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/hex.js\":\"3033565268d79120\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/sha256Hex.js\":\"cf25aa93765ba53e\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/workspaceKey.js\":\"541fe5ce2c7e37eb\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/conversionState.js\":\"24971ae41d758445\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/createEncryptedWorkspace.js\":\"346c51a4c12ce555\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/pastedKey.js\":\"61917ba013a56ac7\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f6ed72cda4f6c6ce\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bf772af716761837\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/keyStore.js\":\"2ed314143f5e3ce9\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/mintWorkspaceKey.js\":\"75f30d2f3c1f06ef\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/modePin.js\":\"e891221cf86f0be3\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/openWorkspaceKeys.js\":\"a037d7d9a4496151\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/resolveWorkspaceEntry.js\":\"8c87bd5833f97c27\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/resolver.js\":\"dc7816110d3cb946\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/workspaceAccess.js\":\"7519dec78ea3307a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/transform.js\":\"49620590c4c67e20\",\"/knowledge-medium/pr-preview/pr-1872/src/themeBootDefaults.js\":\"f9e8aea73ea3b501\",\"/knowledge-medium/pr-preview/pr-1872/src/types.js\":\"beb05563c007eba2\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/ClientLocalSettings.js\":\"b25727c25b1b2cde\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/abortableSleep.js\":\"38a0a3c39c0417af\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/array.js\":\"13eb8dd98c2f3406\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/backlinkAutocomplete.js\":\"0482136d4148ff86\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/blockCrumbs.js\":\"da3f7175fa6a7a5b\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/blockrefAutocomplete.js\":\"f8bfbabd80c96fac\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/cadencedIdleJob.js\":\"25d052ea9891a420\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/callbackSet.js\":\"c22ce5c1d31ecdbc\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/clientId.js\":\"d99372fb920de700\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/codemirror.js\":\"67f3b879b607469c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/codemirrorCompletion.js\":\"216457b3239dcbf3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/copy.js\":\"a415a8dd81de4f88\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dailyPage.js\":\"f1713e377dfe4f77\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dbForensics.js\":\"eb44d2aee22af565\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dbForensicsHooks.js\":\"47e63268068acd7f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/deleteBlockThroughUi.js\":\"81a5fc6a004bd147\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dialogs.js\":\"11646d53632c1580\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dom.js\":\"5d916cf400e783bb\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/downloadBlob.js\":\"573e1620114d6c0d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/drawnWalk.js\":\"781c04eda7be8b64\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/exportSqliteDb.js\":\"3710968ff229dea7\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fileSystemAccess.js\":\"f5f8e6d71793680d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/flipSlide.js\":\"098644da77f698c8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fnv1a.js\":\"92e48f9b7b6ccc40\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/formatBytes.js\":\"d9a743c09e4401d1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fuzzyRank.js\":\"1db8502cd82052fb\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/idbKeyedStore.js\":\"334d31af95463b4a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/idleCallbackPolyfill.js\":\"14cc040c169a1220\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/keyboardAwareScroll.js\":\"940cc9274d0e0401\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/keyboardViewport.js\":\"da2fdfac0701df05\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/lastWorkspace.js\":\"ed406a6f8e9cf6ae\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutColumns.js\":\"5418116c5c4d15d4\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutSessionDom.js\":\"ea4baebee5c6d048\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutSessionId.js\":\"348a703da858c18e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/linkClickGestures.js\":\"038424442a08ca9b\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/linkTargetAutocomplete.js\":\"5ba3a5f8bb26464f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/localDbCorruption.js\":\"32730898d980392c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/localDbRecovery.js\":\"edbb8811e0d935ab\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/markdownParser.js\":\"a6cd737a09c63f82\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/memoize.js\":\"a3a33fca91b77027\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/nameFieldCommit.js\":\"bdc297881c8acced\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/nameList.js\":\"d437c65b0b4d6777\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/navigation.js\":\"8ff96445b64b978a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/omnilinerNamespace.js\":\"680bd9a86f9b6d74\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/opfsPageScan.js\":\"400c6f3f922481a6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelClearance.js\":\"52b0221e4203ffec\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelHistory.js\":\"668e504ed69585ad\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelLanes.js\":\"8bbe865d4f4d18e6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelLayoutProjection.js\":\"0a3f86e97aec4c7e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelScrollAnchor.js\":\"43363e817149be67\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelUrlFlags.js\":\"9f98570ae3b30f89\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/platform.js\":\"19a2128b16079bc8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/pluralize.js\":\"d7dc5f6e73e29e95\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyCreation.js\":\"71f4944426714bc0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyNavigation.js\":\"e975acf3691d5b39\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyValueContext.js\":\"34b9bd12c84a7cf9\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/react.js\":\"1702b99b1ab0c402\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/relativeDate.js\":\"9a79604e8432b119\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/relativeTime.js\":\"1d709073c68567d8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/renderScope.js\":\"51ecf33001c18600\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/resolvedThenable.js\":\"7bee7720773faf83\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/routing.js\":\"d9cd1fc825fec502\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/safeMode.js\":\"484dab28c0dc7c21\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/scheduleIdle.js\":\"9a30b515db7d3236\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/screenWakeLock.js\":\"a07259aebe28469d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/selection.js\":\"3d63e32a174e5ea3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/softKeyboardGrab.js\":\"5599aa714d6a4780\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/startupTimeline.js\":\"e3b46040696bb4a0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/state.js\":\"1cbad0d8dfff4e02\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/string.js\":\"cf41362e02cdaeaf\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/surfaceZoom.js\":\"0154187a730e28a3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/time.js\":\"57c8af7620bf1df7\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/toast.js\":\"0bf8b2f7bf90e9a2\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/toggleStore.js\":\"25af2573cc8b44a0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/untilStopped.js\":\"292e988c234956ba\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/userActivity.js\":\"46c10000de50cdfb\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/viewTransition.js\":\"0822095665af538b\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/viewport.js\":\"3749366fe410c4c9\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/webLock.js\":\"a5437683ff2e9377\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/workspaceRecovery.js\":\"adeb7b17fd67c519\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/workspaceSnapshotStore.js\":\"2e2c4501827fd325\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-compiler-runtime.js\":\"a00dfeab4784524e\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-client.js\":\"11904d0cd233db75\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-server-edge.js\":\"efedeb669fdd6a4e\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-server.js\":\"0390d67c62686de9\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-static-edge.js\":\"ad0a3222a653f3fc\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-static.js\":\"a5ca03a2c4ab0bea\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-test-utils.js\":\"d78a0424dbee0a1b\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom.js\":\"50a68264dc8324a5\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-jsx-runtime.js\":\"c89f2880074921c0\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react.js\":\"1958c28a20a72177\",\"/knowledge-medium/pr-preview/pr-1872/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1872/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1872/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
