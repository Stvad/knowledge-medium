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
		buildId: "28d2b74a7809-f96ec35f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/\":\"9c2ea2395b395621\",\"/knowledge-medium/pr-preview/pr-1872/index.html\":\"9c2ea2395b395621\",\"/knowledge-medium/pr-preview/pr-1872/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1872/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1872/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1872/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1872/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/pr-preview/pr-1872/assets/FacadeVFS-puZlWYde.js\":\"52bdcac4b35d909e\",\"/knowledge-medium/pr-preview/pr-1872/assets/OPFSCoopSyncVFS-v96zNdWA.js\":\"20276ebd0845c3e1\",\"/knowledge-medium/pr-preview/pr-1872/assets/OPFSWriteAheadVFS-28ODNTXz.js\":\"6e45fb4159c5bb8c\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-async-C28BZIcj.js\":\"2d37f059852d4308\",\"/knowledge-medium/pr-preview/pr-1872/assets/wa-sqlite-d0Pi7Ywt.js\":\"5e020a2459f62922\",\"/knowledge-medium/pr-preview/pr-1872/assets/worker-B9qx4kxR.js\":\"b1a747ddd757dcc9\",\"/knowledge-medium/pr-preview/pr-1872/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1872/chunks/app-BgczjmWp.js\":\"2a98bc40fa720b9e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1872/index.js\":\"a622bcb5309fc800\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1872/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1872/assets/AccessHandlePoolVFS-DqmgBvMr.js\":\"f71c8436c72596b7\",\"/knowledge-medium/pr-preview/pr-1872/assets/IDBBatchAtomicVFS-ByGLCDxD.js\":\"bd9a5908675a26d5\",\"/knowledge-medium/pr-preview/pr-1872/assets/MemoryVFS-Bm22rp-w.js\":\"9c6ea9cd3fc5d7db\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-D3derA7m.js\":\"850f4525551d5040\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-async-DM_fHM1v.js\":\"c297666e4dcb2e86\",\"/knowledge-medium/pr-preview/pr-1872/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1872/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1872/chunks/AccessHandlePoolVFS-iAh-s19u.js\":\"f690447a9442ff5d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/FacadeVFS-kF-K9vBh.js\":\"0252ce48d29da99e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/IDBBatchAtomicVFS-B4pvo9KF.js\":\"ca4c08f2f2520df1\",\"/knowledge-medium/pr-preview/pr-1872/chunks/MemoryVFS-xSvkM4p6.js\":\"91101a1515e65ac8\",\"/knowledge-medium/pr-preview/pr-1872/chunks/OPFSCoopSyncVFS-D5h7DJFg.js\":\"a2ca52f91e8b9d24\",\"/knowledge-medium/pr-preview/pr-1872/chunks/OPFSWriteAheadVFS-bjCmP_nM.js\":\"31919f820224f829\",\"/knowledge-medium/pr-preview/pr-1872/chunks/Preview-BOya4jny.js\":\"8c3a0c5a197285ae\",\"/knowledge-medium/pr-preview/pr-1872/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1872/chunks/card-CgC4OvzM.js\":\"0072aae2e0869633\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1872/chunks/dist-Ct52X2ih.js\":\"31db556b2a0a4178\",\"/knowledge-medium/pr-preview/pr-1872/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1872/chunks/mc-wa-sqlite-DJjmPd8c.js\":\"607290a36b24bb0d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/mc-wa-sqlite-async-CEpgnNIl.js\":\"0d574e4f52d184dd\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-BEAlG709.js\":\"fa41a80e18837d4e\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-Beex4gKY.js\":\"255b99d33a38c03b\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-CByvY95v.js\":\"b29f9b6fdd61f6a8\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-Cgn9uvFm.js\":\"1169398da5b024c8\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-DThwMwZg.js\":\"7c68794e150600ba\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-Dfju3kWR.js\":\"267b5aca1003443d\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server-legacy.browser.production-DROKgf6t.js\":\"506067f8e7504c78\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server.browser.production-_2NUe4fa.js\":\"abc83aaa5443cc70\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-dom-server.edge.production-BSp9XMXy.js\":\"b0705935e1af6696\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-g8DGIztM.js\":\"4a6fb52821862a6b\",\"/knowledge-medium/pr-preview/pr-1872/chunks/react-rTwBfCbp.js\":\"d00384c4466ce9fb\",\"/knowledge-medium/pr-preview/pr-1872/chunks/server.browser-8WmlR9cG.js\":\"a8324c4b4fa5f7da\",\"/knowledge-medium/pr-preview/pr-1872/chunks/textarea-Crp7_uz4.js\":\"1835fc39171f94c2\",\"/knowledge-medium/pr-preview/pr-1872/chunks/ui-DLBNbOun.js\":\"cc4c1b5f45baf388\",\"/knowledge-medium/pr-preview/pr-1872/chunks/wa-sqlite-DWd738-m.js\":\"b70d570dcbbfa879\",\"/knowledge-medium/pr-preview/pr-1872/chunks/wa-sqlite-async-D3kXuqUS.js\":\"bbc670f1f3cc5131\",\"/knowledge-medium/pr-preview/pr-1872/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1872/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/pr-preview/pr-1872/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1872/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1872/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1872/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1872/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1872/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1872/src/App.js\":\"6d743c49d67fe906\",\"/knowledge-medium/pr-preview/pr-1872/src/appUpdate.js\":\"ce5caadcdfb97e59\",\"/knowledge-medium/pr-preview/pr-1872/src/appVersion.js\":\"5c399ce6ab58c21e\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/initialLayout.js\":\"654ac9787b60c8ac\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/openWorkspaceData.js\":\"c37316b742283f76\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/resolveWorkspace.js\":\"c814c04ce5dd4f19\",\"/knowledge-medium/pr-preview/pr-1872/src/bootstrap/workspaceBootstrap.js\":\"e9636bb4775970de\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockComponent.js\":\"076b8e009c3e0277\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockCrumbs.js\":\"8235fe92c6c8965b\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockEditor.js\":\"3a71af0055cd92a4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockLoadingPlaceholder.js\":\"8940a31b57b73b46\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockProperties.js\":\"17c849a8f26a5a95\",\"/knowledge-medium/pr-preview/pr-1872/src/components/BlockSearchPicker.js\":\"d68992972b696cdf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ConfirmBulkDeleteDialog.js\":\"afbd7f36b16bce44\",\"/knowledge-medium/pr-preview/pr-1872/src/components/DividerHandle.js\":\"3b0550143407a174\",\"/knowledge-medium/pr-preview/pr-1872/src/components/DraftEditor.js\":\"be78fe7bf79b1f47\",\"/knowledge-medium/pr-preview/pr-1872/src/components/GutterPill.js\":\"d3d859b8701c73f9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/Header.js\":\"e78ec3922c69acad\",\"/knowledge-medium/pr-preview/pr-1872/src/components/LazyBlockComponent.js\":\"a39534a3264c0303\",\"/knowledge-medium/pr-preview/pr-1872/src/components/Login.js\":\"fd6b02a5d7aa5278\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ZoomableSurface.js\":\"93d165467e84a6cc\",\"/knowledge-medium/pr-preview/pr-1872/src/components/editModeKeepalive.js\":\"a05baceedecac9bf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6b4e6754bb835ec5\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a722c6b68763381a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/RefPropertyEditor.js\":\"c28945c2ac3ef871\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/RefTargetTypePicker.js\":\"2022b759b6435099\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/SelectPropertyEditor.js\":\"146354385078a0a1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/TypesPropertyEditor.js\":\"846a585ca08e4919\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/defaults.js\":\"67138796fce9fa82\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/kernelValuePresets.js\":\"f29e964eed073e67\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/selectablePresets.js\":\"78c3827cb4bd3c36\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyEditors/typesPropertyUi.js\":\"236d43803d8b83b0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/AddPropertyForm.js\":\"ec8b7d41231b2bc6\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/PropertyPicker.js\":\"7596147d07fd53d0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/PropertyRow.js\":\"395be525f9891b6c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/Rows.js\":\"6ce48814f8f07438\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/actions.js\":\"f6782e99cc5d6401\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/declarationOnly.js\":\"a6eced41c95e6b64\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/layout.js\":\"d1419cf412bcb3a5\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/model.js\":\"0d5c1d5faa6085e0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/shapeUi.js\":\"b4ae244411026da0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/shapes.js\":\"ad65196a452071f5\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a91a4caabb8d8fa1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanel/visibility.js\":\"4e19d6c0a267f123\",\"/knowledge-medium/pr-preview/pr-1872/src/components/propertyPanelSections.js\":\"c1ee4066c52bc4b8\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockEmbed.js\":\"152d18108aec7b7c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockLink.js\":\"d8b6edf14761983e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/BlockRef.js\":\"57f740065ad72e14\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/ReferenceLink.js\":\"3547165ffa4fe14a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/cycleGuard.js\":\"0e97030217cabbd9\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/cycleGuardContext.js\":\"8506f6d34fa98f0d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/linkInteraction.js\":\"55e8d99133f8f165\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/referenceLayout.js\":\"79b60863630cf50d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/references/useBlockRefAncestors.js\":\"1b86e3b4f25ae6fe\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockGutter.js\":\"7c901096a1db3b2c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockInfoDialog.js\":\"69840d0869c84973\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BlockTypeBlockRenderer.js\":\"8e09a32e28c418c5\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/BulletHoverCard.js\":\"c6979cdefd6e9e8c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/CodeMirrorContentRenderer.js\":\"e23abd1bd160fbca\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"61b28672d4c563b4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/ColumnResizeHandles.js\":\"500eaabf31166378\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ce2481ad9eba4719\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/DefaultBlockRenderer.js\":\"4004220eb09d1427\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/LayoutRenderer.js\":\"9ae2cd51afe457a8\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/MarkdownContentRenderer.js\":\"dc82db17fa7ae3c3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/MissingDataRenderer.js\":\"94271c781519a726\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/PanelRenderer.js\":\"c1912e95668e873f\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/PropertySchemaBlockRenderer.js\":\"214985633cf8ba5d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/TopLevelRenderer.js\":\"0b169055ff35901a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/blockGutterMode.js\":\"e974ddf4d9d6113b\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/blockTitleText.js\":\"f0c3a8fc21b503fe\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/fieldCreationKeydown.js\":\"48ca635fc65ef76a\",\"/knowledge-medium/pr-preview/pr-1872/src/components/renderer/layoutRootContext.js\":\"c5434012f6e11c6c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/typeChip/TypeChip.js\":\"5fb71aef302ee596\",\"/knowledge-medium/pr-preview/pr-1872/src/components/typeChip/chipStyle.js\":\"1ac5b952cb3c3f56\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/anchored-floating.js\":\"b3995d668086a147\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/button.js\":\"4eed738a383b34fa\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/card.js\":\"ea1e90d525973fa3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/checkbox.js\":\"e9c4344eca3d8aea\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/collapsible.js\":\"3d19a5592cf8ee2d\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/command.js\":\"4969e5c8b22ca5db\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/context-menu.js\":\"6307810f0784b144\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/dialog.js\":\"041176412c731eeb\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/dropdown-menu.js\":\"d7e6a399f56101bf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/floating-listbox.js\":\"0e913a00cbfef615\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/index.js\":\"10242ada882e1c2c\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/input.js\":\"89aeb4cd83b7472b\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/kbd.js\":\"63edfe4c570611f4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/label.js\":\"a51b5ecef901c218\",\"/knowledge-medium/pr-preview/pr-1872/src/components/ui/textarea.js\":\"8325c1d2d4dc62e6\",\"/knowledge-medium/pr-preview/pr-1872/src/components/useEditModeYieldKeepalive.js\":\"b054c2c9e60d9e23\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/BootFallback.js\":\"f0fc80f0498f5da4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/FocusedRowLazyMount.js\":\"0a2955e01531e911\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/LazyViewportMount.js\":\"2574a866d92cf811\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/LocalDbCorruptionFallback.js\":\"053b17b12a1a7772\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/error.js\":\"e8791091f1975e93\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/lazyMountRegistry.js\":\"31c68ccd1a7de2af\",\"/knowledge-medium/pr-preview/pr-1872/src/components/util/suspense.js\":\"595f4db1532cac21\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/CreateWorkspaceDialog.js\":\"b5b5b78508574940\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/PendingInvitations.js\":\"2be9def48ef6e252\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/SyncProgress.js\":\"63e11542a0aaabd0\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/UnlockProgress.js\":\"cdbeeafd742b0204\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceKeyGate.js\":\"55a4fdcca9bbf5f4\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSettingsDialog.js\":\"0d570e1dcfa6bf19\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSwitcher.js\":\"c414975ab73b1599\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/WorkspaceSyncGate.js\":\"124a551b9583473e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/ConversionFlow.js\":\"84b6bf7ca6647660\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/ConversionFlowHost.js\":\"c9cb9c2cf46ef1cf\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/EncryptionSection.js\":\"8a86136a53b85856\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/attachmentPrompts.js\":\"d52f7769783f39b1\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/bundleFolderPrompts.js\":\"bbb02140f3ba7c7e\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/conversionFlowDeps.js\":\"5962bdb59ac900af\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/conversionFlowStore.js\":\"d8add6a5ef1ab529\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/flowUi.js\":\"afbf31959f34393b\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/conversion/useConversionRun.js\":\"41d5977cae260623\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/keyUi.js\":\"01bdc39320cb1a89\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/useCloseOnKeyLoss.js\":\"efd9e2781d44dfe3\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/useCloseOnServerE2ee.js\":\"601d464135ba7682\",\"/knowledge-medium/pr-preview/pr-1872/src/components/workspace/workspaceUnlocked.js\":\"67ff89223f402263\",\"/knowledge-medium/pr-preview/pr-1872/src/context/backgroundSubtree.js\":\"05cf401c0dc15770\",\"/knowledge-medium/pr-preview/pr-1872/src/context/block.js\":\"665a1620e8537dc1\",\"/knowledge-medium/pr-preview/pr-1872/src/context/layoutWsContext.js\":\"03b1844ee09b6ad1\",\"/knowledge-medium/pr-preview/pr-1872/src/context/propertyDisplay.js\":\"f95b9c77cfb99670\",\"/knowledge-medium/pr-preview/pr-1872/src/context/repo.js\":\"7abb85960d9e9fc2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/aliasClaim.js\":\"23d21545da88d2e9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/aliasSeatNamespace.js\":\"48a3bb0d781ce7d7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/blockData.js\":\"209c111bfa9c8454\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/blockType.js\":\"a661ee7535760905\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/changeScope.js\":\"7c213602cd457d0a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/codecs.js\":\"255de9dde6fc40ca\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/derivedData.js\":\"104e84d045595e86\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/errors.js\":\"026631190ae22100\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/events.js\":\"20c45a6aca89ee19\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/handle.js\":\"03e7913ec70f10b5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/index.js\":\"74f3981a65d1f6a4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/mutator.js\":\"1a8bed04bf7d4bd4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/processor.js\":\"a1366d50a0fb116d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/propertySchema.js\":\"a1ca2679c5fd4005\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/query.js\":\"c96641e0622bcebf\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/sameTxProcessor.js\":\"021633dd3d29acaa\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/schema.js\":\"03e7913ec70f10b5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/tx.js\":\"03e7913ec70f10b5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/typedBlockQuery.js\":\"793169f59d7115c2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/user.js\":\"20b5f902dc70342f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/valuePresetCore.js\":\"a8d52a3158d4e1ac\",\"/knowledge-medium/pr-preview/pr-1872/src/data/api/valuePresets.js\":\"6803323e8c8a51ef\",\"/knowledge-medium/pr-preview/pr-1872/src/data/attachmentCleanerIOVerb.js\":\"b96a6af7799a969f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/block.js\":\"702acf30296793c7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockCache.js\":\"26966c1525fea9b6\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockId.js\":\"749cb1851a2aa6b4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockLiveness.js\":\"4d70639cd647f7c9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockMerge.js\":\"6532a61d68316771\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockSchema.js\":\"bde94fbe9094b552\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockTypeLookup.js\":\"b322a95412800981\",\"/knowledge-medium/pr-preview/pr-1872/src/data/blockTypes.js\":\"21001f9a0002f9ce\",\"/knowledge-medium/pr-preview/pr-1872/src/data/childrenView.js\":\"5aef445756efd980\",\"/knowledge-medium/pr-preview/pr-1872/src/data/clientContext.js\":\"9796824bfc181141\",\"/knowledge-medium/pr-preview/pr-1872/src/data/dbFileSiblings.js\":\"a4ee22ceb5d93f8d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/definitionSeeds.js\":\"94d433fe48cce0a2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/derivedIds.js\":\"39f50824a6679ef3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/drawnSubtree.js\":\"1843a1fe5b9b7152\",\"/knowledge-medium/pr-preview/pr-1872/src/data/facetBridge.js\":\"cb73adcee94f50d2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/facets.js\":\"87b4e093d0cfc6d2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/globalState.js\":\"5ea5a41c6a625781\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/aliasClaimRederiveProcessor.js\":\"e042ec5a3a4100f5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/ancestorBatch.js\":\"e0e7f885cf5a540d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/blockTypeTypeifyProcessor.js\":\"9e0ad598dba5cb8f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/clientSchema.js\":\"f85ec18912abae3f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/commitPipeline.js\":\"0113f4181b70c47e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/devAssertions.js\":\"9b8b90d401ab7682\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/firstSync.js\":\"14f8cb9f7f850d7f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/freshInitialLoad.js\":\"1856fc8c5d95c6ec\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/graphBackfillClaim.js\":\"b47c42c985cea046\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/handleStore.js\":\"e471839d9ef8b2dc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/idleMarkerJobs.js\":\"36ca3b56918c4bff\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/initialDownload.js\":\"b7c22f7f6744e3b3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/initializeClientDatabase.js\":\"87612110a0a8b84a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/jsonCanonical.js\":\"91776ad8e13e4993\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelInvalidation.js\":\"f644929ab67dcae1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelProcessors.js\":\"b439e2eeef8f9104\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/kernelQueries.js\":\"cc5bec4b5d899890\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/mergeTypeMembershipProcessor.js\":\"4db835a6ce44a239\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/normalizeReferencesProcessor.js\":\"3e5277dbc29f0979\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/poolInstrumentation.js\":\"0f65bdda5a24ea95\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/processorRunner.js\":\"d1248fa42e52e980\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyCellBackfill.js\":\"9c5b9d9615c915d4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyChildMint.js\":\"4c648ebc12cf0c91\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyChildrenProcessor.js\":\"b8270ac9bbffdc76\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyDefinitionChangeProcessor.js\":\"50e34f9d2c412922\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyDefinitionSynthesis.js\":\"c48b280150edabb7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyKeyScan.js\":\"e2a7301e4d3bf2be\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertySchemaResolution.js\":\"4515cb1f85673374\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/propertyValueEdits.js\":\"6659c8f432c51ef4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/raiseProtocol.js\":\"c254fdfc176fe807\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/readBatch.js\":\"fedc75e1863e2d85\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/refProjection.js\":\"26e72714a07a40f6\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/referenceTargetLookups.js\":\"353092ab14695bd7\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/referenceTargetProcessor.js\":\"e45856aa4cb4958b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/replayMerge.js\":\"dbefeb710a94cfb5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/sqlBinds.js\":\"e061b3ac437c4362\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"761e28eb5638ad06\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/arrivalProcessors.js\":\"a10479a871cd440b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/invalidate.js\":\"23028f370659d960\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/materialize.js\":\"13dde3939deb26cd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/observer.js\":\"9128cba4f34abf24\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/syncObserver/reconcile.js\":\"50d429855e11d01f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/timingMetrics.js\":\"95b54161667662fc\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/treeQueries.js\":\"b17ba3d7322df67d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/txEngine.js\":\"b6f14d287f52acec\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/txSnapshots.js\":\"c782fd0211f6e526\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/typedBlockQuery.js\":\"74d4ea946c0f0871\",\"/knowledge-medium/pr-preview/pr-1872/src/data/internals/undoManager.js\":\"71050132fac5f1e9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/invalidation.js\":\"f5ecb143bd9c110d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelDataExtension.js\":\"7d0b2d6c13c4e570\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelPage.js\":\"4149ce0073b9de09\",\"/knowledge-medium/pr-preview/pr-1872/src/data/kernelValuePresetCores.js\":\"1c116007914dd865\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbCorruptionSignal.js\":\"e2a2e2d7a87f96e4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbStorage.js\":\"c65d3721837e93d8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localDbVfs.js\":\"2cf35fb2185f410c\",\"/knowledge-medium/pr-preview/pr-1872/src/data/localSchema.js\":\"6151e4eb177d5073\",\"/knowledge-medium/pr-preview/pr-1872/src/data/maintenance.js\":\"86ad95233a4e8443\",\"/knowledge-medium/pr-preview/pr-1872/src/data/mergeProperties.js\":\"6da4d16cecb306cd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/metricsConsoleHook.js\":\"bb17b10da7460798\",\"/knowledge-medium/pr-preview/pr-1872/src/data/migrationsPage.js\":\"db88c6f360c98fe4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/mutators.js\":\"cd43d0388b44c942\",\"/knowledge-medium/pr-preview/pr-1872/src/data/orderKey.js\":\"683012464fe09f55\",\"/knowledge-medium/pr-preview/pr-1872/src/data/orderKeyPlacement.js\":\"41a60ead80a2c87a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/outlineSurface.js\":\"f1d34aab10ad797f\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pendingEditorContent.js\":\"5d349c7e7dafc180\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pendingUploadsSql.js\":\"aa756e38e9bc1bd2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/pluginStateExtensions.js\":\"4e4348bc2b74aaf5\",\"/knowledge-medium/pr-preview/pr-1872/src/data/powerSyncLogger.js\":\"b58605e996cb51f1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/projectorRuntime.js\":\"7f7927b06d789eb1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/properties.js\":\"442c2fb7ed4ab8f4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertiesPage.js\":\"ddea578566dfc265\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyChildren.js\":\"0f3633ea4e0176cb\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionFanout.js\":\"21a7d03d666db421\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionMetadata.js\":\"a2ea11ba69d7c627\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDefinitionRegistry.js\":\"d83b703736fdad1e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyDisplayMode.js\":\"09c3fb4ab98e0954\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertyRowCreation.js\":\"a8ebb5d563393f40\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertySchemaCreation.js\":\"66c23c61036e5407\",\"/knowledge-medium/pr-preview/pr-1872/src/data/propertySeeds.js\":\"e6e9a88bd3a0fd80\",\"/knowledge-medium/pr-preview/pr-1872/src/data/recentsPage.js\":\"d86c87d583dcaa4b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/referenceBlock.js\":\"f2cca16c91049e17\",\"/knowledge-medium/pr-preview/pr-1872/src/data/rejectedUploads.js\":\"c31d6478f82116b8\",\"/knowledge-medium/pr-preview/pr-1872/src/data/releasePowerSyncConnection.js\":\"211164e15d3f9748\",\"/knowledge-medium/pr-preview/pr-1872/src/data/repo.js\":\"fe3598860777def3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/repoProvider.js\":\"fda37f3d605bb271\",\"/knowledge-medium/pr-preview/pr-1872/src/data/rowProperty.js\":\"a0f40a7381e84d7e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/searchFilter.js\":\"2ed066e0e520b8bd\",\"/knowledge-medium/pr-preview/pr-1872/src/data/seedIdentityLedger.js\":\"e277baa297e2d933\",\"/knowledge-medium/pr-preview/pr-1872/src/data/stateBlocks.js\":\"44e4f638156c2c0a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/structuralEditPolicy.js\":\"8732ed403ce36dfe\",\"/knowledge-medium/pr-preview/pr-1872/src/data/subtreeDelete.js\":\"773f99ac35cac2c3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncStreamLock.js\":\"6080c4bfd533586e\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncedTableSqlRecognizer.js\":\"c0fab34fbb60d688\",\"/knowledge-medium/pr-preview/pr-1872/src/data/syncedTableWriteGuard.js\":\"614aa07681a147ab\",\"/knowledge-medium/pr-preview/pr-1872/src/data/targets.js\":\"1ee875d991c992e0\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeColors.js\":\"771903377f78eea9\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeDefinitionMetadata.js\":\"cfb20689c9469e12\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeDefinitionRegistry.js\":\"873f01b29091d544\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeExtraction.js\":\"bbfa01eee445bae1\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeInitialValues.js\":\"f7b10e6eb74a96be\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typePropertyGroups.js\":\"d85cce823b3c9a53\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeSeeds.js\":\"6cf917d6ad7c541d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typeTagger.js\":\"6c9c5ff79ab2eb83\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typedRecords.js\":\"3572f40dc018c06b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/typesPage.js\":\"97a3d2f52291ece3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userPrefs.js\":\"75866dad5c20637a\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userSchemasService.js\":\"cc7c1bd74cf391f6\",\"/knowledge-medium/pr-preview/pr-1872/src/data/userTypesService.js\":\"fb6c5653b6dc46a2\",\"/knowledge-medium/pr-preview/pr-1872/src/data/valuePresetRegistry.js\":\"21fb00737daab1d3\",\"/knowledge-medium/pr-preview/pr-1872/src/data/visibleChildren.js\":\"79b62475d28d1321\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceConversion.js\":\"5aba4b8b60f68ef4\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceFirstSync.js\":\"0dc6a3acbb8e4c35\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceIdNamespace.js\":\"b75e20575df5c11d\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaceSchema.js\":\"92b690edc4c6e34b\",\"/knowledge-medium/pr-preview/pr-1872/src/data/workspaces.js\":\"3a04678db2371baa\",\"/knowledge-medium/pr-preview/pr-1872/src/data/writeAheadLog.js\":\"023d839abdf18b92\",\"/knowledge-medium/pr-preview/pr-1872/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/BlockPasteShellDecorator.js\":\"bbdda27001297030\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/atTrigger.js\":\"6ad054dc1e9117f8\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/autocomplete.js\":\"7ee68b883bc6ffec\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/codeMirrorExtensions.js\":\"3cd8f898a6a78fd2\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/contentFlush.js\":\"7f9f98b4944a5f13\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/defaultInteractions.js\":\"4fb773fa432aff2f\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/editSettleSignal.js\":\"63e44da0813fde6e\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/insertImage.js\":\"f00535a79fa2a81b\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/referenceCompletionRange.js\":\"15487621fcee456e\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/referenceTargetTypes.js\":\"4e3b1907c07a6fae\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/syntaxContext.js\":\"be826e18c746bda8\",\"/knowledge-medium/pr-preview/pr-1872/src/editor/triggerMatch.js\":\"1f1a9134ccebfef7\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/AppRuntimeProvider.js\":\"887ee4bc2688e433\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/BlockFocusShellDecorator.js\":\"e5ec480068026412\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/ExtensionRenderBoundary.js\":\"a2d2cec66c54da27\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/PanelContentRecovery.js\":\"d60782c964b6733b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/apiCatalog.js\":\"5fc5107d255f6499\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/approveExtensionHere.js\":\"b215cdcebbd3552c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/armedCutAppMount.js\":\"c1efae4c76660867\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/batchableKeyedStore.js\":\"fbf63b86f2089587\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/blockInteraction.js\":\"7f58eea3d0734711\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/blockSelectionAction.js\":\"5f2cd794dc575363\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/compileExtensionModule.js\":\"135f9cdbfa16bda1\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/compiledModuleCache.js\":\"180fb07db28b83bb\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/continuousGestures.js\":\"8f3787a671f9295a\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/core.js\":\"db63d7f2003034e6\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/defaultRenderers.js\":\"9614368d8dd1eb26\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/definitionFanoutAppMount.js\":\"bc692b55a44e7ea9\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dialogAppMount.js\":\"c037e932ac3648d1\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dynamicExtensionSeeds.js\":\"59c7020e0c42443c\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/dynamicExtensions.js\":\"821cd090caf996ec\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/exampleExtensions.js\":\"b7546c66cc9cc75b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionApprovalStatus.js\":\"256c2d3a2491ee7f\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLoadErrorToast.js\":\"fe582690f6daa05b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLoadErrors.js\":\"9bb82516850d1af6\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionLookup.js\":\"1be320994b0f6731\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionToggles.js\":\"74f50ef7d46ce77b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/extensionUtilitiesCss.js\":\"77de013c30abb2bf\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/kernelPageDeletionGuard.js\":\"cc77cd8ac8fe1ef1\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/liveRuntime.js\":\"4fc3cdd4277bf15f\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/openExtensionsSettings.js\":\"bcc1f781418d531b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/overridesCache.js\":\"84f1554ea5baa51d\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/pluginIds.js\":\"8c5bfd755ad80713\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/processorRejectionToast.js\":\"fc0f69c581d7f222\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/runtimeActions.js\":\"84d86618f140c861\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/runtimeContext.js\":\"40cc0a8eb7a5cc0b\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/staticAppExtensions.js\":\"45488df2177f7cc6\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/staticDataExtensions.js\":\"dff8557d9bf1b937\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/toastAppMount.js\":\"a7f4d39a711f1a07\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/useOverrides.js\":\"88e194fe4e0954c6\",\"/knowledge-medium/pr-preview/pr-1872/src/extensions/useShortcutSurfaceActivations.js\":\"7a8892c61fea8d1a\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/discoverToggleTree.js\":\"3f90f2daec056e23\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/facet.js\":\"ca7b2dbf74130f45\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/resolveAppRuntime.js\":\"8f147d0b397b8f4e\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/runtimeEvents.js\":\"97f99b9a81409e70\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/togglable.js\":\"361625b4b404001a\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/variantFacet.js\":\"6c7fe89dbce67ebc\",\"/knowledge-medium/pr-preview/pr-1872/src/facets/verbFacet.js\":\"29fdb244b9c7159d\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/block.js\":\"e3609bb632ef6ef4\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/focusedChild.js\":\"448da24b7848c1b6\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/propertySchemas.js\":\"1ae3c7e065ff49cf\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/typeRegistry.js\":\"a05bdb75d463a58d\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useAncestorCrumbs.js\":\"9ed9fdeffd512cbd\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useAutocompleteListbox.js\":\"dbd5b525c0bf3c1a\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useDebouncedSearch.js\":\"8a434a88aa197bd5\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useDebouncedValue.js\":\"cd56f9ac95408f35\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useIsFocalRender.js\":\"419c7ac421408b44\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useIsReadOnly.js\":\"331b5757b95ca9cd\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useMaterializeBacklog.js\":\"3189e2f6f80c8f37\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useMinuteClock.js\":\"6f1d6d58d186801b\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/usePanelLayoutProjection.js\":\"65e270036c5a2874\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/usePendingInvitations.js\":\"320009a3f73bc698\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useRendererRegistry.js\":\"ecdad6c75afb46bc\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useRetainedFieldRows.js\":\"326652a3b71d87f7\",\"/knowledge-medium/pr-preview/pr-1872/src/hooks/useWorkspaces.js\":\"3975013378ba8361\",\"/knowledge-medium/pr-preview/pr-1872/src/lib/utils.js\":\"26d5cf0ebfcc28fd\",\"/knowledge-medium/pr-preview/pr-1872/src/main.js\":\"62ca4444e6fab016\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/MarkdownImage.js\":\"11346b24666d8ead\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/blockSeparators.js\":\"c5709a969a7ff061\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/context.js\":\"1877767b275899df\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/defaultMarkdownExtension.js\":\"b6a39beb2f7d6aff\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/extensions.js\":\"19bb960f1411c836\",\"/knowledge-medium/pr-preview/pr-1872/src/markdown/renderMarkdownHtml.js\":\"654529811f14e661\",\"/knowledge-medium/pr-preview/pr-1872/src/minimal-editor.js\":\"ea6d212383ec65f2\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/armedCut.js\":\"5d6ad946c28179d2\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/captureMediaVerb.js\":\"a7508b62c30e4a35\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/clipboard.js\":\"31806425b0e2303f\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/decision.js\":\"f41c546529f45634\",\"/knowledge-medium/pr-preview/pr-1872/src/paste/operations.js\":\"d8742e30cb086c22\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/account-header/AccountHeaderItem.js\":\"e8955fd4ece36a4f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/account-header/index.js\":\"981d9db06213ec14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0b2c6cefd08ea5b1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/askAgent.js\":\"3b2bd0c8e35ce911\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/askedStore.js\":\"6be306c928847eb0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"070b28c31477435a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/chipState.js\":\"0044393e52b284ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/dataExtension.js\":\"12bb280f8140078b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/index.js\":\"8d9b03a59d4b3a33\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7bc9ef46f12516ee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-dispatch-companion/schema.js\":\"e787a0eb173bd71d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a1eb94c082af620a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d150d43743c67ece\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/addMedia.js\":\"7a560254fdadf385\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8d713d32473e1bdf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/block.js\":\"5348b420ad8572eb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/context.js\":\"bfc56ae5efde5731\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1a352ced191d6d70\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/index.js\":\"bbb1a86fe20835f8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/outline.js\":\"d725d1f10f5278be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/properties.js\":\"d36c775cd1173ed5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/refs.js\":\"a03e72366f6910a1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"97ef4e4fc67ee2dd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/search.js\":\"3792a62f09ecc2d9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/shared.js\":\"59372d4e48a66baf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"915b8fe5bfca87d6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentViews/text.js\":\"aef3dc55e17b41f1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/agentWrites.js\":\"eb4a050d131b7157\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/authoringCatalog.js\":\"6b5ff7b6dc418946\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/blockRefTargets.js\":\"b14009c73b4fcfa7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/bridge.js\":\"ae441eac5dfa8dee\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/bridgeLoop.js\":\"5c43b7f1ed693be1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/changeHistory.js\":\"418ebb49501535fa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/commands.js\":\"3ded952f8b80733e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/commentsCommands.js\":\"37b25ba88df3921f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/dataExtension.js\":\"6a6cf8cb174134d7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/dataModelGuide.js\":\"c71182d5b89dede1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/describeRuntime.js\":\"3982061b9a3103b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/extensionLint.js\":\"b542374c7ef3b35c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/grainAudit.js\":\"ba51ae99136de84c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/healthCommand.js\":\"ed7876fd6a09c140\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/index.js\":\"fe1e7dbc0d8c7649\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/presetIdentity.js\":\"021c9ebf7a9fcadc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"63ddc45b03c80c33\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/readMedia.js\":\"8db9964b5a6bb4d8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/schema.js\":\"c4aa756d44ba382b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/serialization.js\":\"287de7d9be7fd58b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/targets.js\":\"9abaf7c2305499fc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/tokens.js\":\"70343cd2386a4aa9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/watchEvents.js\":\"a7862415b6a4c87e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/workspaceGuard.js\":\"8c9cabfccb46258c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/agent-runtime/writeCommands.js\":\"5fcde400c725b21d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/AliasCollisionToast.js\":\"5c863ac2511a348f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/DuplicateNameBanner.js\":\"6dfb03c948ab3553\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/collisionMerge.js\":\"cdfd1b6b0e3a18ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/dataExtension.js\":\"32e0a5abdfb83a42\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/index.js\":\"8743580f61691c3b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/mergeCollisionAction.js\":\"24deb262f88d76ae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/pageStyling.js\":\"4bc9861bb2362102\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/rejectionToast.js\":\"976c93d7a54d3900\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/alias/syncProcessor.js\":\"d89bac7e0379d906\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/actions.js\":\"a0f1824afba51310\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/addComment.js\":\"020ed6f4d812fd9a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/anchor.js\":\"77139f6ccdfee601\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/anchorState.js\":\"ee879e4e72f57858\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/commentLinks.js\":\"39589df5be8cea9f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/confirmThreadDeletion.js\":\"0a0248313ea330e4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/container.js\":\"4abcc75927539b15\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/dataExtension.js\":\"38f9d2f6c806a3ac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/deleteComment.js\":\"5e6600bbc2f0b0b1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/highlights.js\":\"022807b1ee69b5f9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/index.js\":\"087b927b0eae9c23\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/linkedCommentsPill.js\":\"869b26247705e5d4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/margin.js\":\"a8f3915de21516ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/marginSchema.js\":\"5c82c9b61e473760\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/newComment.js\":\"8a490d6502e49715\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/ownThreadPicker.js\":\"a732cab2cb178b18\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/placement.js\":\"dff4a361d5b646e7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/queries.js\":\"24e1a01a1a447db2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotePosition.js\":\"835c3356b39b6b43\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotedIn.js\":\"4f9d1e2bd8e0b5f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/quotedRange.js\":\"7447b54df392dd89\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/rangeRefs.js\":\"e6426c846c6a709b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readHighlights.js\":\"497ffc90c0417a7f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readSelection.js\":\"8dc664de9617e084\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/readSelectionUi.js\":\"9ce9320111c8999e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/reanchor.js\":\"875369cb7e22b8e2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/schema.js\":\"383ec608f8d70e46\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/scope.js\":\"56967c2a21736703\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/scopeThreads.js\":\"2c0d7fca74d98add\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/splitRetarget.js\":\"e11400b5e112979a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/suggestionCard.js\":\"b64b04e182235cb9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/suggestions.js\":\"854db5e61d05f273\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/summaries.js\":\"de9fa94431fcf7ab\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/summaryBatch.js\":\"414fdc197f1833ed\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/surface.js\":\"a3ca2fa2ba26acfc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/threadNavigation.js\":\"4dc5bd255c702a93\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/threads.js\":\"66849a02f4d35049\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/ui.js\":\"cb84e074cc383f25\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/annotations/uiStore.js\":\"6cd9f72524bb4442\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-intents/appIntents.js\":\"d761e8d43b49029e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-intents/index.js\":\"4fbb230b19d6e438\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-update-prompt/index.js\":\"2e2565b8fb8dd63d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/app-update-prompt/status.js\":\"7040768bcfa370aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6de4efc7a3ab7bf7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaBlockRenderer.js\":\"60fba578b02dc3b8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaDownLaneReplicator.js\":\"325868b53cd5bcdc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/MediaUploadReconciler.js\":\"411ab2f40fbb856b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetDownLane.js\":\"0314e402794d8e6c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetResolver.js\":\"a71619ea527e1a35\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/assetUpload.js\":\"fd2a11125da4d513\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/attachmentCleanerIO.js\":\"32a4fd4189a472d5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/supabaseAuditIO.js\":\"43262d5ec184516f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/blobStore.js\":\"a3b2a6f7e09f6c2f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/browserMedia.js\":\"0c6da62362b030ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/byteStore.js\":\"6729d6a0e440a257\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/cleanerIO.js\":\"955408ae1a8606e7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/cleanupAttachments.js\":\"2c0880d122e5e333\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/dataExtension.js\":\"f8e04094faf305f5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/downLane.js\":\"d449e7d98fe781c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/index.js\":\"f7bcf48ea88af6aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/insertImageContribution.js\":\"572c6bb659d06d77\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/laneArming.js\":\"268fbd6c43147bc4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/laneLock.js\":\"61292d6dcc23bc5d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaBlock.js\":\"f61cf6a471190527\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaCapture.js\":\"56b248199e9b86f1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaLanes.js\":\"49ea113728125d0c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaViewers.js\":\"17ffa297adb66a1d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/mediaViewersFacet.js\":\"6ec82db841b34d4a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/pasteCapture.js\":\"3e66b9d68d559c4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/resolver.js\":\"478079fcd0e2af86\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/retryUploadsAction.js\":\"c737d96ab30aeffc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/storagePaths.js\":\"155ff2c0c1b64ac9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadDrain.js\":\"476959f77f090226\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadLaneStatus.js\":\"2448083364fa4bc4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadReconcile.js\":\"2df4080fb7c33f86\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadRecovery.js\":\"987f00371cd442b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/uploadStore.js\":\"01999ad53f1a2dec\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/attachments/useAssetObjectUrl.js\":\"1b3dd57b49e1860f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"628a65c32b50df63\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/BacklinksViewSection.js\":\"dd102b01c64fd673\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/facet.js\":\"c917dd27011bffc9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/index.js\":\"b82045cab86fe4c8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks-view/prop.js\":\"189eed35f8765481\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BacklinkFilters.js\":\"26157608e60095bf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"40abe8a9c1989b5c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/BlockEntry.js\":\"9662814b66e50f1f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/LinkedReferences.js\":\"7dbc5ac442abf4f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0e8f670fb1556df7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/dailyNoteDefaults.js\":\"b38f21d300141d4a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/dataExtension.js\":\"374f7e7ef5e10fa0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/edgeExclusions.js\":\"84c9c803db6f63ae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/filterProperty.js\":\"efbbeb091c2e0a06\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/index.js\":\"5c5f51e7c0163a37\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"09ced88a5b5d87ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/applies.js\":\"8eb4bc7b774297bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/countQuery.js\":\"ea6e0ae50058c706\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e71a78ddd6df1c78\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/index.js\":\"a030ec6e7cf2281c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7ae5a0919e2aa34e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/presentationInvalidation.js\":\"28c564d13a38accf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/propertyEditorOverride.js\":\"e06d59ad029b4a40\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/propertyFilter.js\":\"2aa5749799bf0471\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/query.js\":\"583ec97e1bd68d74\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/resolveFilter.js\":\"d8383bca67ea148e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/sourceBatch.js\":\"277f28c5b84e1608\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/sources.js\":\"d9957e38de7b5f28\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/useBacklinks.js\":\"c21ba1656252811c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ca4654bb234c1f5d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/BirthdayCelebration.js\":\"01ea5b79a9e61878\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/BirthdayOverlay.js\":\"493ad01d67d3a934\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/gate.js\":\"0cf541efed3458a0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/index.js\":\"4657273457c6ba0b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/birthday/wolfTheme.js\":\"66ebc6ad330f577b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/BlockDragLayer.js\":\"6f8ef08eee86201b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/dragController.js\":\"2cca4b8615220af2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/dropTarget.js\":\"7cbd3a8a9ab70e73\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/index.js\":\"b01bccf73ad4e9ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-drag/projection.js\":\"b8be5d44665e7422\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-info/BlockMetaCard.js\":\"9fc96bf5cbb7e169\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-info/index.js\":\"03862c0855917f21\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/AddTagDialog.js\":\"a606cc5b1f0d57b3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"9dd50d2809554d82\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/TagNameIssueHint.js\":\"37d1cf9b98a55cc4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/addTagAction.js\":\"b78c5cc28944f7e4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/appendTag.js\":\"7f501b052a059604\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/config.js\":\"9ff5f175e48eadbe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/dataExtension.js\":\"f0fd9b60bfeb42a0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/index.js\":\"99f468aade84e2d0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/block-tagging/propertyEditorOverride.js\":\"d4456437b0ec05f5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0d9a6668f98e92ae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a11e320cb2b4a915\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/Breadcrumbs.js\":\"73b04c546c50af4e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"747b62f902f9fc7a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e5772bc48fec5c27\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/index.js\":\"da355496d9f204b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"419785801cd823a0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/CharacterCountItem.js\":\"d1c5d4b8c233471c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2ee9e49f20e20589\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/actions.js\":\"638102f51f2c60be\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/blockType.js\":\"f3f9bf3d86630483\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/charCount.js\":\"2fed4d257ccb07ed\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/dataExtension.js\":\"6ae40459b5a1369d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/index.js\":\"ec1f020449fa75bf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/profiles.js\":\"530b8c3089ea4454\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/properties.js\":\"7f94aa3490112337\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/character-counter/textCounts.js\":\"a2776429f1155ab7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/colemak-keybindings/index.js\":\"a4b3e10b11dc73d1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/CommandPalette.js\":\"d633e2b28cc39eb7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/HeaderItem.js\":\"d2e11b4f5b3bd269\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/context.js\":\"09248c3b78201ca1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/index.js\":\"3bef57285755b057\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/selection.js\":\"1a665d57faf38feb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/toggleStore.js\":\"72399b85062383f3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/command-palette/useCommandPaletteActions.js\":\"893e5c13919f561c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/ContributorBadges.js\":\"772d579af9d12b99\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/author.js\":\"09097dfbc244a311\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/codeMirrorExtensions.js\":\"379deb3ff393e560\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/dataExtension.js\":\"0ae27a95d997b6a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/index.js\":\"f3effc62403d51d3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/mentionAutocomplete.js\":\"4ac26a802f9832f2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/processor.js\":\"a224e8a17f8463aa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/profiles.js\":\"443a986499b1595d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/queries.js\":\"7506b92617d5fe90\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/contributors/schema.js\":\"4da7a27787be9432\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7fb6517574c3b018\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/followOrigin.js\":\"73d62bc673f7269c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/index.js\":\"5f57e140c70e765e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"472422303217a1ef\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0833091b4e143abd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/CalendarGrid.js\":\"ba620358ee24904d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DailyNotePicker.js\":\"2679b9efbe5ea539\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"95874482657b3c2f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateNavDecorator.js\":\"5707ab3a219c8a83\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/DateScrubOverlay.js\":\"c0ddf7d7c23ccef6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/HeaderItem.js\":\"4b38ff72d49e6d03\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/ReschedulePicker.js\":\"4cefc42936f3e550\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e0cd88d6da5ef87d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/actions.js\":\"286384752650dcaf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/blockDateAdapter.js\":\"f3f646f9bf80cbd6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/calendar.js\":\"448170f59b94e16d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dailyNotes.js\":\"4869fc60b6dc7d6e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dataExtension.js\":\"12a0118122de8ad4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubActions.js\":\"fb607cffec1a9b8a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubGesture.js\":\"e3b75f86abb6580e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubGestureActions.js\":\"56b6aaa873abc56b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c2ff88efc7d59c3a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/deletionGuard.js\":\"e0b79aa9f85116c2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/dueQuery.js\":\"e10faa38e8f8f9b2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/index.js\":\"6cb660dd545ad35f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/landing.js\":\"17cfd65c1afb28cd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/localSchema.js\":\"353efc757e98d03e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/referenceDateAdapter.js\":\"d690db8530381d1c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/rescheduleAction.js\":\"05984d7e2833736f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/schema.js\":\"0e4a677a53dabb2e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/spreadBlockDates.js\":\"712509eb19f0a20d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/spreadDatesAction.js\":\"4f6eb6117d26fb70\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/today.js\":\"a8c2ebaa46afcce2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f09768e8c5791caa\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"285f580e5e5431e0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/audit.js\":\"efa29ea5f29d31f3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/auditAction.js\":\"78a8507964a4012c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/auditRanges.js\":\"5d54296628e123f5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/diagnosticsSource.js\":\"3305136de2411291\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/divergenceScan.js\":\"a8e1d754e059928a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/index.js\":\"daf7c3676fd09eac\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/propertyChildrenChecks.js\":\"59c1b380d7e69ba0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/referencesMirror.js\":\"a9663c04f34da026\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/rowJson.js\":\"ab4e501213cb9425\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/schedule.js\":\"668c2bf0be5564fe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/data-integrity/store.js\":\"da393e7ed9a90ae3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/action.js\":\"30c78f9198070987\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/index.js\":\"96b80e6679635558\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-maintenance/plugin.js\":\"4b95e1f21e20a0a0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b93578d9aca72767\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/actions.js\":\"1ae3e0d2c6eeef67\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/changeMarker.js\":\"aec0575a9be73942\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/diagnostics.js\":\"c7b22420cce30421\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/fileSystemAccess.js\":\"5b8ca6464d568609\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/filenames.js\":\"1f3c6fd3ec0baebd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/index.js\":\"6b4e25c1cf556a9e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/mirror.js\":\"e321025d8e2d2eae\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/runLock.js\":\"fea3e4f0cff1774f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/runtimeHealth.js\":\"6cba10d060b6e878\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/schedule.js\":\"483d3653f6bb978a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/db-mirror/store.js\":\"f0bfbbf036a7ae8a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/default-themes/index.js\":\"8b362ccac391ca17\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/default-themes/themes.js\":\"5d944f388c31404a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/diagnostics/facet.js\":\"01d835f3b221ebf9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/diagnostics/useDiagnostics.js\":\"c337ef6e709fd134\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/dismissals.js\":\"fefb93766ac301fb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/index.js\":\"6f4a6cc2b46876e5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/status.js\":\"846ca653a530b602\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extension-prompts/store.js\":\"4566b0286fd02b73\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3d30d3468aebafc0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/ExtensionsSettings.js\":\"adfe9e19031a3b4d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/actions.js\":\"8ebf55936f3c83a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/config.js\":\"468228dbeeebf1eb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/dataExtension.js\":\"5c1356c044bc600f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/effect.js\":\"2b53996babad4244\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/index.js\":\"6920556755d6bd48\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d6468936ce14ccbe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extensions-settings/useToggleTree.js\":\"ba1f41befd597bed\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/ExtractTypeDialog.js\":\"3d71b45a042fef78\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d6420d9c929cedca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/PropertyShapePicker.js\":\"b2cbe24427675dc1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/action.js\":\"eb6e00d6c1f9f801\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/extract-type/index.js\":\"c469d639fcc3c404\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/FindReplaceDialog.js\":\"9bf97ddd2e88db5f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/HeaderItem.js\":\"c393d56500338fb3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/dataExtension.js\":\"147c5d46f37272f0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/index.js\":\"c1695f456ad0b96d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/search.js\":\"bb911e6d3e2a6e1f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/toggleStore.js\":\"607f6c29999cd5fe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/LocationPropertyEditor.js\":\"6a60dfe4452231b1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/MapView.js\":\"3b735f8178868db4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/blockTypes.js\":\"c1ad92dc02a4c86c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/codeMirrorExtensions.js\":\"73a21bd75c3d3d34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/createOrFindPlace.js\":\"d68b59dbcec2463f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/currentLocation.js\":\"22a6b45da286c399\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/dataExtension.js\":\"c0240a142747a11d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/geoContentDecorator.js\":\"52eadad132bf1016\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/googlePlacesClient.js\":\"8a09b72da1ca91d8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/index.js\":\"849634fe46f5ba29\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/locationsPage.js\":\"5b09d77f1d6b9291\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/mapViewport.js\":\"d693fea5f43e1880\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/pickCurrentLocation.js\":\"96f9188efc84ce15\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/placeAutocomplete.js\":\"1f0588cf06d6c871\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/placeNameCollision.js\":\"3667107b67753c3b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/properties.js\":\"df674676d6f26255\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/propertyEditorOverrides.js\":\"b015f8f11193691f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/query.js\":\"771a0095b9db671f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/geo/usePlaceSearch.js\":\"fac3a4ee910050bb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"db5f47d0ed4401ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"fcbde3236ca098e8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ba187832f1c68fd1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/config.js\":\"fd830792f9061f40\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/dataExtension.js\":\"df09dbc3238dad62\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/facet.js\":\"84a65df242658d92\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/grouping.js\":\"8362531a23b4bd9d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/index.js\":\"9359ce90687917b9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1fa8a0fad2d088f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/query.js\":\"46d0527cb81ad459\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/resolveConfig.js\":\"abe2fe93de1409ec\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5c5af54245779ab8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"076a3d530819284b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/HtmlDocumentContent.js\":\"33de6ba50f512a9b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/HtmlFrame.js\":\"e465dcf34ebd3541\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/actions.js\":\"633c85cc8e64fc34\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/blockType.js\":\"ed33daf744a2d13c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/confirmRunScripts.js\":\"b68f029b3b7d441d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/dataExtension.js\":\"f0ebf157562cd52a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameAnnotations.js\":\"f738a3fcfef2fc45\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameDocument.js\":\"2ac495ce2d87ff8e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/frameTheme.js\":\"ffbc2580196ae9ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/index.js\":\"0226ac2f637df8e7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/scriptConsent.js\":\"54ee3d796504953f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/sourceMap.js\":\"ab4274a2938014ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/html-document/useDocumentScripts.js\":\"cf3f03f3d48b0084\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/index.js\":\"75fe3b9ec0d79274\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/record.js\":\"693565ef7e6e3388\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/recordStore.js\":\"751ff5ee8bd2209d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/responsiveness.js\":\"f0128d6fb0b65366\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/schedule.js\":\"b9532ff9af4c58b8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/interaction-metrics/sessionContext.js\":\"8489918bef853b12\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"26fb02ef676db9eb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3488061c4566e2d3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/actions.js\":\"f25a2a8dd685e3fe\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/config.js\":\"615a7560386fda46\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/dataExtension.js\":\"97ecacd4727857a7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/effect.js\":\"abff2aa741577eff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/index.js\":\"4333661fb5ab089f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/keyCapture.js\":\"58788fcac49f8f1a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/overrideStore.js\":\"67c76324262695cf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5de2c6191be1ed4f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/HeaderItem.js\":\"a8a187c959dd840f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/LeftSidebar.js\":\"7c72e412c456faa8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/actions.js\":\"a8b4b88eec72440a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/facet.js\":\"8d1ab77c5a779aa3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/index.js\":\"608040928362a5e7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/shortcuts.js\":\"0b78e9b9adc9ef71\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/left-sidebar/toggleStore.js\":\"9c24db39b4c352b4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/MergePicker.js\":\"4631e5c96703172c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/index.js\":\"86591cf4c633727c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/mergeAction.js\":\"03be25ef8a0a2192\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/merge-blocks/strategy.js\":\"6aec231e86118959\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/Button.js\":\"8f03db7ab721282f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"cfe5057e225f4bc0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/defaultItems.js\":\"78bc784f27383374\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/facet.js\":\"5e85bb36a13e957c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-bottom-nav/index.js\":\"a2060ad05cbb5b0e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"05b41b8b1102644b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4c8b84d03156e858\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b1c69c91bea39869\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c8e33fd64c163dc3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/mobile-keyboard-toolbar/index.js\":\"7ca3a2c636c873a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/MoveDestinationPicker.js\":\"352e4923e2cc954e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f1c69b0f25df083b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/contextMenuItem.js\":\"494ac70b78055fb7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/index.js\":\"d442f6eedf0e4718\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/moveAction.js\":\"026b98c1aa80c96c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/moveBlocks.js\":\"922173c5d32467ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/move-blocks/selectionAfterMove.js\":\"da4b761d3302b87b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/TutorialBanner.js\":\"488790f462295d88\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/action.js\":\"46aebe73d4f5bce4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/bannerDismissal.js\":\"b5c2f18233ea47fc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/documents/cheatSheet.js\":\"e4153ac14ebe1a81\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/index.js\":\"984b52cbbf084d3e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/keys.js\":\"aefa19470a67e3d9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/landing.js\":\"eca6fd91598f50c4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/outline.js\":\"920618b27eaad363\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/onboarding/seed.js\":\"72eb24a29327552f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ae5ed02e909f05dc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/analyze.js\":\"f86e668bc165e110\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/diagnosticsSource.js\":\"f90d87a4f65ab202\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/index.js\":\"36eb7fbd77ca9dca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/load.js\":\"fe741ec66c80b36a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/monitorRun.js\":\"1314bffff3612b99\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/schedule.js\":\"975b9bd886565fd2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/series.js\":\"73fd2e43c75f843f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/store.js\":\"fb0f1e2c480b086e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/trendAction.js\":\"66a0f2d1b38ebf0d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/perf-monitor/verdict.js\":\"329d48c945a8b48a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/clickToEditAction.js\":\"85ad156f6cc07aa4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/index.js\":\"ec187447af8cdb61\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/plain-outliner/interactions.js\":\"2c4c79b2181f93c1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ad7889c9568c521d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/MigrationGate.js\":\"f1ebaca49165a873\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/MigrationGateDialog.js\":\"8c9b34df6185cdce\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/action.js\":\"059ef196aee9419e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/index.js\":\"299723cd4ff68483\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/localRunMessage.js\":\"4a4a8c848bd20a99\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/plugin.js\":\"2ed6b68233655858\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/progressReport.js\":\"c5704fa8c81bb4ba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/properties-migration/sweepProgress.js\":\"1e97fa959b9757df\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/FieldRowRenderer.js\":\"20d7d72870a53de3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/ValueRowRenderer.js\":\"3e765a410d041ea2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/actions.js\":\"cce4e5a7566669d6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/autocomplete.js\":\"ea5ba887c71b127c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/fieldRow.js\":\"cbbfb7d5eb386e04\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/index.js\":\"bd47f0107ffcb15c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/referenceWarning.js\":\"73efe8b2db82b32a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/valueAutocomplete.js\":\"baa367f319d771a9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/property-rows/valueSchema.js\":\"475ec5ac77ec13f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/HeaderItem.js\":\"faf09eb1892f2ea5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/QuickFind.js\":\"a2596157d89b6d99\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/index.js\":\"dd780233d76ad13b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/recents.js\":\"972e21487cebd040\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/resultItems.js\":\"a05997807aa4434c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/selection.js\":\"b6742c110f75e84f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/quick-find/toggleStore.js\":\"c57e8232fae28575\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/HeaderItem.js\":\"a45ceed4135c6238\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/RecentsPageBlockRenderer.js\":\"35fd7e85b5f45d1b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/grouping.js\":\"a6906b55e89a7eef\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/index.js\":\"25de8857e978ae44\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/recents/target.js\":\"05a16219f718a684\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/codeMirrorExtensions.js\":\"0b9a7473f858ac93\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/contentPrefill.js\":\"625edca717760626\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/dataExtension.js\":\"3db742d37e2e575c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/index.js\":\"799c4935b2a51d2e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a19e7e724370bde4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/invalidation.js\":\"b341da0e65ad71e3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/localSchema.js\":\"29533d5712145e8c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/blockrefs/index.js\":\"50a795eff4f32b04\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"19364c3e13c995f6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/index.js\":\"71795ffaaefeb4a3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/referenceNode.js\":\"b65f6ddf95d7d172\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/remark-reference-occurrences.js\":\"39ade90d225b565b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7901800259934ab4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/index.js\":\"2ddaf3df80a71e74\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8531369f185bc3e9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1368ae4287170cce\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/mergeRetargetProcessor.js\":\"2554e82a81f2bb1e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/parseFence.js\":\"a50667b2c0520036\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referenceParser.js\":\"eb033f3e861d4933\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referenceProjection.js\":\"48669b5a9d130d62\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/referencesProcessor.js\":\"df8dfb7bd46ccfc1\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/renameProcessor.js\":\"d65e26a6bc2b9d4a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/references/spanReplacement.js\":\"a02ef38544d3b636\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/htmlToOutline.js\":\"3a90b33667c4219b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/index.js\":\"8a67924722977af2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/normalizeClipboardDom.js\":\"68394f72a26d86ba\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/rich-paste/pasteDecision.js\":\"c16dda790775d365\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/action.js\":\"947cfef95a3bd883\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/blockIds.js\":\"ddcc410435d8a68e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/content.js\":\"d56827dd2974b33c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/effect.js\":\"59effa859b885119\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/ids.js\":\"24b708f33c6ab5ca\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/import.js\":\"5d7ea83056b615b3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/index.js\":\"8838b8ee7f0623ea\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/plan.js\":\"7dbd551796716f43\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/plugin.js\":\"c02fa43e1c26c1b8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/promotion.js\":\"5dc722dafd6f8238\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/properties.js\":\"c8a2b311fd91c1ec\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/references.js\":\"e1f1135272c5421b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/report.js\":\"74fc923eee6b1c17\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/roamMemo.js\":\"c163d519efae85cc\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/runtime.js\":\"b0dd0af0d6983647\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/schemaReconciliation.js\":\"9da2cbc8aede86a0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/srsMarkers.js\":\"20f6bc4ba88d8e7b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/todo.js\":\"86e8cc47178b5470\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/typeCandidates.js\":\"15ab20a34ffe680e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/roam-import/types.js\":\"b773d186ea0f0bbf\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/search-health/index.js\":\"6b625bfa6754da5b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/search-health/store.js\":\"a3faebe325287b53\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/HeaderItem.js\":\"e47eb1772d0e627d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0706b394e94d5767\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/index.js\":\"8e451dfde6018a1f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/model.js\":\"52399acefe821093\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/toggleStore.js\":\"f249669c1b038063\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/shortcut-help/useKeyInspector.js\":\"29c84701f36d5f54\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1df769404096e4fd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/ShellDecorator.js\":\"0a6be7727c4e390c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/actions.js\":\"c4df407b944c98d8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8bd1d59b423137c8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/index.js\":\"78e8ffb3cba7ad76\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/shell.js\":\"5834eb4b20a50cd2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/surface.js\":\"89649b6e466fd175\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/spatial-navigation/walker.js\":\"4e59bb32fb6b1227\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ee620c369b82bd01\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/dataExtension.js\":\"927551ff8664dddb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/index.js\":\"d7a7c030f140b763\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/indicator.js\":\"3ec2e1d1049f6d46\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/moveSrsState.js\":\"fa0304e1d95c0729\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"03dc4d347eca74d0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/scheduler.js\":\"d19218f08b28ac9b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/schema.js\":\"541933dc7623f105\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"dafcf41bed3693b8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/srsClipboard.js\":\"956a8a73a3632291\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f735f5b8d320d99c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7e00fb9cb65c7748\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/DeckPicker.js\":\"19443b06afbe8223\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewControls.js\":\"2e5ecf150da18058\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e3946b9e40d43944\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/ReviewSession.js\":\"0d0fb8aacabc0ca7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/actions.js\":\"a14961ed2bb99616\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/archive.js\":\"0635d8844dbbab21\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/dataExtension.js\":\"c6229721361d2de2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/deck.js\":\"dbd3024a1b157843\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/dueQuery.js\":\"bda8c218952077c9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/gradeDecision.js\":\"39136b0aaed544fb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/index.js\":\"8264031ee3c18b14\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/keyHints.js\":\"c9be3fc67271e59f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/reviewCardLayout.js\":\"68cb8014cc54239f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/reviewProgress.js\":\"ab3322182cd15678\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/schema.js\":\"6a480f95cad97277\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/srs-review/useDueCards.js\":\"08bbb8f34441463b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/startup-metrics/index.js\":\"2b15dd3aeea2c0c9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/startup-metrics/record.js\":\"9c4db6a680ce7735\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/index.js\":\"1df22c21cdd5b70e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/persistenceStatus.js\":\"d47d6b6335cd0109\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/storage-persistence/requestAction.js\":\"a92d046ab220f54d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/TypeChipsDecorator.js\":\"9bf9219ae00ce0f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/codeMirrorExtensions.js\":\"70c67d8c885c2ec3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/index.js\":\"2a93d8cd21f5cd2d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/supertags/typeAutocomplete.js\":\"0d40d9be6ad58eb8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a00df24b1f4c5f52\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/actions.js\":\"636016d5653d6dc0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/anchor.js\":\"79ce75d68b5a48dd\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/events.js\":\"cb92db503c96983b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/gestureActions.js\":\"61bfb229643c47e2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/index.js\":\"155c4b5bdcdae9af\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0823424c65356c4c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/collect.js\":\"328c55a856ab8b56\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/index.js\":\"699ff89c261f0de3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/sync-metrics/record.js\":\"ea8e10b0bbbc9d55\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/RejectionDialog.js\":\"d5356bdc5fed7a18\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/SystemStatusHeaderItem.js\":\"50f0dbadd0b7b894\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/index.js\":\"372a29e530fede57\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/model.js\":\"47f96c078d74dca9\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/queueCounts.js\":\"f1e9092461951a59\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/rejectedHelpers.js\":\"ce3668cb11e3889a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/rematerializeAction.js\":\"c2efb659dccb260c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/system-status/useHysteresis.js\":\"b0c1c4a7756a954a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/ColumnHeaders.js\":\"2d64e78ca720e3b5\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/QueryUi.js\":\"f00fa6e1ebc3667e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/TableLayout.js\":\"b9d88490f6b5107e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/actions.js\":\"c7f766397bd5d317\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/cellEdits.js\":\"9929a8eeb80a95f7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/childrenViews.js\":\"5007bd5dd2de2746\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/columns.js\":\"9670a9c51abd6ed8\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/controller.js\":\"2f63a073ff8199c4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/convert.js\":\"d44c822a110901ff\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/dataExtension.js\":\"2d7167af19bdeb90\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/index.js\":\"867c90f6418e0287\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/keys.js\":\"48628c9e240aabf2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/model.js\":\"60f282298f91b8e6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/backfill.js\":\"8d08aacfa45900ad\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/completion.js\":\"d8b7aeb43fde7b24\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/format.js\":\"51dea19837d595eb\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/parse.js\":\"e7c5bfb519311b3a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/queryValue.js\":\"d7516f3807775d76\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/query/source.js\":\"9ee92fc1e2240122\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/registry.js\":\"9989bc733fc894e6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/rowGutter.js\":\"95498166332a1ac4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/rowVerbs.js\":\"47e6b5e3a6d3db5b\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/schema.js\":\"71982c60f171fdd6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/tables/sort.js\":\"c682195d0f0be928\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/effect.js\":\"8ebe95a144a28855\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/index.js\":\"56bc40153c777b97\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/theme-toggle/theme.js\":\"c2316b000069b279\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/actions.js\":\"63248d877b383671\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/dataExtension.js\":\"93aa18f420504960\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/index.js\":\"7da2b02c698bfb7f\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/todo/schema.js\":\"4e86ad2d4c8c8446\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f910cb17dcced0b7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/actions.js\":\"cf51dc1ba07cc66c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/defaultItems.js\":\"fb8ca972848e1c63\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/facet.js\":\"0067cdcd8e8f3ad0\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/holdRecognizer.js\":\"3854983dd496a5b7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/touch-selection/index.js\":\"d06b7032c89a6a36\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/UpdateIndicator.js\":\"d78ab7e05c0dcb3e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/index.js\":\"7a1e070c7e539d5c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/update-indicator/loadTimes.js\":\"3fbc18d976b58c8e\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoNotesRenderer.js\":\"cd48fbe1b31b21a6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoPlayerRenderer.js\":\"417579dcd7e3ffa6\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/VideoTimeStamp.js\":\"35cc9e4401f3698c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/actions.js\":\"5ca94005711fc41c\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/index.js\":\"8a09bbfcaf5d3ab2\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/markdown.js\":\"74bf15ef0bbd2f53\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/notes.js\":\"31f815c2935ee2e4\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/registry.js\":\"0fd5883fbdb3adf3\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/remark-timestamps.js\":\"c16167e2fd37b156\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/video-player/view.js\":\"41ff2f12a6319de7\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/LinkHints.js\":\"657ced1ddfa0eb47\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/index.js\":\"75ab202c1c5ebb2d\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/model.js\":\"dca4666116a60951\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-link-hints/settings.js\":\"c41f983e11e0261a\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/actions.js\":\"87a7b6116b660710\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/index.js\":\"cf8bbd748b9bc176\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/vim-normal-mode/interactions.js\":\"f6b94871d82af608\",\"/knowledge-medium/pr-preview/pr-1872/src/plugins/workspace-header/index.js\":\"825dbcebcf92595a\",\"/knowledge-medium/pr-preview/pr-1872/src/registerServiceWorker.js\":\"6ad7804050d8ede7\",\"/knowledge-medium/pr-preview/pr-1872/src/requestPersistentStorage.js\":\"9fa4e5069cc8f75f\",\"/knowledge-medium/pr-preview/pr-1872/src/services/authRequestDeadline.js\":\"ca8e9685f13f8c40\",\"/knowledge-medium/pr-preview/pr-1872/src/services/authStorage.js\":\"c4dbe428f7414751\",\"/knowledge-medium/pr-preview/pr-1872/src/services/powersync.js\":\"c65faf6355255b0d\",\"/knowledge-medium/pr-preview/pr-1872/src/services/supabase.js\":\"c06c594641697178\",\"/knowledge-medium/pr-preview/pr-1872/src/services/uploadErrorClassifier.js\":\"bfaff9882f350f10\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/ActiveContexts.js\":\"b1afa74d740e46cd\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/HotkeyReconciler.js\":\"e634ef346a84ddb0\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/WipeLocalDataDialog.js\":\"4cb1bc8222bb592f\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/actionDispatch.js\":\"15d4fc99b858dae7\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/actionRefItems.js\":\"e5a7af0d53dc4397\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/applyKeybindingOverrides.js\":\"dd219da23f6bffc5\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/blockActions.js\":\"8cebb4fbbf721d8b\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/blockMergeGesture.js\":\"165ae4c46dff4c38\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/canonicalizeChord.js\":\"6bbc4d32ec1ebadc\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/defaultContexts.js\":\"e42401e00a41af45\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/defaultShortcuts.js\":\"5ba57b581be6b189\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/effectiveActions.js\":\"ee6639ed1137f734\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/gestureAction.js\":\"64aa0d442c831a04\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/gestureBinding.js\":\"25334032b6b01713\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/holdRegistry.js\":\"a314abd01c394a6a\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/keybindingConflicts.js\":\"126994d6b0c47e09\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/keybindingOverrides.js\":\"60eb087eabf40d2b\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/pointerAction.js\":\"2aada9b41d8fd76c\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/resolve.js\":\"a12aebbad9b06b3e\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/runAction.js\":\"89fef72b51c86e05\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/sequenceMatcher.js\":\"9d6a2af6c6a92cac\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/types.js\":\"580e0b77518e20f9\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/useActionContext.js\":\"56e9783e9d2c0b70\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/useActionDiscovery.js\":\"9a376bab3f0f91c2\",\"/knowledge-medium/pr-preview/pr-1872/src/shortcuts/utils.js\":\"9504c8d2c7d8c690\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/bootStore.js\":\"32ac709918286673\",\"/knowledge-medium/pr-preview/pr-1872/src/sw/previewDatabases.js\":\"89fae383ff19de1b\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/byteTransform.js\":\"0515fb66850bc439\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/attachmentCleaner.js\":\"e50057450dbec405\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/attachmentParts.js\":\"5b8c99aa1c609b13\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/bundleParts.js\":\"babaed03ed4ff124\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/bundleRecord.js\":\"181f26172288ab30\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/manifest.js\":\"55538cfffc98fa53\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/takeBundle.js\":\"d7e6de699224176d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/bundle/verifyBundle.js\":\"63e5fbbb65596183\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/cleaningStage.js\":\"f69f1153c7675458\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionKey.js\":\"31ef8d83610cb3d5\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/conversionServer.js\":\"d61e06c4b74ef36a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/flip.js\":\"1f31042abac44e76\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/flipAttempts.js\":\"e001e4f8092f3ffa\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/pages.js\":\"188ecd573bf7fc8a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/preflight.js\":\"ea7c24845a6810ad\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/reseal.js\":\"6ac4ac7355ec8db8\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/runConversion.js\":\"1b53adc37abcad9a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/runLock.js\":\"500065e4cf7daba5\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/sealing.js\":\"1ad746ff5182f6fe\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/sealingStage.js\":\"4845801330736615\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/stage.js\":\"2a216883fcfbd633\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/conversion/verifyReseal.js\":\"c409674aaaa09b9d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/aad.js\":\"13cd0d00690b0221\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/aead.js\":\"d16d3b1ada922cd9\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/base32.js\":\"bff551bd7b589792\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/base64url.js\":\"f1a8f2134104a80e\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/binaryEnvelope.js\":\"765dd93a1bf0d066\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/byteAead.js\":\"8e4b17eacc8c913d\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/canary.js\":\"04202941fc22b672\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/contentHash.js\":\"bc96c11c41471250\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/contentKey.js\":\"c003695c5556f0a7\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/derivedIdNamespace.js\":\"53faff3c45a76d71\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/envelope.js\":\"11c8fbe184ebad87\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/hex.js\":\"eb954d23e5f008d1\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/sha256Hex.js\":\"c5fd46f0d7a78fad\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/crypto/workspaceKey.js\":\"1511f046a0b0029a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/conversionState.js\":\"44439b59653270e4\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4bcfc64e605bbfb7\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/pastedKey.js\":\"c57e2765f0ac3623\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c8285dc8761a2e5c\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2a954ab37de56bd9\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/keyStore.js\":\"a12e9564c1f45c4a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/mintWorkspaceKey.js\":\"131b1a067df08a64\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/modePin.js\":\"a395c0606cee25fd\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/openWorkspaceKeys.js\":\"4d2b4a0dc341f1e5\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/resolveWorkspaceEntry.js\":\"5426ac1f945f7dc7\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/resolver.js\":\"806ee2cd01d98dcd\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/keys/workspaceAccess.js\":\"a2cc9eb5f93e8d7a\",\"/knowledge-medium/pr-preview/pr-1872/src/sync/transform.js\":\"e9c08db500d6b6ef\",\"/knowledge-medium/pr-preview/pr-1872/src/themeBootDefaults.js\":\"8fab282603171155\",\"/knowledge-medium/pr-preview/pr-1872/src/types.js\":\"12c5eaff0e3d9eb3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/ClientLocalSettings.js\":\"4727394bcb78157c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/abortableSleep.js\":\"48c09e207036ddd1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/array.js\":\"60a0dfccab8c742e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/backlinkAutocomplete.js\":\"f6de3b80744726e9\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/blockCrumbs.js\":\"0b91857a2d29b3f0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/blockrefAutocomplete.js\":\"9e06ced130b63b57\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/cadencedIdleJob.js\":\"66c7786bafca7bb8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/callbackSet.js\":\"d04d074fd6316161\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/clientId.js\":\"37c5994f43299c0e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/codemirror.js\":\"5fa7ee0278ff5daf\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/codemirrorCompletion.js\":\"0f48b7914999c7e2\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/copy.js\":\"70e9eff27185623a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dailyPage.js\":\"067ac832f57c1353\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dbForensics.js\":\"2842c533c67e9ce3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dbForensicsHooks.js\":\"6c44c4fff9006a00\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/deleteBlockThroughUi.js\":\"9999aba730469fb5\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dialogs.js\":\"cf42c9b8fb5878cc\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/dom.js\":\"723026a1c39536ea\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/downloadBlob.js\":\"4329e3fcfa5967b0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/drawnWalk.js\":\"f6ef694e0ebf9145\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/exportSqliteDb.js\":\"fbfd7c18b6eac32f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fileSystemAccess.js\":\"d04b73a31311a905\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/flipSlide.js\":\"6473a452c78eb3d3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fnv1a.js\":\"6a9e4051ea246e9f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/formatBytes.js\":\"5bb6237c2ee194f0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/fuzzyRank.js\":\"e84cdf9dcfcce744\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/idbKeyedStore.js\":\"f7f5d712681a6120\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/idleCallbackPolyfill.js\":\"eea48f1bfe4cc7f8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/keyboardAwareScroll.js\":\"a564cd56579c1ce8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/keyboardViewport.js\":\"2240a637cd4834bc\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/lastWorkspace.js\":\"d30700b84d177d0a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutColumns.js\":\"a849e01c229edceb\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutSessionDom.js\":\"9d095f2b19b276ae\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/layoutSessionId.js\":\"887629177ef0584a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/linkClickGestures.js\":\"21ffeeb100a82b4f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/linkTargetAutocomplete.js\":\"459ae850c159d731\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/localDbCorruption.js\":\"2a8b2b88223c996c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/localDbRecovery.js\":\"78ae6fade9eae237\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/markdownParser.js\":\"2f1bd35dd33a39a1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/memoize.js\":\"9c30094b84943f74\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/nameFieldCommit.js\":\"7a4ff881a58b0707\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/nameList.js\":\"b360284c96496e1c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/navigation.js\":\"eb4d14408834ae51\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/omnilinerNamespace.js\":\"5a32020d229b7a4a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/opfsPageScan.js\":\"6bad93c7fc7e17e6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelClearance.js\":\"1ea44c4955d0e48c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelHistory.js\":\"72e7c1f5acd4fc1d\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelLanes.js\":\"24124aea6ba89984\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelLayoutProjection.js\":\"10aab9556aff9098\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelScrollAnchor.js\":\"22a2c2d46bb0c82a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/panelUrlFlags.js\":\"5e3ae8122be3f333\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/platform.js\":\"f0ff7d49cd120bc0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/pluralize.js\":\"cb83f4a83e323cd0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyCreation.js\":\"7fbc96f9c24ad3f8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyNavigation.js\":\"a8c6c4c50b4d27b0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/propertyValueContext.js\":\"fc25afc7528317a7\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/react.js\":\"9632e809d29d7f02\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/relativeDate.js\":\"cd2dd4fd59f23489\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/relativeTime.js\":\"e8f3db0a71afb2d9\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/renderScope.js\":\"312b02ea26a9ae30\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/resolvedThenable.js\":\"190fb2980f2dbad1\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/routing.js\":\"4b505e5601f38d87\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/safeMode.js\":\"033c8652077b94d3\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/scheduleIdle.js\":\"35ead18b04c49090\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/screenWakeLock.js\":\"ac5b855bc4694aed\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/selection.js\":\"d2e09fcff6073ea7\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/softKeyboardGrab.js\":\"6914399011cb4fc0\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/startupTimeline.js\":\"b6c331ed7e155ae8\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/state.js\":\"c0ee0d84e31108f5\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/string.js\":\"91e06cd176464fc5\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/surfaceZoom.js\":\"0f55e29e18f9201a\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/time.js\":\"81ef2462a738604f\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/toast.js\":\"0191431c9ffd8538\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/toggleStore.js\":\"ad1d713088e4258e\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/untilStopped.js\":\"cf38fe06b43afd6c\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/userActivity.js\":\"517c1833e08df601\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/viewTransition.js\":\"a8f6507a578b9724\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/viewport.js\":\"e448a2f001bccb5b\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/webLock.js\":\"d72da3408cafdd8b\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/workspaceRecovery.js\":\"454cbac391d514cf\",\"/knowledge-medium/pr-preview/pr-1872/src/utils/workspaceSnapshotStore.js\":\"cc5b38a7ac9636ec\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-compiler-runtime.js\":\"25b79eac4dd02dea\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-client.js\":\"43c0df35e570a49e\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-server-edge.js\":\"8daf163dc9afaa59\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-server.js\":\"d2e0f0772e1d232b\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-static-edge.js\":\"2c4fd3930de0c4f5\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-static.js\":\"a861836bc45f9960\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom-test-utils.js\":\"1d138ef821cbe88f\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-dom.js\":\"f5a5db7160c5104d\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react-jsx-runtime.js\":\"712879543ed90dea\",\"/knowledge-medium/pr-preview/pr-1872/src/vendor/react.js\":\"d0543c182567701f\",\"/knowledge-medium/pr-preview/pr-1872/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1872/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1872/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
